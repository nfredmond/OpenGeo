#!/usr/bin/env node

import { pathToFileURL } from "node:url";

export const requiredVercelEnvKeys = Object.freeze([
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_DB_URL",
  "OPENGEO_EXTRACTOR",
  "FEATURE_AI_NL_SQL",
  "FEATURE_AI_STYLE_GEN",
  "FEATURE_AI_FEATURE_EXTRACTION",
  "FEATURE_DRONE_PIPELINE",
  "FEATURE_DURABLE_PIPELINE",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "R2_PUBLIC_BASE_URL",
  "PMTILES_GENERATOR_URL",
  "PMTILES_GENERATOR_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
]);

export const defaultVercelEnvTargets = Object.freeze(["production", "preview"]);

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

export function parseInventoryArgs(argv) {
  const parsed = {
    targets: [...defaultVercelEnvTargets],
    json: true,
    help: false,
  };

  for (const arg of argv) {
    if (arg === "--") continue;
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }

    const targetMatch = arg.match(/^--targets?=(.*)$/);
    if (targetMatch) {
      parsed.targets = parseInventoryTargets(targetMatch[1]);
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

export function parseInventoryTargets(value) {
  const targets = value
    .split(",")
    .map((target) => target.trim())
    .filter(Boolean);
  const uniqueTargets = [...new Set(targets)];

  if (uniqueTargets.length === 0) {
    throw new Error("At least one --target must be provided.");
  }

  for (const target of uniqueTargets) {
    if (!defaultVercelEnvTargets.includes(target)) {
      throw new Error(`Invalid --target=${target}. Use production, preview, or production,preview.`);
    }
  }

  return uniqueTargets;
}

export function createVercelEnvInventoryReport({
  envs,
  targets = defaultVercelEnvTargets,
  requiredKeys = requiredVercelEnvKeys,
}) {
  const missing = findMissingVercelEnvKeys(envs, targets, requiredKeys);

  return {
    ok: missing.length === 0,
    targets: [...targets],
    requiredKeyCount: requiredKeys.length,
    missing,
  };
}

export function findMissingVercelEnvKeys(
  envs,
  targets = defaultVercelEnvTargets,
  requiredKeys = requiredVercelEnvKeys,
) {
  const missing = [];

  for (const target of targets) {
    for (const key of requiredKeys) {
      if (!hasGlobalVercelEnvKey(envs, target, key)) {
        missing.push(`${target}:${key}`);
      }
    }
  }

  return missing;
}

export function hasGlobalVercelEnvKey(envs, target, key) {
  return envs.some((env) => {
    const targets = Array.isArray(env.target) ? env.target : [env.target];
    return env.key === key && targets.includes(target) && !env.gitBranch;
  });
}

export function getVercelInventoryConfig(env = process.env) {
  const token = env.VERCEL_TOKEN;
  const projectId = env.VERCEL_PROJECT_ID;
  const orgId = env.VERCEL_ORG_ID ?? env.VERCEL_TEAM_ID;
  const missing = [];

  if (!token) missing.push("VERCEL_TOKEN");
  if (!projectId) missing.push("VERCEL_PROJECT_ID");
  if (!orgId) missing.push("VERCEL_ORG_ID");

  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);
  }

  return { token, projectId, orgId };
}

export async function fetchVercelEnvMetadata({
  token,
  projectId,
  orgId,
  fetchImpl = globalThis.fetch,
}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("This script requires a Node runtime with fetch support.");
  }

  const url = new URL(
    `https://api.vercel.com/v10/projects/${encodeURIComponent(projectId)}/env`,
  );
  url.searchParams.set("teamId", orgId);

  const response = await fetchImpl(url, {
    headers: {
      authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Vercel env API failed: HTTP ${response.status}`);
  }

  const body = await response.json();
  return Array.isArray(body.envs) ? body.envs : [];
}

async function main() {
  const args = parseInventoryArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const config = getVercelInventoryConfig();
  const envs = await fetchVercelEnvMetadata(config);
  const report = createVercelEnvInventoryReport({
    envs,
    targets: args.targets,
  });

  console.log(JSON.stringify(report, null, 2));

  if (!report.ok) {
    process.exit(1);
  }
}

function printHelp() {
  console.log(`Usage: pnpm vercel:env:inventory [--target=production|preview|production,preview] [--json]

Checks that required OpenGeo Vercel environment variable keys exist for the
selected global targets. The script reads VERCEL_TOKEN, VERCEL_ORG_ID, and
VERCEL_PROJECT_ID from the environment and never prints secret values.
`);
}
