#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const CACHE_DIR = join(homedir(), ".cache", "opengeo", "pmtiles");
const GENERATOR_CONTAINER = "opengeo-pmtiles-generator-local";
const TUNNEL_CONTAINER = "opengeo-pmtiles-tunnel";
const GENERATOR_IMAGE =
  process.env.PMTILES_GENERATOR_IMAGE ??
  "ghcr.io/nfredmond/opengeo-pmtiles-generator:sha-b61ee31";
const CLOUDFLARED_IMAGE =
  process.env.CLOUDFLARED_IMAGE ?? "cloudflare/cloudflared:latest";
const LOCAL_PORT = process.env.PMTILES_LOCAL_PORT ?? "8110";
const LOCAL_GENERATOR_URL = `http://127.0.0.1:${LOCAL_PORT}`;
const ENV_FILE = join(CACHE_DIR, "generator.env");
const TUNNEL_URL_FILE = join(CACHE_DIR, "tunnel-url.txt");

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const parsed = parseBridgeArgs(process.argv.slice(2));

  if (parsed.options.has("--help") || parsed.command === "help") {
    printHelp();
    process.exit(0);
  }

  if (!["start", "status", "stop", "repair"].includes(parsed.command)) {
    console.error(`Unknown command: ${parsed.command}`);
    printHelp();
    process.exit(1);
  }

  try {
    await main(parsed);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

export function parseBridgeArgs(args) {
  return {
    command: args.find((arg) => !arg.startsWith("--")) ?? "start",
    options: new Set(args.filter((arg) => arg.startsWith("--"))),
  };
}

async function main({ command, options }) {
  mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
  await requireDocker();

  if (command === "stop") {
    await stopBridge();
    return;
  }

  if (command === "start" || command === "repair") {
    writeGeneratorEnv();
    await ensureGenerator();
    await waitForHealth(`${LOCAL_GENERATOR_URL}/health`);
    await ensureTunnel();
    await ensurePublicTunnelHealthy({
      forceRecreate: options.has("--force-recreate"),
    });
  }

  const tunnelUrl = await currentTunnelUrl();
  const generatorUrl = tunnelUrl ? `${tunnelUrl}/generate` : null;
  if (tunnelUrl) {
    writeFileSync(TUNNEL_URL_FILE, `${tunnelUrl}\n`, { mode: 0o600 });
  }

  const generator = await containerState(GENERATOR_CONTAINER);
  const tunnel = await containerState(TUNNEL_CONTAINER);
  const localHealth = generator.running
    ? await checkHealth(`${LOCAL_GENERATOR_URL}/health`)
    : unhealthy(`${LOCAL_GENERATOR_URL}/health`, "container is not running");
  const publicHealth = tunnel.running && tunnelUrl
    ? await checkHealth(`${tunnelUrl}/health`)
    : unhealthy(tunnelUrl ? `${tunnelUrl}/health` : null, "tunnel URL is unavailable");
  console.log(
    JSON.stringify(
      {
        ok: Boolean(generator.running && tunnel.running && tunnelUrl && localHealth.ok && publicHealth.ok),
        generator: {
          container: GENERATOR_CONTAINER,
          running: generator.running,
          localUrl: `${LOCAL_GENERATOR_URL}/generate`,
          health: localHealth,
          image: GENERATOR_IMAGE,
        },
        tunnel: {
          container: TUNNEL_CONTAINER,
          running: tunnel.running,
          url: tunnelUrl,
          generatorUrl,
          health: publicHealth,
          urlFile: TUNNEL_URL_FILE,
        },
      },
      null,
      2,
    ),
  );

  if ((command === "start" || command === "repair") && generatorUrl && options.has("--update-vercel")) {
    await updateVercelEnv(generatorUrl);
  }
}

async function requireDocker() {
  const result = await run("docker", ["info"], { quiet: true, allowFailure: true });
  if (result.code !== 0) {
    throw new Error("Docker is not running or is not available to this user.");
  }
}

function writeGeneratorEnv() {
  const env = parseDotEnv(resolve(process.cwd(), ".env.local"));
  const token = env.PMTILES_GENERATOR_TOKEN ?? "";
  const lines = [
    `PORT=${LOCAL_PORT}`,
    "TIPPECANOE_BIN=tippecanoe",
    token ? `PMTILES_GENERATOR_TOKEN=${token}` : "",
  ].filter(Boolean);
  writeFileSync(ENV_FILE, `${lines.join("\n")}\n`, { mode: 0o600 });
}

async function ensureGenerator() {
  if (await containerExists(GENERATOR_CONTAINER)) {
    await run("docker", ["start", GENERATOR_CONTAINER], { quiet: true });
    return;
  }

  await run("docker", [
    "run",
    "-d",
    "--name",
    GENERATOR_CONTAINER,
    "--restart",
    "unless-stopped",
    "-p",
    `127.0.0.1:${LOCAL_PORT}:${LOCAL_PORT}`,
    "--env-file",
    ENV_FILE,
    GENERATOR_IMAGE,
  ]);
}

async function ensureTunnel() {
  if (await containerExists(TUNNEL_CONTAINER)) {
    await run("docker", ["start", TUNNEL_CONTAINER], { quiet: true });
    await waitForTunnelUrl();
    return;
  }

  await run("docker", [
    "run",
    "-d",
    "--name",
    TUNNEL_CONTAINER,
    "--restart",
    "unless-stopped",
    "--network",
    "host",
    CLOUDFLARED_IMAGE,
    "tunnel",
    "--url",
    `${LOCAL_GENERATOR_URL}`,
    "--protocol",
    "http2",
    "--no-autoupdate",
  ]);
  await waitForTunnelUrl();
}

async function ensurePublicTunnelHealthy({ forceRecreate = false } = {}) {
  let tunnelUrl = await waitForTunnelUrl();
  if (!forceRecreate && await waitForHealthyUrl(`${tunnelUrl}/health`, 15_000)) {
    return;
  }

  await recreateTunnel(forceRecreate ? "forced by --force-recreate" : "public tunnel health check failed");
  tunnelUrl = await waitForTunnelUrl();
  if (await waitForHealthyUrl(`${tunnelUrl}/health`, 60_000)) {
    return;
  }

  const health = await checkHealth(`${tunnelUrl}/health`);
  throw new Error(
    `Cloudflare quick tunnel is not publicly healthy at ${tunnelUrl}/health: ${health.error ?? `HTTP ${health.status}`}`,
  );
}

async function recreateTunnel(reason) {
  if (await containerExists(TUNNEL_CONTAINER)) {
    await run("docker", ["rm", "-f", TUNNEL_CONTAINER], { quiet: true, allowFailure: true });
  }
  await run("docker", [
    "run",
    "-d",
    "--name",
    TUNNEL_CONTAINER,
    "--restart",
    "unless-stopped",
    "--network",
    "host",
    CLOUDFLARED_IMAGE,
    "tunnel",
    "--url",
    `${LOCAL_GENERATOR_URL}`,
    "--protocol",
    "http2",
    "--no-autoupdate",
  ], { quiet: true });
  await waitForTunnelUrl();
  if (process.env.OPENGEO_BRIDGE_DEBUG === "1") {
    console.error(`Recreated ${TUNNEL_CONTAINER}: ${reason}`);
  }
}

async function stopBridge() {
  for (const name of [TUNNEL_CONTAINER, GENERATOR_CONTAINER]) {
    if (await containerExists(name)) {
      await run("docker", ["stop", name], { quiet: true, allowFailure: true });
    }
  }
  console.log(JSON.stringify({ ok: true, stopped: [TUNNEL_CONTAINER, GENERATOR_CONTAINER] }, null, 2));
}

async function waitForHealth(url) {
  const deadline = Date.now() + 30_000;
  let lastError = "";
  while (Date.now() < deadline) {
    const health = await checkHealth(url);
    if (health.ok) return;
    lastError = health.error ?? `HTTP ${health.status}`;
    await sleep(500);
  }
  throw new Error(`PMTiles generator did not become healthy at ${url}: ${lastError}`);
}

async function waitForHealthyUrl(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await checkHealth(url);
    if (health.ok) return true;
    await sleep(1000);
  }
  return false;
}

async function checkHealth(url) {
  if (!url) return unhealthy(null, "health URL is unavailable");
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const res = await fetch(url, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      return {
        ok: res.ok,
        url,
        status: res.status,
        error: res.ok ? null : `HTTP ${res.status}`,
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    return unhealthy(url, error instanceof Error ? error.message : String(error));
  }
}

function unhealthy(url, error) {
  return { ok: false, url, status: null, error };
}

async function waitForTunnelUrl() {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const url = await currentTunnelUrl();
    if (url) return url;
    await sleep(1000);
  }
  throw new Error(`Cloudflare quick tunnel did not emit a trycloudflare.com URL.`);
}

async function currentTunnelUrl() {
  if (!(await containerExists(TUNNEL_CONTAINER))) return null;
  const logs = await run("docker", ["logs", TUNNEL_CONTAINER], {
    quiet: true,
    allowFailure: true,
  });
  const matches = [...logs.output.matchAll(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g)];
  return matches.at(-1)?.[0] ?? null;
}

async function updateVercelEnv(generatorUrl) {
  if (await updateVercelEnvViaApi(generatorUrl)) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          updated: "PMTILES_GENERATOR_URL",
          targets: ["preview", "production"],
          value: generatorUrl,
          method: "vercel-api",
          next: "Run `vercel deploy --prod -y` for production to pick up the new env value.",
        },
        null,
        2,
      ),
    );
    return;
  }

  for (const target of ["preview", "production"]) {
    await run("vercel", ["env", "rm", "PMTILES_GENERATOR_URL", target, "--yes"], {
      allowFailure: true,
      quiet: true,
    });
    await run("vercel", [
      "env",
      "add",
      "PMTILES_GENERATOR_URL",
      target,
      "--value",
      generatorUrl,
      "--yes",
      "--force",
    ], {
      quiet: true,
    });
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        updated: "PMTILES_GENERATOR_URL",
        targets: ["preview", "production"],
        value: generatorUrl,
        next: "Run `vercel deploy --prod -y` for production to pick up the new env value.",
      },
      null,
      2,
    ),
  );
}

async function updateVercelEnvViaApi(generatorUrl) {
  const token = process.env.VERCEL_TOKEN;
  const project = readVercelProject();
  if (!token || !project) return false;

  for (const target of ["preview", "production"]) {
    const res = await fetch(
      `https://api.vercel.com/v10/projects/${project.projectId}/env?upsert=true&teamId=${project.orgId}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          type: "encrypted",
          key: "PMTILES_GENERATOR_URL",
          value: generatorUrl,
          target: [target],
        }),
      },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(
        `Vercel API env update failed for ${target}: HTTP ${res.status} ${body.error?.message ?? body.message ?? ""}`.trim(),
      );
    }
  }
  return true;
}

function readVercelProject() {
  const path = resolve(process.cwd(), ".vercel", "project.json");
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed.projectId === "string" && typeof parsed.orgId === "string") {
      return { projectId: parsed.projectId, orgId: parsed.orgId };
    }
  } catch {
    return null;
  }
  return null;
}

async function containerExists(name) {
  const result = await run("docker", ["container", "inspect", name], {
    quiet: true,
    allowFailure: true,
  });
  return result.code === 0;
}

async function containerState(name) {
  const result = await run(
    "docker",
    ["inspect", "-f", "{{.State.Running}}", name],
    { quiet: true, allowFailure: true },
  );
  return { running: result.output.trim() === "true" };
}

function parseDotEnv(path) {
  if (!existsSync(path)) return {};
  const values = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function run(cmd, cmdArgs, { input, quiet = false, allowFailure = false } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(cmd, cmdArgs, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (!quiet) process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
      if (!quiet) process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { code: code ?? 0, output };
      if (result.code !== 0 && !allowFailure) {
        reject(new Error(`${cmd} ${cmdArgs.join(" ")} failed with exit code ${result.code}`));
      } else {
        resolveRun(result);
      }
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function printHelp() {
  console.log(`Usage:
  node scripts/pmtiles-local-bridge.mjs start [--update-vercel]
  node scripts/pmtiles-local-bridge.mjs repair [--update-vercel] [--force-recreate]
  node scripts/pmtiles-local-bridge.mjs status
  node scripts/pmtiles-local-bridge.mjs stop

Environment:
  PMTILES_GENERATOR_IMAGE  Defaults to ${GENERATOR_IMAGE}
  CLOUDFLARED_IMAGE        Defaults to ${CLOUDFLARED_IMAGE}
  PMTILES_LOCAL_PORT       Defaults to ${LOCAL_PORT}

Notes:
  start creates Docker containers with restart=unless-stopped.
  start verifies the public quick tunnel /health and recreates stale tunnels.
  repair runs the same verification path; --force-recreate always replaces the tunnel.
  --update-vercel replaces PMTILES_GENERATOR_URL in Preview and Production.
`);
}
