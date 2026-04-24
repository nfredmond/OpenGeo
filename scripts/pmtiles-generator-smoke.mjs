#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const token = process.env.PMTILES_GENERATOR_TOKEN || "";
const candidates = generatorCandidates();

const fixture = {
  featureCollection: {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [-121.1, 39.2] },
        properties: { name: "OpenGeo smoke fixture" },
      },
    ],
  },
  name: "OpenGeo PMTiles smoke",
  sourceLayer: "layer",
  minzoom: 0,
  maxzoom: 4,
};

try {
  const failures = [];
  for (const candidate of candidates) {
    try {
      const archive = await runSmoke(candidate);
      console.log(`PMTiles generator smoke passed: ${archive.byteLength} bytes from ${candidate.generatorUrl}`);
      process.exit(0);
    } catch (error) {
      failures.push(`${candidate.generatorUrl}: ${errorMessage(error)}`);
    }
  }
  throw new Error(failures.join("; "));
} catch (error) {
  console.error(`PMTiles generator smoke failed: ${errorMessage(error)}`);
  process.exit(1);
}

async function runSmoke(candidate) {
  await checkHealth(candidate.healthUrl);
  const archive = await generateArchive(candidate.generatorUrl);
  const magic = new TextDecoder().decode(archive.slice(0, 7));
  if (magic !== "PMTiles") {
    throw new Error(`Unexpected PMTiles magic header: ${JSON.stringify(magic)}.`);
  }
  if (archive.byteLength < 128) {
    throw new Error(`PMTiles archive is unexpectedly small: ${archive.byteLength} bytes.`);
  }
  return archive;
}

async function checkHealth(healthUrl) {
  const res = await fetch(healthUrl, { headers: authHeaders() });
  if (!res.ok) {
    throw new Error(`Health check failed: ${res.status} ${await res.text()}`);
  }
  const body = await res.json().catch(() => null);
  if (!body || body.ok !== true) {
    throw new Error(`Health check returned unexpected body: ${JSON.stringify(body)}.`);
  }
}

async function generateArchive(generatorUrl) {
  const res = await fetch(generatorUrl, {
    method: "POST",
    headers: {
      accept: "application/vnd.pmtiles",
      "content-type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(fixture),
  });
  if (!res.ok) {
    throw new Error(`Generate failed: ${res.status} ${await res.text()}`);
  }
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("application/vnd.pmtiles")) {
    throw new Error(`Unexpected content-type: ${contentType || "(missing)"}.`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

function authHeaders() {
  return token ? { authorization: `Bearer ${token}` } : {};
}

function generatorCandidates() {
  const urls = [
    process.env.PMTILES_GENERATOR_URL,
    bridgeGeneratorUrl(),
    "http://localhost:8110/generate",
  ].filter(Boolean);
  const unique = [...new Set(urls)];
  return unique.map((generatorUrl, index) => ({
    generatorUrl,
    healthUrl:
      index === 0 && process.env.PMTILES_GENERATOR_HEALTH_URL
        ? process.env.PMTILES_GENERATOR_HEALTH_URL
        : defaultHealthUrl(generatorUrl),
  }));
}

function bridgeGeneratorUrl() {
  const path = join(homedir(), ".cache", "opengeo", "pmtiles", "tunnel-url.txt");
  if (!existsSync(path)) return null;
  const baseUrl = readFileSync(path, "utf8").trim();
  if (!baseUrl) return null;
  try {
    const url = new URL(baseUrl);
    url.pathname = "/generate";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function defaultHealthUrl(rawGenerateUrl) {
  const url = new URL(rawGenerateUrl);
  url.pathname = url.pathname.replace(/\/generate\/?$/, "/health");
  if (!url.pathname.endsWith("/health")) url.pathname = "/health";
  url.search = "";
  return url.toString();
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
