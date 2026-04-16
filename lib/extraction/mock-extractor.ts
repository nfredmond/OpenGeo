import type { Extractor, ExtractionInput, ExtractionResult } from "./types";

// Generates a plausible FeatureCollection of polygons inside a synthetic
// bbox so the end-to-end extraction flow (orthomosaic → AI → vector layer)
// can be exercised without a real model server. The shape mimics what
// SAM/segment-geospatial would emit — a polygon per detected segment with
// a confidence score.
export class MockExtractor implements Extractor {
  readonly name = "mock";
  readonly model = "opengeo-mock-extractor-v1";

  async extract(input: ExtractionInput): Promise<ExtractionResult> {
    const started = Date.now();
    const bbox = input.bbox ?? fallbackBbox();
    const count = countFromPrompt(input.prompt);
    const features: GeoJSON.Feature[] = [];
    for (let i = 0; i < count; i += 1) {
      features.push(syntheticPolygon(bbox, input.prompt, i));
    }
    return {
      featureCollection: { type: "FeatureCollection", features },
      metrics: {
        model: this.model,
        latencyMs: Date.now() - started,
        featureCount: features.length,
        extras: { seed: input.orthomosaicId, boxFromBbox: !!input.bbox },
      },
    };
  }
}

// Drone orthomosaics in Phase 1 default to somewhere in Grass Valley, CA —
// matches the seed map center in MapCanvas.
function fallbackBbox(): [number, number, number, number] {
  return [-121.07, 39.215, -121.05, 39.225];
}

function countFromPrompt(prompt: string): number {
  // Lightly heuristic: "all trees" → ~12, "building" → ~6, anything else → 4.
  const p = prompt.toLowerCase();
  if (p.includes("tree") || p.includes("vegetation")) return 12;
  if (p.includes("building") || p.includes("roof") || p.includes("structure")) return 6;
  if (p.includes("vehicle") || p.includes("car") || p.includes("truck")) return 8;
  return 4;
}

function syntheticPolygon(
  bbox: [number, number, number, number],
  prompt: string,
  i: number,
): GeoJSON.Feature {
  const [w, s, e, n] = bbox;
  const lngSpan = e - w;
  const latSpan = n - s;
  // Reproducible "random" using a cheap hash of (prompt, i) — deterministic
  // enough for demos and replay.
  const r = pseudoRandom(`${prompt}:${i}`);
  const cx = w + lngSpan * (0.1 + 0.8 * r(0));
  const cy = s + latSpan * (0.1 + 0.8 * r(1));
  const wx = lngSpan * 0.015 * (0.5 + r(2));
  const wy = latSpan * 0.015 * (0.5 + r(3));
  const ring: [number, number][] = [
    [cx - wx, cy - wy],
    [cx + wx, cy - wy],
    [cx + wx, cy + wy],
    [cx - wx, cy + wy],
    [cx - wx, cy - wy],
  ];
  return {
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [ring] },
    properties: {
      label: prompt,
      index: i,
      confidence: Number((0.6 + 0.4 * r(4)).toFixed(3)),
    },
  };
}

function pseudoRandom(seed: string): (k: number) => number {
  // xfnv1a hash over the seed string, then a small LCG keyed by k. Not
  // cryptographic — just enough to produce varied coordinates.
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (k: number) => {
    const v = Math.imul(h ^ (k + 0x9e3779b9), 2654435761);
    return ((v >>> 0) / 0xffffffff);
  };
}
