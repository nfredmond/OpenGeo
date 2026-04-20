import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = Number(process.env.PORT || "8110");
const token = process.env.PMTILES_GENERATOR_TOKEN || "";
const tippecanoeBin = process.env.TIPPECANOE_BIN || "tippecanoe";
const maxBodyBytes = Number(process.env.PMTILES_GENERATOR_MAX_BODY_BYTES || String(100 * 1024 * 1024));

createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      sendJson(res, 200, { ok: true, service: "opengeo-pmtiles-generator" });
      return;
    }
    if (req.method !== "POST" || req.url !== "/generate") {
      sendJson(res, 404, { ok: false, error: "Not found." });
      return;
    }
    if (token && req.headers.authorization !== `Bearer ${token}`) {
      sendJson(res, 401, { ok: false, error: "Not authenticated." });
      return;
    }

    const body = await readJson(req);
    const parsed = parseRequest(body);
    const archive = await generateArchive(parsed);
    res.writeHead(200, {
      "content-type": "application/vnd.pmtiles",
      "content-length": String(archive.byteLength),
      "cache-control": "no-store",
    });
    res.end(archive);
  } catch (error) {
    const status = error instanceof ClientError ? error.status : 500;
    sendJson(res, status, {
      ok: false,
      error: error instanceof Error ? error.message : "PMTiles generation failed.",
    });
  }
}).listen(port, "0.0.0.0", () => {
  console.log(`opengeo-pmtiles-generator listening on :${port}`);
});

async function readJson(req) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.byteLength;
    if (bytes > maxBodyBytes) {
      throw new ClientError(413, `Payload too large (>${maxBodyBytes} bytes).`);
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ClientError(400, "Invalid JSON body.");
  }
}

function parseRequest(value) {
  if (!value || typeof value !== "object") {
    throw new ClientError(400, "Invalid request body.");
  }
  const { featureCollection, name, sourceLayer, minzoom = 0, maxzoom = 14 } = value;
  if (
    !featureCollection ||
    featureCollection.type !== "FeatureCollection" ||
    !Array.isArray(featureCollection.features)
  ) {
    throw new ClientError(400, "featureCollection must be a GeoJSON FeatureCollection.");
  }
  if (featureCollection.features.length === 0) {
    throw new ClientError(400, "featureCollection has no features.");
  }
  if (typeof name !== "string" || name.trim().length === 0 || name.length > 120) {
    throw new ClientError(400, "name is required and must be <=120 characters.");
  }
  if (
    typeof sourceLayer !== "string" ||
    !/^[A-Za-z0-9_-]{1,80}$/.test(sourceLayer)
  ) {
    throw new ClientError(400, "sourceLayer may contain only letters, numbers, underscores, and hyphens.");
  }
  if (!Number.isInteger(minzoom) || !Number.isInteger(maxzoom) || minzoom < 0 || maxzoom > 24 || minzoom > maxzoom) {
    throw new ClientError(400, "Invalid minzoom/maxzoom.");
  }
  return { featureCollection, name: name.trim(), sourceLayer, minzoom, maxzoom };
}

async function generateArchive({ featureCollection, name, sourceLayer, minzoom, maxzoom }) {
  const dir = await mkdtemp(join(tmpdir(), "opengeo-pmtiles-generator-"));
  const inputPath = join(dir, "input.geojson");
  const outputPath = join(dir, "output.pmtiles");
  try {
    await writeFile(inputPath, JSON.stringify(featureCollection));
    await runTippecanoe([
      "-o",
      outputPath,
      "-l",
      sourceLayer,
      "-n",
      name,
      "-f",
      "-Z",
      String(minzoom),
      "-z",
      String(maxzoom),
      "--drop-densest-as-needed",
      "--extend-zooms-if-still-dropping",
      inputPath,
    ]);
    return await readFile(outputPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runTippecanoe(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(tippecanoeBin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output = truncate(`${output}${chunk.toString()}`);
    });
    child.stderr.on("data", (chunk) => {
      output = truncate(`${output}${chunk.toString()}`);
    });
    child.on("error", (error) => reject(new Error(`Tippecanoe failed to start: ${error.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Tippecanoe failed: ${output || `exit code ${code}`}`));
    });
  });
}

function truncate(value) {
  return value.length > 4000 ? value.slice(value.length - 4000) : value;
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(payload)),
    "cache-control": "no-store",
  });
  res.end(payload);
}

class ClientError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
