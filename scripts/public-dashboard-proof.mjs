#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const DEFAULT_BASE_URL = "https://opengeo.vercel.app";
const DEFAULT_TIMEOUT_MS = 10_000;
const HANDOFF_CONTRACT = "opengeo.public-pmtiles-dashboard.v1";

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
      pmtilesProof: args.pmtilesProofFile ? readPmtilesProofFile(args.pmtilesProofFile) : undefined,
    });

    if (args.json) {
      console.log(JSON.stringify(proof, null, 2));
    } else {
      console.log(
        `OpenGeo public dashboard proof passed: host=${proof.publicHost} status=${proof.httpStatus} dashboard=${proof.hasDashboard} layer=${proof.layerKind} widgets=${proof.widgetCount}`,
      );
      if (proof.pmtilesProof) {
        console.log(
          `pmtiles_handoff=${proof.handoff.contract} range=${proof.pmtilesProof.status} magic=${proof.pmtilesProof.magic} fingerprint=${proof.pmtilesProof.urlFingerprint}`,
        );
      }
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
    pmtilesProofFile: env.OPENGEO_PMTILES_PROOF_FILE || "",
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
    if (arg === "--pmtiles-proof-file") {
      parsed.pmtilesProofFile = requireValue(argv[++i], "--pmtiles-proof-file");
      continue;
    }
    if (arg.startsWith("--pmtiles-proof-file=")) {
      parsed.pmtilesProofFile = arg.slice("--pmtiles-proof-file=".length);
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

  const pmtilesProof = options.pmtilesProof
    ? matchPmtilesProofToDashboard(dashboard, normalizePmtilesProof(options.pmtilesProof))
    : null;
  const checklist = buildHandoffChecklist({
    httpStatus: response.status,
    layerKind,
    widgetCount: Array.isArray(dashboard.widgets) ? dashboard.widgets.length : 0,
    pmtilesProof,
  });

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
    pmtilesProof,
    handoff: {
      contract: HANDOFF_CONTRACT,
      checks: checklist,
    },
    // Fingerprint lets operators correlate repeated checks without logging the
    // public capability token itself.
    tokenFingerprint: createHash("sha256").update(token).digest("hex").slice(0, 12),
  };
}

export function readPmtilesProofFile(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`Could not read PMTiles proof file: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("PMTiles proof file must contain JSON from `pnpm --silent pmtiles:proof -- --json`.");
  }
}

export function normalizePmtilesProof(rawProof) {
  if (!rawProof || typeof rawProof !== "object") {
    throw new Error("PMTiles proof must be an object.");
  }

  const proof = rawProof;
  if (proof.ok !== true) {
    throw new Error("PMTiles proof must have ok=true.");
  }
  if (proof.status !== 206) {
    throw new Error(`PMTiles proof must have status=206; got ${JSON.stringify(proof.status)}.`);
  }
  if (proof.magic !== "PMTiles") {
    throw new Error(`PMTiles proof must have magic=PMTiles; got ${JSON.stringify(proof.magic)}.`);
  }
  if (typeof proof.publicHost !== "string" || proof.publicHost.trim() === "") {
    throw new Error("PMTiles proof must include publicHost.");
  }
  if (typeof proof.urlFingerprint !== "string" || !/^[a-f0-9]{12}$/.test(proof.urlFingerprint)) {
    throw new Error("PMTiles proof must include a 12-character urlFingerprint.");
  }

  return {
    publicHost: proof.publicHost,
    status: proof.status,
    magic: proof.magic,
    urlFingerprint: proof.urlFingerprint,
    generatedAt: typeof proof.generatedAt === "string" ? proof.generatedAt : null,
  };
}

function matchPmtilesProofToDashboard(dashboard, pmtilesProof) {
  const candidates = dashboardPmtilesUrlCandidates(dashboard);
  if (candidates.length === 0) {
    throw new Error("Dashboard PMTiles layer did not include a URL to match against the PMTiles proof.");
  }

  const match = candidates.find((candidate) => candidate.urlFingerprint === pmtilesProof.urlFingerprint);
  if (!match) {
    throw new Error(
      `PMTiles proof fingerprint ${pmtilesProof.urlFingerprint} did not match any PMTiles URL exposed by the dashboard API.`,
    );
  }

  if (match.publicHost !== pmtilesProof.publicHost) {
    throw new Error(
      `PMTiles proof host ${pmtilesProof.publicHost} did not match the dashboard PMTiles host ${match.publicHost}.`,
    );
  }

  return {
    ...pmtilesProof,
    matchedDashboardLayerId: match.layerId,
    matchedDashboardLayerName: match.layerName,
  };
}

function dashboardPmtilesUrlCandidates(dashboard) {
  const candidates = [];
  pushDashboardPmtilesUrl(candidates, dashboard?.layer, dashboard?.layerId, dashboard?.layerName);

  for (const widget of Array.isArray(dashboard?.widgets) ? dashboard.widgets : []) {
    if (widget?.type === "pmtiles_map") {
      pushDashboardPmtilesUrl(candidates, widget.layer, widget.layerId, widget.layerName);
    }
  }

  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = `${candidate.layerId}:${candidate.urlFingerprint}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function pushDashboardPmtilesUrl(candidates, layer, fallbackLayerId, fallbackLayerName) {
  const rawUrl = layer?.pmtiles?.url;
  if (typeof rawUrl !== "string" || rawUrl.trim() === "") return;
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Dashboard PMTiles URL was invalid.");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Dashboard PMTiles URL must use http or https.");
  }
  if (url.username || url.password) {
    throw new Error("Dashboard PMTiles URL must not contain embedded credentials.");
  }
  candidates.push({
    layerId: typeof layer?.id === "string" ? layer.id : fallbackLayerId ?? null,
    layerName: typeof layer?.name === "string" ? layer.name : fallbackLayerName ?? null,
    publicHost: url.host,
    urlFingerprint: createHash("sha256").update(url.toString()).digest("hex").slice(0, 12),
  });
}

function buildHandoffChecklist({ httpStatus, layerKind, widgetCount, pmtilesProof }) {
  const checks = [
    {
      id: "dashboard-api-ok",
      ok: true,
      evidence: `http=${httpStatus}`,
    },
    {
      id: "dashboard-layer-pmtiles",
      ok: true,
      evidence: `layer=${layerKind}`,
    },
    {
      id: "dashboard-widgets-present",
      ok: true,
      evidence: `widgets=${widgetCount}`,
    },
  ];

  if (pmtilesProof) {
    checks.unshift(
      {
        id: "pmtiles-range-206",
        ok: true,
        evidence: `range=${pmtilesProof.status}`,
      },
      {
        id: "pmtiles-magic-header",
        ok: true,
        evidence: `magic=${pmtilesProof.magic}`,
      },
    );
    checks.push({
      id: "dashboard-pmtiles-fingerprint-match",
      ok: true,
      evidence: `urlFingerprint=${pmtilesProof.urlFingerprint}`,
    });
  }

  return checks;
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

Pass --pmtiles-proof-file with JSON from pmtiles:proof to bind the dashboard to
the exact public archive that already proved HTTP 206 byte-range access. The
dashboard script compares fingerprints internally and still never prints the
full PMTiles URL or share token.

Prefer OPENGEO_SHARE_TOKEN over --token so package managers and shell history do
not echo a capability token before this script can redact it.

Options:
  --base-url <url>     OpenGeo app host (default: ${DEFAULT_BASE_URL})
  --token <token>      Public share token (prefer OPENGEO_SHARE_TOKEN)
  --pmtiles-proof-file <path>
                       Redacted JSON output from pmtiles:proof
  --json               Print JSON evidence
  --timeout-ms <n>     Request timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})
`);
}
