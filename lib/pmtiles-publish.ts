import "server-only";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@/lib/env";
import { putR2Object } from "@/lib/r2";

export class TippecanoeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TippecanoeError";
  }
}

export class PmtilesGeneratorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PmtilesGeneratorError";
  }
}

export async function publishGeoJsonAsPmtiles({
  featureCollection,
  layerId,
  name,
  sourceLayer,
  minzoom,
  maxzoom,
}: {
  featureCollection: GeoJSON.FeatureCollection;
  layerId: string;
  name: string;
  sourceLayer: string;
  minzoom: number;
  maxzoom: number;
}): Promise<{ url: string; key: string; bytes: number }> {
  const archive = await generatePmtilesArchive({
    featureCollection,
    name,
    sourceLayer,
    minzoom,
    maxzoom,
  });
  const key = `pmtiles/${layerId}/${Date.now()}-${slugify(name)}.pmtiles`;
  const uploaded = await putR2Object({
    key,
    body: archive,
    contentType: "application/vnd.pmtiles",
  });
  return { ...uploaded, bytes: archive.byteLength };
}

export async function generatePmtilesArchive({
  featureCollection,
  name,
  sourceLayer,
  minzoom,
  maxzoom,
}: {
  featureCollection: GeoJSON.FeatureCollection;
  name: string;
  sourceLayer: string;
  minzoom: number;
  maxzoom: number;
}): Promise<Uint8Array> {
  if (env().PMTILES_GENERATOR_URL) {
    return generateRemotePmtilesArchive({
      featureCollection,
      name,
      sourceLayer,
      minzoom,
      maxzoom,
    });
  }

  const dir = await mkdtemp(join(tmpdir(), "opengeo-pmtiles-"));
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

async function generateRemotePmtilesArchive({
  featureCollection,
  name,
  sourceLayer,
  minzoom,
  maxzoom,
}: {
  featureCollection: GeoJSON.FeatureCollection;
  name: string;
  sourceLayer: string;
  minzoom: number;
  maxzoom: number;
}): Promise<Uint8Array> {
  const cfg = env();
  const headers: Record<string, string> = {
    accept: "application/vnd.pmtiles",
    "content-type": "application/json",
  };
  if (cfg.PMTILES_GENERATOR_TOKEN) {
    headers.authorization = `Bearer ${cfg.PMTILES_GENERATOR_TOKEN}`;
  }

  const res = await fetch(cfg.PMTILES_GENERATOR_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      featureCollection,
      name,
      sourceLayer,
      minzoom,
      maxzoom,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new PmtilesGeneratorError(
      `PMTiles generator failed: ${res.status} ${detail}`.trim(),
    );
  }

  const archive = new Uint8Array(await res.arrayBuffer());
  if (archive.byteLength === 0) {
    throw new PmtilesGeneratorError("PMTiles generator returned an empty archive.");
  }
  return archive;
}

function runTippecanoe(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(env().TIPPECANOE_BIN, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout?.on("data", (chunk) => {
      stdout = truncate(`${stdout}${chunk.toString()}`);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = truncate(`${stderr}${chunk.toString()}`);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(new TippecanoeError(`Tippecanoe failed to start: ${error.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve();
        return;
      }
      const detail = stderr || stdout || `exit code ${code}`;
      reject(new TippecanoeError(`Tippecanoe failed: ${detail}`));
    });
  });
}

function truncate(value: string): string {
  return value.length > 4000 ? value.slice(value.length - 4000) : value;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "layer";
}
