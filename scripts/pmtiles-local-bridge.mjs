#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

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

const args = process.argv.slice(2);
const command = args.find((arg) => !arg.startsWith("--")) ?? "start";
const options = new Set(args.filter((arg) => arg.startsWith("--")));

if (options.has("--help") || command === "help") {
  printHelp();
  process.exit(0);
}

if (!["start", "status", "stop"].includes(command)) {
  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(1);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

async function main() {
  mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
  await requireDocker();

  if (command === "stop") {
    await stopBridge();
    return;
  }

  if (command === "start") {
    writeGeneratorEnv();
    await ensureGenerator();
    await waitForHealth(`${LOCAL_GENERATOR_URL}/health`);
    await ensureTunnel();
  }

  const tunnelUrl = await currentTunnelUrl();
  const generatorUrl = tunnelUrl ? `${tunnelUrl}/generate` : null;
  if (tunnelUrl) {
    writeFileSync(TUNNEL_URL_FILE, `${tunnelUrl}\n`, { mode: 0o600 });
  }

  const generator = await containerState(GENERATOR_CONTAINER);
  const tunnel = await containerState(TUNNEL_CONTAINER);
  console.log(
    JSON.stringify(
      {
        ok: Boolean(generator.running && tunnel.running && tunnelUrl),
        generator: {
          container: GENERATOR_CONTAINER,
          running: generator.running,
          localUrl: `${LOCAL_GENERATOR_URL}/generate`,
          image: GENERATOR_IMAGE,
        },
        tunnel: {
          container: TUNNEL_CONTAINER,
          running: tunnel.running,
          url: tunnelUrl,
          generatorUrl,
          urlFile: TUNNEL_URL_FILE,
        },
      },
      null,
      2,
    ),
  );

  if (command === "start" && generatorUrl && options.has("--update-vercel")) {
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
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(500);
  }
  throw new Error(`PMTiles generator did not become healthy at ${url}: ${lastError}`);
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
  for (const target of ["preview", "production"]) {
    await run("vercel", ["env", "rm", "PMTILES_GENERATOR_URL", target, "--yes"], {
      allowFailure: true,
      quiet: true,
    });
    await run("vercel", ["env", "add", "PMTILES_GENERATOR_URL", target], {
      input: `${generatorUrl}\n`,
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
  node scripts/pmtiles-local-bridge.mjs status
  node scripts/pmtiles-local-bridge.mjs stop

Environment:
  PMTILES_GENERATOR_IMAGE  Defaults to ${GENERATOR_IMAGE}
  CLOUDFLARED_IMAGE        Defaults to ${CLOUDFLARED_IMAGE}
  PMTILES_LOCAL_PORT       Defaults to ${LOCAL_PORT}

Notes:
  start creates Docker containers with restart=unless-stopped.
  --update-vercel replaces PMTILES_GENERATOR_URL in Preview and Production.
`);
}
