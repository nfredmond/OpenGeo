/**
 * `geo` - OpenGeo's developer CLI.
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
 *   doctor           Check environment readiness by target/scope
 *   deploy           Build + deploy to Vercel (calls `vercel deploy --prod`)
 *   layers list      List layers from the configured API
 *   query "<prompt>" Run an NL→SQL query against the local/API endpoint
 *   style push       Push the bundled MapLibre style.json to the map service
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatEnvDoctorReport,
  normalizeEnvDoctorScopes,
  runEnvDoctor,
  type EnvDoctorScope,
  type EnvDoctorTarget,
} from "../../lib/env-doctor";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..", "..");

export type GeoCliDeps = {
  env: NodeJS.ProcessEnv;
  stdout: (message: string) => void;
  stderr: (message: string) => void;
  fetch: typeof fetch;
  runCommand: (bin: string, args: string[]) => Promise<number>;
};

type Runner = (args: string[], deps: GeoCliDeps) => Promise<number>;

const commands: Record<string, Runner> = {
  init: cmdInit,
  dev: cmdDev,
  doctor: cmdDoctor,
  deploy: cmdDeploy,
  layers: cmdLayers,
  query: cmdQuery,
  style: cmdStyle,
  help: cmdHelp,
  "--help": cmdHelp,
  "-h": cmdHelp,
};

const targets = new Set<EnvDoctorTarget>(["local", "preview", "production"]);
const doctorScopes = new Set<EnvDoctorScope>(["core", "pmtiles", "ai", "drone", "all"]);

export async function runGeo(
  argv: string[],
  deps: Partial<GeoCliDeps> = {},
): Promise<number> {
  const resolvedDeps = defaultDeps(deps);
  const [cmd = "help", ...rest] = argv;
  const run = commands[cmd];
  if (!run) {
    resolvedDeps.stderr(`geo: unknown command "${cmd}"\n`);
    await cmdHelp([], resolvedDeps);
    return 2;
  }
  return run(rest, resolvedDeps);
}

async function main(): Promise<void> {
  loadDotenvLocal(process.env);
  const code = await runGeo(process.argv.slice(2));
  process.exit(code);
}

async function cmdHelp(_args: string[], deps: GeoCliDeps): Promise<number> {
  const help = `
geo - OpenGeo CLI

Usage:
  pnpm geo <command> [args]

Commands:
  init              Print bootstrap instructions for a fresh clone
  dev               Start Docker stack + Next.js dev server
  doctor            Check env readiness by target/scope
  deploy [--prod]   Deploy to Vercel (default: preview)
  layers list       List layers from the API
  query "<prompt>"  Run an NL→SQL query against the API
  style push        Push bundled MapLibre style to map service
  help              Show this message
`;
  deps.stdout(help.trim());
  return 0;
}

async function cmdInit(_args: string[], deps: GeoCliDeps): Promise<number> {
  const steps = `
OpenGeo bootstrap

  1. Copy env template:
       cp .env.example .env.local
     Fill in SUPABASE_* and ANTHROPIC_API_KEY values.

  2. Start local infrastructure:
       docker compose up -d

  3. Run database migrations:
       pnpm db:migrate:local

  4. Check local env readiness:
       pnpm geo doctor --scope=core

  5. Start the dev server:
       pnpm dev

  6. (Optional) Link the Vercel project:
       vercel link
       vercel env pull .env.local
`;
  deps.stdout(steps.trim());
  return 0;
}

async function cmdDev(_args: string[], deps: GeoCliDeps): Promise<number> {
  deps.stdout("geo dev: starting docker compose (detached) + next dev");
  const up = await deps.runCommand("docker", ["compose", "up", "-d"]);
  if (up !== 0) return up;
  return deps.runCommand("pnpm", ["dev"]);
}

async function cmdDoctor(args: string[], deps: GeoCliDeps): Promise<number> {
  const parsed = parseDoctorArgs(args, deps);
  if (!parsed) return 2;
  if (parsed.help) {
    deps.stdout(doctorHelp());
    return 0;
  }

  const report = runEnvDoctor({
    env: deps.env,
    target: parsed.target,
    scopes: parsed.scopes,
  });
  deps.stdout(parsed.json ? JSON.stringify(report, null, 2) : formatEnvDoctorReport(report));
  return report.ok ? 0 : 1;
}

async function cmdDeploy(args: string[], deps: GeoCliDeps): Promise<number> {
  const prod = args.includes("--prod") || args.includes("production");
  const vercelArgs = prod ? ["deploy", "--prod"] : ["deploy"];
  deps.stdout(`geo deploy: vercel ${vercelArgs.join(" ")}`);
  return deps.runCommand("vercel", vercelArgs);
}

async function cmdLayers(args: string[], deps: GeoCliDeps): Promise<number> {
  const [sub] = args;
  if (sub !== "list") {
    deps.stderr(`geo layers: unknown subcommand "${sub ?? "<empty>"}". Try "geo layers list".`);
    return 2;
  }
  const base = apiBase(deps.env);
  const url = `${base}/api/layers`;
  const response = await deps.fetch(url).catch((e) => {
    deps.stderr(`geo layers: fetch failed (${(e as Error).message}).`);
    return null;
  });
  if (!response) return 1;
  if (!response.ok) {
    deps.stderr(`geo layers: ${response.status} ${response.statusText}`);
    return 1;
  }
  const body = await response.json();
  deps.stdout(JSON.stringify(body, null, 2));
  return 0;
}

async function cmdQuery(args: string[], deps: GeoCliDeps): Promise<number> {
  const prompt = args.join(" ").trim();
  if (!prompt) {
    deps.stderr('geo query: usage: geo query "your natural-language question"');
    return 2;
  }
  const base = apiBase(deps.env);
  const url = `${base}/api/ai/query`;
  const response = await deps
    .fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
    })
    .catch((e) => {
      deps.stderr(`geo query: fetch failed (${(e as Error).message}).`);
      return null;
    });
  if (!response) return 1;
  const body = await response.json().catch(() => ({ ok: false, error: "non-JSON response" }));
  deps.stdout(JSON.stringify(body, null, 2));
  return response.ok ? 0 : 1;
}

async function cmdStyle(args: string[], deps: GeoCliDeps): Promise<number> {
  const [sub] = args;
  if (sub !== "push") {
    deps.stderr('geo style: unknown subcommand. Try "geo style push".');
    return 2;
  }
  deps.stdout("geo style push: not yet implemented - style bundles land in Phase 2.");
  return 0;
}

function parseDoctorArgs(args: string[], deps: GeoCliDeps) {
  const parsed: {
    target: EnvDoctorTarget;
    scopes: EnvDoctorScope[];
    json: boolean;
    help: boolean;
  } = {
    target: "local",
    scopes: ["all"],
    json: false,
    help: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") continue;
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--target") {
      i += 1;
      if (!setDoctorTarget(args[i], parsed, deps)) return null;
      continue;
    }
    if (arg.startsWith("--target=")) {
      if (!setDoctorTarget(arg.slice("--target=".length), parsed, deps)) return null;
      continue;
    }
    if (arg === "--scope") {
      i += 1;
      if (!setDoctorScopes(args[i], parsed, deps)) return null;
      continue;
    }
    if (arg.startsWith("--scope=")) {
      if (!setDoctorScopes(arg.slice("--scope=".length), parsed, deps)) return null;
      continue;
    }
    deps.stderr(`geo doctor: unknown argument "${arg}".\n${doctorHelp()}`);
    return null;
  }

  parsed.scopes = normalizeEnvDoctorScopes(parsed.scopes);
  return parsed;
}

function setDoctorTarget(
  value: string | undefined,
  parsed: { target: EnvDoctorTarget },
  deps: GeoCliDeps,
): boolean {
  if (targets.has(value as EnvDoctorTarget)) {
    parsed.target = value as EnvDoctorTarget;
    return true;
  }
  deps.stderr(`geo doctor: invalid target "${value ?? "<empty>"}". Use local, preview, or production.`);
  return false;
}

function setDoctorScopes(
  value: string | undefined,
  parsed: { scopes: EnvDoctorScope[] },
  deps: GeoCliDeps,
): boolean {
  const requested = (value ?? "")
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
  if (requested.length === 0) {
    deps.stderr("geo doctor: --scope requires at least one value.");
    return false;
  }
  for (const scope of requested) {
    if (!doctorScopes.has(scope as EnvDoctorScope)) {
      deps.stderr(`geo doctor: invalid scope "${scope}". Use core, pmtiles, ai, drone, or all.`);
      return false;
    }
  }
  parsed.scopes = requested as EnvDoctorScope[];
  return true;
}

function doctorHelp(): string {
  return `
Usage:
  pnpm geo doctor [--target=local|preview|production] [--scope=all|core,pmtiles,ai,drone] [--json]

Examples:
  pnpm geo doctor --scope=core
  pnpm geo doctor --target=preview --scope=core,pmtiles
  pnpm geo doctor --target=production --scope=all --json
`.trim();
}

function apiBase(env: NodeJS.ProcessEnv): string {
  return env.OPENGEO_API_BASE || env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
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

function defaultDeps(overrides: Partial<GeoCliDeps>): GeoCliDeps {
  return {
    env: overrides.env ?? process.env,
    stdout: overrides.stdout ?? console.log,
    stderr: overrides.stderr ?? console.error,
    fetch: overrides.fetch ?? fetch,
    runCommand: overrides.runCommand ?? run,
  };
}

function loadDotenvLocal(env: NodeJS.ProcessEnv) {
  const path = resolve(REPO_ROOT, ".env.local");
  if (!existsSync(path)) return;
  const contents = readFileSync(path, "utf8");
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    if (env[key] !== undefined) continue;
    env[key] = unquoteEnvValue(match[2].trim());
  }
}

function unquoteEnvValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  const commentStart = value.search(/\s#/);
  return (commentStart >= 0 ? value.slice(0, commentStart) : value).trim();
}

if (resolve(process.argv[1] ?? "") === __filename) {
  main().catch((err) => {
    console.error("geo: unexpected error", err);
    process.exit(1);
  });
}

export const __geoCliTest = {
  unquoteEnvValue,
};
