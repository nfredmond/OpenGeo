#!/usr/bin/env node

import { createHash } from "node:crypto";

const DEFAULT_RANGE_BYTES = 16;
const DEFAULT_TIMEOUT_MS = 10_000;

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      printHelp();
      process.exit(0);
    }

    const proof = await provePublicPmtilesUrl(args.url, {
      rangeBytes: args.rangeBytes,
      timeoutMs: args.timeoutMs,
      fetchImpl: fetch,
    });

    if (args.json) {
      console.log(JSON.stringify(proof, null, 2));
    } else {
      console.log(
        `PMTiles public proof passed: public=${proof.publicHost} range=${proof.status} magic=${proof.magic} bytes=${proof.bytesRead}`,
      );
      if (proof.contentRange) console.log(`content-range=${proof.contentRange}`);
      if (proof.acceptRanges) console.log(`accept-ranges=${proof.acceptRanges}`);
      console.log(`url=${proof.redactedUrl}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`PMTiles public proof failed: ${message}`);
    process.exit(1);
  }
}

export function parseArgs(argv) {
  const parsed = {
    url: process.env.PMTILES_PROOF_URL || process.env.PUBLIC_PMTILES_URL || "",
    json: false,
    help: false,
    rangeBytes: DEFAULT_RANGE_BYTES,
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
    if (arg === "--url") {
      parsed.url = requireValue(argv[++i], "--url");
      continue;
    }
    if (arg.startsWith("--url=")) {
      parsed.url = arg.slice("--url=".length);
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
    if (arg === "--range-bytes") {
      parsed.rangeBytes = parsePositiveInt(requireValue(argv[++i], "--range-bytes"), "--range-bytes");
      continue;
    }
    if (arg.startsWith("--range-bytes=")) {
      parsed.rangeBytes = parsePositiveInt(arg.slice("--range-bytes=".length), "--range-bytes");
      continue;
    }
    if (!arg.startsWith("-") && !parsed.url) {
      parsed.url = arg;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!parsed.help && !parsed.url) {
    throw new Error("A public .pmtiles URL is required. Pass --url <url> or a positional URL.");
  }
  return parsed;
}

export async function provePublicPmtilesUrl(rawUrl, options = {}) {
  const url = parsePublicUrl(rawUrl);
  const rangeBytes = options.rangeBytes ?? DEFAULT_RANGE_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const redactedUrl = redactUrl(url);

  let response;
  try {
    response = await fetchImpl(url.toString(), {
      method: "GET",
      redirect: "follow",
      headers: {
        accept: "application/vnd.pmtiles,application/octet-stream,*/*",
        range: `bytes=0-${rangeBytes - 1}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`Request failed for ${redactedUrl}: ${safeErrorMessage(error, rawUrl, redactedUrl)}`);
  }

  if (![200, 206].includes(response.status)) {
    throw new Error(`Expected HTTP 200 or 206 from ${redactedUrl}; got ${response.status}.`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength < 7) {
    throw new Error(`Response from ${redactedUrl} was too short to contain a PMTiles magic header.`);
  }

  const header = bytes.slice(0, rangeBytes);
  const magic = new TextDecoder().decode(header.slice(0, 7));
  if (magic !== "PMTiles") {
    throw new Error(`Unexpected PMTiles magic header from ${redactedUrl}: ${JSON.stringify(magic)}.`);
  }

  return {
    ok: true,
    publicHost: url.host,
    redactedUrl,
    status: response.status,
    magic,
    bytesRead: header.byteLength,
    contentType: response.headers.get("content-type") || null,
    contentRange: response.headers.get("content-range") || null,
    acceptRanges: response.headers.get("accept-ranges") || null,
    proof: `public=${url.host} range=${response.status} magic=${magic}`,
    generatedAt: new Date().toISOString(),
    // Fingerprint lets operators correlate repeated checks without logging a
    // capability URL, signed query string, or share token.
    urlFingerprint: createHash("sha256").update(url.toString()).digest("hex").slice(0, 12),
  };
}

function parsePublicUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL.");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only http:// and https:// URLs are supported.");
  }
  if (url.username || url.password) {
    throw new Error("URLs with embedded credentials are not allowed.");
  }
  if (!url.pathname.toLowerCase().endsWith(".pmtiles")) {
    throw new Error("URL path must end with .pmtiles.");
  }
  return url;
}

function redactUrl(url) {
  const suffix = url.pathname.toLowerCase().endsWith(".pmtiles") ? "/[redacted].pmtiles" : "/[redacted]";
  return `${url.protocol}//${url.host}${suffix}`;
}

function safeErrorMessage(error, rawUrl, redactedUrl) {
  const message = error instanceof Error ? error.message : String(error);
  return message.split(rawUrl).join(redactedUrl);
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
  console.log(`Usage: PMTILES_PROOF_URL=https://<public-host>/<path>.pmtiles pnpm --silent pmtiles:proof -- --json

Secret-safe public PMTiles proof. The URL is used for the request but never
printed in full; output includes only host, range status, PMTiles magic, and a
short fingerprint for correlating repeated checks.

For capability URLs, prefer PMTILES_PROOF_URL or PUBLIC_PMTILES_URL over --url
when invoking through a package manager. Some package managers echo argv before
the script can redact it.

Options:
  --url <url>          Public .pmtiles URL to range-read (safe when running node directly)
  --json               Print JSON evidence
  --range-bytes <n>    Number of leading bytes to request (default: ${DEFAULT_RANGE_BYTES})
  --timeout-ms <n>     Request timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})
`);
}
