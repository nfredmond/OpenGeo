#!/usr/bin/env node

const generatorUrl = process.env.PMTILES_GENERATOR_URL || "http://localhost:8110/generate";
const healthUrl = process.env.PMTILES_GENERATOR_HEALTH_URL || defaultHealthUrl(generatorUrl);
const token = process.env.PMTILES_GENERATOR_TOKEN || "";

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
  await checkHealth();
  const archive = await generateArchive();
  const magic = new TextDecoder().decode(archive.slice(0, 7));
  if (magic !== "PMTiles") {
    throw new Error(`Unexpected PMTiles magic header: ${JSON.stringify(magic)}.`);
  }
  if (archive.byteLength < 128) {
    throw new Error(`PMTiles archive is unexpectedly small: ${archive.byteLength} bytes.`);
  }
  console.log(`PMTiles generator smoke passed: ${archive.byteLength} bytes from ${generatorUrl}`);
} catch (error) {
  console.error(`PMTiles generator smoke failed: ${errorMessage(error)}`);
  process.exit(1);
}

async function checkHealth() {
  const res = await fetch(healthUrl, { headers: authHeaders() });
  if (!res.ok) {
    throw new Error(`Health check failed: ${res.status} ${await res.text()}`);
  }
  const body = await res.json().catch(() => null);
  if (!body || body.ok !== true) {
    throw new Error(`Health check returned unexpected body: ${JSON.stringify(body)}.`);
  }
}

async function generateArchive() {
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
