#!/usr/bin/env -S node --import tsx
/**
 * `geo` — OpenGeo's developer CLI.
 *
 * Zero-dependency on argv parsers: the CLI surface is small enough that a
 * hand-rolled dispatcher keeps install time and attack surface minimal.
 *
 * Invocation (from the repo root):
 *   pnpm geo <command> [...args]
 *
 * Commands:
 *   init             Print bootstrap instructions for a fresh clone
 *   dev              Start the local stack (Docker Compose + Next dev server)
 *   deploy           Build + deploy to Vercel (calls `vercel deploy --prod`)
 *   layers list      List layers from the configured API
 *   query "<prompt>" Run an NL→SQL query against the local/API endpoint
 *   style push       Push the bundled MapLibre style.json to the map service
 */
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..", "..");

type Runner = (args: string[]) => Promise<number>;

const commands: Record<string, Runner> = {
  init: cmdInit,
  dev: cmdDev,
  deploy: cmdDeploy,
  layers: cmdLayers,
  query: cmdQuery,
  style: cmdStyle,
  help: cmdHelp,
  "--help": cmdHelp,
  "-h": cmdHelp,
};

async function main(): Promise<void> {
  const [cmd = "help", ...rest] = process.argv.slice(2);
  const run = commands[cmd];
  if (!run) {
    console.error(`geo: unknown command "${cmd}"\n`);
    await cmdHelp([]);
    process.exit(2);
  }
  const code = await run(rest);
  process.exit(code);
}

async function cmdHelp(_args: string[]): Promise<number> {
  const help = `
geo — OpenGeo CLI

Usage:
  pnpm geo <command> [args]

Commands:
  init              Print bootstrap instructions for a fresh clone
  dev               Start Docker stack + Next.js dev server
  deploy [--prod]   Deploy to Vercel (default: preview)
  layers list       List layers from the API
  query "<prompt>"  Run an NL→SQL query against the API
  style push        Push bundled MapLibre style to map service
  help              Show this message
`;
  console.log(help.trim());
  return 0;
}

async function cmdInit(_args: string[]): Promise<number> {
  const steps = `
OpenGeo bootstrap

  1. Copy env template:
       cp .env.example .env.local
     Fill in SUPABASE_* and ANTHROPIC_API_KEY values.

  2. Start local infrastructure:
       docker compose up -d

  3. Run database migrations:
       pnpm db:migrate:local

  4. Start the dev server:
       pnpm dev

  5. (Optional) Link the Vercel project:
       vercel link
       vercel env pull .env.local
`;
  console.log(steps.trim());
  return 0;
}

async function cmdDev(_args: string[]): Promise<number> {
  console.log("geo dev: starting docker compose (detached) + next dev");
  const up = await run("docker", ["compose", "up", "-d"]);
  if (up !== 0) return up;
  return run("pnpm", ["dev"]);
}

async function cmdDeploy(args: string[]): Promise<number> {
  const prod = args.includes("--prod") || args.includes("production");
  const vercelArgs = prod ? ["deploy", "--prod"] : ["deploy"];
  console.log(`geo deploy: vercel ${vercelArgs.join(" ")}`);
  return run("vercel", vercelArgs);
}

async function cmdLayers(args: string[]): Promise<number> {
  const [sub] = args;
  if (sub !== "list") {
    console.error(`geo layers: unknown subcommand "${sub ?? "<empty>"}". Try "geo layers list".`);
    return 2;
  }
  const base = apiBase();
  const url = `${base}/api/layers`;
  const response = await fetch(url).catch((e) => {
    console.error(`geo layers: fetch failed (${(e as Error).message}).`);
    return null;
  });
  if (!response) return 1;
  if (!response.ok) {
    console.error(`geo layers: ${response.status} ${response.statusText}`);
    return 1;
  }
  const body = await response.json();
  console.log(JSON.stringify(body, null, 2));
  return 0;
}

async function cmdQuery(args: string[]): Promise<number> {
  const prompt = args.join(" ").trim();
  if (!prompt) {
    console.error('geo query: usage: geo query "your natural-language question"');
    return 2;
  }
  const base = apiBase();
  const url = `${base}/api/ai/query`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt }),
  }).catch((e) => {
    console.error(`geo query: fetch failed (${(e as Error).message}).`);
    return null;
  });
  if (!response) return 1;
  const body = await response.json().catch(() => ({ ok: false, error: "non-JSON response" }));
  console.log(JSON.stringify(body, null, 2));
  return response.ok ? 0 : 1;
}

async function cmdStyle(args: string[]): Promise<number> {
  const [sub] = args;
  if (sub !== "push") {
    console.error('geo style: unknown subcommand. Try "geo style push".');
    return 2;
  }
  console.log("geo style push: not yet implemented — style bundles land in Phase 2.");
  return 0;
}

function apiBase(): string {
  return process.env.OPENGEO_API_BASE || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
}

function run(bin: string, args: string[]): Promise<number> {
  return new Promise((resolvePromise) => {
    const child = spawn(bin, args, { cwd: REPO_ROOT, stdio: "inherit" });
    child.on("close", (code) => resolvePromise(code ?? 0));
    child.on("error", (err) => {
      console.error(`geo: failed to spawn ${bin}: ${err.message}`);
      resolvePromise(1);
    });
  });
}

main().catch((err) => {
  console.error("geo: unexpected error", err);
  process.exit(1);
});
