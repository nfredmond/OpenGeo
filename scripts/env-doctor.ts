#!/usr/bin/env tsx
import {
  formatEnvDoctorReport,
  normalizeEnvDoctorScopes,
  runEnvDoctor,
  type EnvDoctorScope,
  type EnvDoctorTarget,
} from "../lib/env-doctor";

const targets = new Set<EnvDoctorTarget>(["local", "preview", "production"]);
const scopes = new Set<EnvDoctorScope>(["core", "pmtiles", "ai", "drone", "all"]);

function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = parseTarget(args.target ?? "local");
  const selectedScopes = parseScopes(args.scope ?? "all");
  const report = runEnvDoctor({
    env: process.env,
    target,
    scopes: selectedScopes,
  });

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatEnvDoctorReport(report));
  }

  process.exit(report.ok ? 0 : 1);
}

function parseArgs(argv: string[]) {
  const parsed: Record<string, string | boolean> = {};
  for (const arg of argv) {
    if (arg === "--") continue;
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) {
      console.error(`Unknown argument: ${arg}`);
      printHelp();
      process.exit(2);
    }
    parsed[match[1]] = match[2];
  }
  return {
    target: typeof parsed.target === "string" ? parsed.target : undefined,
    scope: typeof parsed.scope === "string" ? parsed.scope : undefined,
    json: parsed.json === true,
  };
}

function parseTarget(value: string): EnvDoctorTarget {
  if (targets.has(value as EnvDoctorTarget)) return value as EnvDoctorTarget;
  console.error(`Invalid --target=${value}. Use local, preview, or production.`);
  process.exit(2);
}

function parseScopes(value: string): EnvDoctorScope[] {
  const requested = value
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
  for (const scope of requested) {
    if (!scopes.has(scope as EnvDoctorScope)) {
      console.error(`Invalid --scope=${scope}. Use core, pmtiles, ai, drone, or all.`);
      process.exit(2);
    }
  }
  return normalizeEnvDoctorScopes(requested as EnvDoctorScope[]);
}

function printHelp() {
  console.log(`Usage: pnpm env:doctor -- [--target=local|preview|production] [--scope=all|core,pmtiles,ai,drone] [--json]

Examples:
  pnpm env:doctor
  pnpm env:doctor -- --target=preview --scope=core,pmtiles
  pnpm env:doctor -- --target=production --scope=all --json
`);
}

main();
