#!/usr/bin/env node

import { createHash } from "node:crypto";

const DEFAULT_BASE_URL = "https://opengeo.vercel.app";
const DEFAULT_TIMEOUT_MS = 10_000;

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2), process.env);
    if (args.help) {
      printHelp();
      process.exit(0);
    }

    const proof = await provePublicDashboard(args.token, {
      baseUrl: args.baseUrl,
      timeoutMs: args.timeoutMs,
      fetchImpl: fetch,
    });

    if (args.json) {
      console.log(JSON.stringify(proof, null, 2));
    } else {
      console.log(
        `OpenGeo public dashboard proof passed: host=${proof.publicHost} status=${proof.httpStatus} dashboard=${proof.hasDashboard} layer=${proof.layerKind} widgets=${proof.widgetCount}`,
      );
      console.log(`share_page=${proof.sharePage}`);
      console.log(`token_fingerprint=${proof.tokenFingerprint}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`OpenGeo public dashboard proof failed: ${message}`);
    process.exit(1);
  }
}

export function parseArgs(argv, env = process.env) {
  const parsed = {
    token: env.OPENGEO_SHARE_TOKEN || "",
    baseUrl: env.OPENGEO_BASE_URL || DEFAULT_BASE_URL,
    json: false,
    help: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "--base-url") {
      parsed.baseUrl = requireValue(argv[++i], "--base-url");
      continue;
    }
    if (arg.startsWith("--base-url=")) {
      parsed.baseUrl = arg.slice("--base-url=".length);
      continue;
    }
    if (arg === "--token") {
      parsed.token = requireValue(argv[++i], "--token");
      continue;
    }
    if (arg.startsWith("--token=")) {
      parsed.token = arg.slice("--token=".length);
      continue;
    }
    if (arg === "--timeout-ms") {
      parsed.timeoutMs = parsePositiveInt(requireValue(argv[++i], "--timeout-ms"), "--timeout-ms");
      continue;
    }
    if (arg.startsWith("--timeout-ms=")) {
      parsed.timeoutMs = parsePositiveInt(arg.slice("--timeout-ms=".length), "--timeout-ms");
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!parsed.help && !parsed.token) {
    throw new Error("A public share token is required. Set OPENGEO_SHARE_TOKEN or pass --token <token>.");
  }

  parsed.baseUrl = normalizeBaseUrl(parsed.baseUrl).toString().replace(/\/$/, "");
  return parsed;
}

export async function provePublicDashboard(rawToken, options = {}) {
  const token = parseToken(rawToken);
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = new URL(`/api/share/${encodeURIComponent(token)}/dashboard`, baseUrl);

  let response;
  try {
    response = await fetchImpl(url.toString(), {
      method: "GET",
      redirect: "follow",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`Request failed for ${redactDashboardUrl(url)}: ${safeErrorMessage(error, token, url)}`);
  }

  let body;
  try {
    body = await response.json();
  } catch (_error) {
    throw new Error(`Expected JSON from ${redactDashboardUrl(url)}; got HTTP ${response.status}.`);
  }

  if (!response.ok || body?.ok !== true) {
    throw new Error(`Expected an ok dashboard response from ${redactDashboardUrl(url)}; got HTTP ${response.status}.`);
  }

  const dashboard = body.dashboard ?? null;
  const layerKind = dashboard?.layer?.kind ?? null;
  if (!dashboard) {
    throw new Error(`No published dashboard was returned for ${redactDashboardUrl(url)}.`);
  }
  if (layerKind !== "pmtiles") {
    throw new Error(`Expected a PMTiles dashboard layer from ${redactDashboardUrl(url)}; got ${JSON.stringify(layerKind)}.`);
  }

  return {
    ok: true,
    publicHost: baseUrl.host,
    httpStatus: response.status,
    hasDashboard: true,
    name: dashboard.name ?? null,
    layerKind,
    widgetCount: Array.isArray(dashboard.widgets) ? dashboard.widgets.length : 0,
    sharePage: `${baseUrl.origin}/p/[redacted]`,
    generatedAt: new Date().toISOString(),
    // Fingerprint lets operators correlate repeated checks without logging the
    // public capability token itself.
    tokenFingerprint: createHash("sha256").update(token).digest("hex").slice(0, 12),
  };
}

function normalizeBaseUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Invalid base URL.");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only http:// and https:// base URLs are supported.");
  }
  if (url.username || url.password) {
    throw new Error("Base URLs with embedded credentials are not allowed.");
  }
  return url;
}

function parseToken(rawToken) {
  const token = String(rawToken ?? "").trim();
  if (!token) throw new Error("A public share token is required.");
  return token;
}

function redactDashboardUrl(url) {
  return `${url.origin}/api/share/[redacted]/dashboard`;
}

function safeErrorMessage(error, token, url) {
  const encodedToken = encodeURIComponent(token);
  const message = error instanceof Error ? error.message : String(error);
  return message
    .split(token).join("[redacted]")
    .split(encodedToken).join("[redacted]")
    .split(url.toString()).join(redactDashboardUrl(url));
}

function requireValue(value, name) {
  if (!value) throw new Error(`${name} requires a value.`);
  return value;
}

function parsePositiveInt(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return number;
}

function printHelp() {
  console.log(`Usage: OPENGEO_SHARE_TOKEN=<share-token> pnpm --silent dashboard:proof -- --json

Secret-safe public dashboard proof. The token is used for the request but never
printed in full; output includes only host, HTTP status, dashboard/layer/widget
summary, /p/[redacted], and a short token fingerprint.

Prefer OPENGEO_SHARE_TOKEN over --token so package managers and shell history do
not echo a capability token before this script can redact it.

Options:
  --base-url <url>     OpenGeo app host (default: ${DEFAULT_BASE_URL})
  --token <token>      Public share token (prefer OPENGEO_SHARE_TOKEN)
  --json               Print JSON evidence
  --timeout-ms <n>     Request timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})
`);
}
