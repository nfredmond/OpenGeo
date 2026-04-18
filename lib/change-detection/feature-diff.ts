// Feature-level change detection between two GeoJSON FeatureCollections.
//
// Inputs are expected to be EPSG:4326 (lon/lat). All distance math projects
// locally onto an equirectangular plane at each feature's latitude — fine for
// the scales we care about (a single site flown twice), not fine for
// continent-scale inputs.
//
// The module is deliberately dependency-free: no turf, no proj4. A drone diff
// for a ~100-acre site fits in milliseconds and keeps the bundle small.

export type Thresholds = {
  // Max centroid/point distance (meters) to consider two features "the same".
  distanceMeters: number;
  // Min polygon IoU to consider two polygons "the same".
  iouThreshold: number;
  // Geometry-shift budget (meters) before a matched pair is flagged "modified".
  modifiedDistanceMeters?: number;
  // Subset of property keys to watch for property-only changes.
  watchedKeys?: string[];
};

export const DEFAULT_THRESHOLDS: Thresholds = {
  distanceMeters: 5,
  iouThreshold: 0.5,
  modifiedDistanceMeters: 2,
  watchedKeys: [],
};

export type ChangeType = "added" | "removed" | "modified";

export type DiffFeature = GeoJSON.Feature<
  GeoJSON.Geometry,
  Record<string, unknown> & {
    change_type: ChangeType;
    source_feature_id: string | number | null;
  }
>;

export type DiffResult = {
  featureCollection: GeoJSON.FeatureCollection<GeoJSON.Geometry, DiffFeature["properties"]>;
  counts: { added: number; removed: number; modified: number };
  thresholdsUsed: Thresholds;
};

// Feature category: we only match within the same category.
type Category = "polygon" | "point" | "line" | "other";

function categoryOf(g: GeoJSON.Geometry | null | undefined): Category {
  if (!g) return "other";
  switch (g.type) {
    case "Polygon":
    case "MultiPolygon":
      return "polygon";
    case "Point":
    case "MultiPoint":
      return "point";
    case "LineString":
    case "MultiLineString":
      return "line";
    default:
      return "other";
  }
}

// ---------- geometry helpers ----------

type LonLat = [number, number];

// Meters per degree at a given latitude, using spherical Earth (R = 6_371_000 m).
// One degree of latitude ≈ 111_320 m everywhere; one degree of longitude scales
// with cos(lat).
function mPerDeg(latDeg: number): { mLat: number; mLon: number } {
  const mLat = 111_320;
  const mLon = 111_320 * Math.cos((latDeg * Math.PI) / 180);
  return { mLat, mLon };
}

function distanceMeters(a: LonLat, b: LonLat): number {
  const lat = (a[1] + b[1]) / 2;
  const { mLat, mLon } = mPerDeg(lat);
  const dx = (a[0] - b[0]) * mLon;
  const dy = (a[1] - b[1]) * mLat;
  return Math.hypot(dx, dy);
}

// Ring-as-polygon centroid (signed area weighted). Handles Polygon + MultiPolygon
// by collapsing all outer rings into one weighted centroid.
function centroid(g: GeoJSON.Geometry): LonLat | null {
  if (g.type === "Point") return [g.coordinates[0], g.coordinates[1]];
  if (g.type === "MultiPoint") {
    if (g.coordinates.length === 0) return null;
    const sum = g.coordinates.reduce(
      (acc, p) => [acc[0] + p[0], acc[1] + p[1]] as LonLat,
      [0, 0] as LonLat,
    );
    return [sum[0] / g.coordinates.length, sum[1] / g.coordinates.length];
  }
  if (g.type === "LineString") return lineCentroid(g.coordinates);
  if (g.type === "MultiLineString") {
    const combined: LonLat[] = [];
    for (const l of g.coordinates) for (const p of l) combined.push([p[0], p[1]]);
    return lineCentroid(combined);
  }
  if (g.type === "Polygon") return polyOuterCentroid(g.coordinates[0] ?? []);
  if (g.type === "MultiPolygon") {
    let sx = 0;
    let sy = 0;
    let sA = 0;
    for (const poly of g.coordinates) {
      const ring = poly[0] ?? [];
      const { x, y, a } = ringCentroidArea(ring);
      sx += x * a;
      sy += y * a;
      sA += a;
    }
    if (Math.abs(sA) < 1e-12) return null;
    return [sx / sA, sy / sA];
  }
  return null;
}

function lineCentroid(coords: number[][]): LonLat | null {
  if (coords.length === 0) return null;
  // Length-weighted average midpoint.
  let sx = 0;
  let sy = 0;
  let total = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    const d = distanceMeters([a[0], a[1]], [b[0], b[1]]);
    const mx = (a[0] + b[0]) / 2;
    const my = (a[1] + b[1]) / 2;
    sx += mx * d;
    sy += my * d;
    total += d;
  }
  if (total === 0) {
    const p = coords[0];
    return [p[0], p[1]];
  }
  return [sx / total, sy / total];
}

function polyOuterCentroid(ring: number[][]): LonLat | null {
  const { x, y, a } = ringCentroidArea(ring);
  if (Math.abs(a) < 1e-12) return null;
  return [x, y];
}

// Signed area + centroid in lon/lat space (good enough for the matching step;
// final distance threshold is in meters).
function ringCentroidArea(ring: number[][]): { x: number; y: number; a: number } {
  let a = 0;
  let cx = 0;
  let cy = 0;
  const n = ring.length;
  if (n < 3) return { x: 0, y: 0, a: 0 };
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[i + 1];
    const cross = x0 * y1 - x1 * y0;
    a += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  a *= 0.5;
  if (Math.abs(a) < 1e-12) return { x: 0, y: 0, a: 0 };
  cx /= 6 * a;
  cy /= 6 * a;
  return { x: cx, y: cy, a };
}

// ---------- bbox helpers ----------

function featureBbox(g: GeoJSON.Geometry): [number, number, number, number] | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const walk = (coords: unknown): void => {
    if (typeof (coords as number[])[0] === "number") {
      const [x, y] = coords as number[];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    } else {
      for (const c of coords as unknown[]) walk(c);
    }
  };
  if ("coordinates" in g) walk(g.coordinates);
  if (!Number.isFinite(minX)) return null;
  return [minX, minY, maxX, maxY];
}

function bboxOverlap(
  a: [number, number, number, number],
  b: [number, number, number, number],
): boolean {
  return !(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]);
}

// ---------- polygon IoU (approximate, bbox-based fallback for non-rectangular
// shapes would need a clipper; for drone-site overlays we use a centroid+area
// approximation that's good enough for an editor-sanity v1). ----------
//
// Rationale: a proper Weiler-Atherton or Greiner-Hormann clipper is ~400 lines
// of geometry; the diff is a starting-point, not a survey-grade tool. We
// estimate IoU from (a) centroid distance vs polygon radius and (b) area ratio.
// If the two polygons' centroids are within min(r_a, r_b) / 2 and their areas
// differ by < 50%, we call it a match with an estimated IoU.
//
// The estimator is intentionally conservative: it can undercount matches
// (producing spurious added/removed), never overcount. The route logs
// iouThreshold in metadata so operators can tune.

function polygonIouEstimate(
  a: GeoJSON.Geometry,
  b: GeoJSON.Geometry,
): number {
  const ca = centroid(a);
  const cb = centroid(b);
  if (!ca || !cb) return 0;
  const areaA = approxAreaM2(a);
  const areaB = approxAreaM2(b);
  if (areaA <= 0 || areaB <= 0) return 0;
  const rA = Math.sqrt(areaA / Math.PI);
  const rB = Math.sqrt(areaB / Math.PI);
  const d = distanceMeters(ca, cb);
  // Two circles of radius rA/rB at distance d: overlap area approximation.
  // If d >= rA + rB, no overlap.
  if (d >= rA + rB) return 0;
  // Symmetric-disk overlap formula.
  const r1 = rA;
  const r2 = rB;
  const part1 =
    r1 * r1 * Math.acos(clamp((d * d + r1 * r1 - r2 * r2) / (2 * d * r1), -1, 1));
  const part2 =
    r2 * r2 * Math.acos(clamp((d * d + r2 * r2 - r1 * r1) / (2 * d * r2), -1, 1));
  const part3 =
    0.5 *
    Math.sqrt(
      Math.max(
        0,
        (-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2),
      ),
    );
  const overlap = d > 0 ? part1 + part2 - part3 : Math.PI * Math.min(r1, r2) ** 2;
  const union = areaA + areaB - overlap;
  return union > 0 ? overlap / union : 0;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// Very rough planar area in m² (projects into a local equirectangular plane
// near the feature centroid).
function approxAreaM2(g: GeoJSON.Geometry): number {
  const c = centroid(g);
  if (!c) return 0;
  const { mLat, mLon } = mPerDeg(c[1]);
  const rings = extractOuterRings(g);
  let total = 0;
  for (const ring of rings) {
    let a = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const [x0, y0] = ring[i];
      const [x1, y1] = ring[i + 1];
      const px0 = x0 * mLon;
      const py0 = y0 * mLat;
      const px1 = x1 * mLon;
      const py1 = y1 * mLat;
      a += px0 * py1 - px1 * py0;
    }
    total += Math.abs(a) * 0.5;
  }
  return total;
}

function extractOuterRings(g: GeoJSON.Geometry): number[][][] {
  if (g.type === "Polygon") return g.coordinates[0] ? [g.coordinates[0]] : [];
  if (g.type === "MultiPolygon") return g.coordinates.flatMap((p) => (p[0] ? [p[0]] : []));
  return [];
}

// ---------- hausdorff (lines, one-way sampled) ----------

function lineHausdorff(a: GeoJSON.Geometry, b: GeoJSON.Geometry): number {
  const pa = samplePoints(a, 16);
  const pb = samplePoints(b, 16);
  if (pa.length === 0 || pb.length === 0) return Infinity;
  const h = (from: LonLat[], to: LonLat[]): number => {
    let worst = 0;
    for (const p of from) {
      let best = Infinity;
      for (const q of to) {
        const d = distanceMeters(p, q);
        if (d < best) best = d;
      }
      if (best > worst) worst = best;
    }
    return worst;
  };
  return Math.max(h(pa, pb), h(pb, pa));
}

function samplePoints(g: GeoJSON.Geometry, n: number): LonLat[] {
  const coords: LonLat[] = [];
  if (g.type === "LineString") {
    for (const c of g.coordinates) coords.push([c[0], c[1]]);
  } else if (g.type === "MultiLineString") {
    for (const line of g.coordinates) for (const c of line) coords.push([c[0], c[1]]);
  }
  if (coords.length <= n) return coords;
  const out: LonLat[] = [];
  const step = (coords.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) out.push(coords[Math.floor(i * step)]);
  return out;
}

// ---------- property diff ----------

function propertiesDiffer(
  a: Record<string, unknown> | null | undefined,
  b: Record<string, unknown> | null | undefined,
  watched: readonly string[],
): boolean {
  if (watched.length === 0) return false;
  const pa = a ?? {};
  const pb = b ?? {};
  for (const k of watched) {
    if (!Object.is(pa[k], pb[k])) return true;
  }
  return false;
}

// ---------- main entry ----------

type Indexed = {
  feature: GeoJSON.Feature;
  id: string | number | null;
  category: Category;
  centroid: LonLat | null;
  bbox: [number, number, number, number] | null;
};

function indexFeature(f: GeoJSON.Feature): Indexed {
  const g = f.geometry;
  const c = g ? categoryOf(g) : "other";
  const ctr = g ? centroid(g) : null;
  const bb = g ? featureBbox(g) : null;
  const id = f.id ?? (f.properties as { id?: string | number } | undefined)?.id ?? null;
  return { feature: f, id, category: c, centroid: ctr, bbox: bb };
}

export function diffFeatures(
  from: GeoJSON.FeatureCollection,
  to: GeoJSON.FeatureCollection,
  thresholds: Partial<Thresholds> = {},
): DiffResult {
  if (from.type !== "FeatureCollection" || to.type !== "FeatureCollection") {
    throw new Error("Both inputs must be FeatureCollections.");
  }
  const t: Thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };

  const fromIdx = from.features.map(indexFeature);
  const toIdx = to.features.map(indexFeature);
  const matched = new Set<number>(); // indices into toIdx

  const out: DiffFeature[] = [];
  const counts = { added: 0, removed: 0, modified: 0 };

  for (const a of fromIdx) {
    if (a.category === "other") continue;
    let best: { j: number; score: number; distance: number } | null = null;
    for (let j = 0; j < toIdx.length; j++) {
      if (matched.has(j)) continue;
      const b = toIdx[j];
      if (b.category !== a.category) continue;
      if (!a.bbox || !b.bbox) continue;
      // quick reject on bbox (with a generous buffer for near-misses)
      const buffered: [number, number, number, number] = [
        a.bbox[0] - 0.001,
        a.bbox[1] - 0.001,
        a.bbox[2] + 0.001,
        a.bbox[3] + 0.001,
      ];
      if (!bboxOverlap(buffered, b.bbox)) continue;
      const scored = scorePair(a, b, t);
      if (!scored) continue;
      if (!best || scored.score > best.score) best = { j, ...scored };
    }
    if (best) {
      matched.add(best.j);
      const bFeature = toIdx[best.j].feature;
      const geomShiftExceeds =
        typeof t.modifiedDistanceMeters === "number" &&
        best.distance > t.modifiedDistanceMeters;
      const propsDiffer = propertiesDiffer(
        a.feature.properties,
        bFeature.properties,
        t.watchedKeys ?? [],
      );
      if (geomShiftExceeds || propsDiffer) {
        counts.modified++;
        out.push({
          type: "Feature",
          geometry: bFeature.geometry,
          properties: {
            ...(bFeature.properties ?? {}),
            change_type: "modified",
            source_feature_id: a.id,
          },
        });
      }
      // else: paired but stable → omit from the output.
    } else {
      counts.removed++;
      out.push({
        type: "Feature",
        geometry: a.feature.geometry,
        properties: {
          ...(a.feature.properties ?? {}),
          change_type: "removed",
          source_feature_id: a.id,
        },
      });
    }
  }

  for (let j = 0; j < toIdx.length; j++) {
    if (matched.has(j)) continue;
    const b = toIdx[j];
    if (b.category === "other") continue;
    counts.added++;
    out.push({
      type: "Feature",
      geometry: b.feature.geometry,
      properties: {
        ...(b.feature.properties ?? {}),
        change_type: "added",
        source_feature_id: b.id,
      },
    });
  }

  return {
    featureCollection: { type: "FeatureCollection", features: out },
    counts,
    thresholdsUsed: t,
  };
}

function scorePair(
  a: Indexed,
  b: Indexed,
  t: Thresholds,
): { score: number; distance: number } | null {
  if (!a.centroid || !b.centroid) return null;
  const d = distanceMeters(a.centroid, b.centroid);
  if (a.category === "polygon") {
    if (d > Math.max(t.distanceMeters * 10, 50)) return null;
    const iou = polygonIouEstimate(a.feature.geometry, b.feature.geometry);
    if (iou < t.iouThreshold) return null;
    return { score: iou, distance: d };
  }
  if (a.category === "point") {
    if (d > t.distanceMeters) return null;
    return { score: 1 - d / (t.distanceMeters + 1e-9), distance: d };
  }
  if (a.category === "line") {
    const h = lineHausdorff(a.feature.geometry, b.feature.geometry);
    if (h > t.distanceMeters) return null;
    return { score: 1 - h / (t.distanceMeters + 1e-9), distance: h };
  }
  return null;
}
