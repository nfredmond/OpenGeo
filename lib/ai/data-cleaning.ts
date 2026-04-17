import proj4 from "proj4";

// AI-adjacent data cleaning passes that run during dataset ingest. Not
// "AI" in the LLM sense — these are deterministic classifiers — but they
// participate in the `ai_events` audit trail because the decisions they
// produce (CRS assumption, column-type hints) are exactly the kind of
// thing a planner will want to verify later.

// --- CRS detection --------------------------------------------------------

export type CrsDetection =
  | {
      ok: true;
      epsg: 4326;
      source: "prj-wkt-4326" | "coord-bounds-4326";
      detail: string;
      proj4Def: "EPSG:4326";
    }
  | {
      ok: true;
      epsg: number | null; // null when proj4 parsed WKT but no AUTHORITY tag was present.
      source: "prj-wkt-authority" | "prj-wkt-parameters";
      detail: string;
      proj4Def: string;
    }
  | { ok: false; reason: string };

export function detectCrs(opts: {
  prjWkt: string | null;
  firstCoord: [number, number] | null;
}): CrsDetection {
  if (opts.prjWkt) {
    const wkt = opts.prjWkt;
    const epsgFromAuthority = extractEpsgAuthority(wkt);
    if (epsgFromAuthority === 4326) {
      return {
        ok: true,
        epsg: 4326,
        source: "prj-wkt-4326",
        detail: "WKT AUTHORITY=EPSG:4326",
        proj4Def: "EPSG:4326",
      };
    }
    // Is it a non-projected WGS84 GEOGCS without an AUTHORITY block? This
    // covers a lot of legacy shapefiles that say GEOGCS["GCS_WGS_1984",...]
    // without tagging the authority.
    if (
      epsgFromAuthority === null &&
      /^\s*GEOGCS\b/i.test(wkt) &&
      /GCS[_\s]?WGS[_\s]?1984|WGS[_\s]?84/i.test(wkt) &&
      !/\bPROJCS\b/i.test(wkt)
    ) {
      return {
        ok: true,
        epsg: 4326,
        source: "prj-wkt-4326",
        detail: "WKT GEOGCS matches WGS84 (no AUTHORITY)",
        proj4Def: "EPSG:4326",
      };
    }
    // Delegate to proj4: build a transformer and check it works. We only
    // need to confirm parseability here; the actual reprojection happens
    // in reproject.ts.
    try {
      proj4(wkt, "EPSG:4326").forward([0, 0]);
      if (epsgFromAuthority !== null && epsgFromAuthority !== 4326) {
        return {
          ok: true,
          epsg: epsgFromAuthority,
          source: "prj-wkt-authority",
          detail: `WKT AUTHORITY=EPSG:${epsgFromAuthority}`,
          proj4Def: wkt,
        };
      }
      return {
        ok: true,
        epsg: null,
        source: "prj-wkt-parameters",
        detail: "WKT parsed by proj4; no AUTHORITY tag.",
        proj4Def: wkt,
      };
    } catch (e) {
      return {
        ok: false,
        reason: `proj4 could not parse .prj WKT: ${(e as Error).message}`,
      };
    }
  }

  // No .prj. Coord-bounds heuristic.
  if (opts.firstCoord) {
    const [x, y] = opts.firstCoord;
    if (
      Number.isFinite(x) &&
      Number.isFinite(y) &&
      Math.abs(x) <= 180 &&
      Math.abs(y) <= 90
    ) {
      return {
        ok: true,
        epsg: 4326,
        source: "coord-bounds-4326",
        detail: `first coord (${x.toFixed(5)}, ${y.toFixed(5)}) is within lng/lat range — assuming WGS84.`,
        proj4Def: "EPSG:4326",
      };
    }
    return {
      ok: false,
      reason: `No .prj sidecar. First coord (${x}, ${y}) is outside lng/lat range; include a .prj file to declare the projection.`,
    };
  }
  return {
    ok: false,
    reason: "No .prj sidecar and no features to inspect.",
  };
}

function extractEpsgAuthority(wkt: string): number | null {
  const m = wkt.match(/AUTHORITY\s*\[\s*"EPSG"\s*,\s*"?(\d+)"?\s*\]/i);
  return m ? Number(m[1]) : null;
}

// --- Column-type inference -----------------------------------------------

export type ColumnType = "int" | "float" | "date" | "string" | "category";

export type ColumnTypeHint = {
  field: string;
  inferred: ColumnType;
  confidence: number; // 0..1
  nullCount: number;
  nonNullCount: number;
  distinctCount: number;
  sampleValues: string[];
  // Optional SQL hint — emitted only for the classifier's opinion, never
  // auto-applied to PostGIS. The upload route stores these in the
  // ai_events audit row for a reviewer.
  alterHint: string | null;
  reason: string;
};

const MAX_SAMPLE_FEATURES = 200;
const CATEGORY_DISTINCT_CAP = 20;
const CATEGORY_MIN_AVG_REPETITION = 3;
const DATE_RE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

// Inspects the first `sampleLimit` features and returns a per-field type
// hint. Pure function over property bags — no geometry-touching, so it
// works identically for shapefile, GeoJSON, or any future ingest path.
export function inferColumnTypes(
  features: GeoJSON.Feature[],
  sampleLimit = MAX_SAMPLE_FEATURES,
): ColumnTypeHint[] {
  const sample = features.slice(0, sampleLimit);
  const keyToValues = new Map<string, unknown[]>();
  for (const f of sample) {
    const props = (f.properties ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(props)) {
      const arr = keyToValues.get(key) ?? [];
      arr.push(props[key]);
      keyToValues.set(key, arr);
    }
  }

  const hints: ColumnTypeHint[] = [];
  for (const [field, values] of keyToValues) {
    hints.push(classifyField(field, values));
  }
  // Stable, human-friendly order: alpha by field name.
  hints.sort((a, b) => a.field.localeCompare(b.field));
  return hints;
}

function classifyField(field: string, values: unknown[]): ColumnTypeHint {
  const nonNull = values.filter((v) => v !== null && v !== undefined && v !== "");
  const nullCount = values.length - nonNull.length;
  if (nonNull.length === 0) {
    return {
      field,
      inferred: "string",
      confidence: 0,
      nullCount,
      nonNullCount: 0,
      distinctCount: 0,
      sampleValues: [],
      alterHint: null,
      reason: "All sampled values were null/empty.",
    };
  }

  const distinct = new Set(nonNull.map((v) => JSON.stringify(v)));
  const distinctCount = distinct.size;
  const sampleValues = Array.from(
    new Set(nonNull.slice(0, 20).map((v) => String(v))),
  ).slice(0, 5);

  // int?
  if (nonNull.every((v) => isIntegerLike(v))) {
    return {
      field,
      inferred: "int",
      confidence: 0.95,
      nullCount,
      nonNullCount: nonNull.length,
      distinctCount,
      sampleValues,
      alterHint: `ALTER COLUMN properties['${field}'] TYPE integer`,
      reason: `All ${nonNull.length} non-null values parse as integers.`,
    };
  }

  // float?
  if (nonNull.every((v) => isNumericLike(v))) {
    return {
      field,
      inferred: "float",
      confidence: 0.9,
      nullCount,
      nonNullCount: nonNull.length,
      distinctCount,
      sampleValues,
      alterHint: `ALTER COLUMN properties['${field}'] TYPE double precision`,
      reason: `All ${nonNull.length} non-null values parse as numbers.`,
    };
  }

  // date?
  if (nonNull.every((v) => isDateLike(v))) {
    return {
      field,
      inferred: "date",
      confidence: 0.85,
      nullCount,
      nonNullCount: nonNull.length,
      distinctCount,
      sampleValues,
      alterHint: `ALTER COLUMN properties['${field}'] TYPE timestamptz`,
      reason: `All ${nonNull.length} non-null values match an ISO-8601 date shape.`,
    };
  }

  // category?
  const avgRepetition = nonNull.length / Math.max(1, distinctCount);
  if (
    distinctCount > 0 &&
    distinctCount <= CATEGORY_DISTINCT_CAP &&
    avgRepetition >= CATEGORY_MIN_AVG_REPETITION
  ) {
    return {
      field,
      inferred: "category",
      confidence: 0.7,
      nullCount,
      nonNullCount: nonNull.length,
      distinctCount,
      sampleValues,
      alterHint: null,
      reason: `${distinctCount} distinct values across ${nonNull.length} rows (avg ${avgRepetition.toFixed(1)}× repetition).`,
    };
  }

  return {
    field,
    inferred: "string",
    confidence: 0.6,
    nullCount,
    nonNullCount: nonNull.length,
    distinctCount,
    sampleValues,
    alterHint: null,
    reason: `${distinctCount} distinct values across ${nonNull.length} rows — treated as free text.`,
  };
}

function isIntegerLike(v: unknown): boolean {
  if (typeof v === "number") return Number.isInteger(v);
  if (typeof v === "string") {
    if (v.trim() === "") return false;
    const n = Number(v);
    return Number.isFinite(n) && Number.isInteger(n);
  }
  return false;
}

function isNumericLike(v: unknown): boolean {
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "string") {
    if (v.trim() === "") return false;
    const n = Number(v);
    return Number.isFinite(n);
  }
  return false;
}

function isDateLike(v: unknown): boolean {
  if (v instanceof Date) return !Number.isNaN(v.getTime());
  if (typeof v !== "string") return false;
  if (!DATE_RE.test(v.trim())) return false;
  const d = new Date(v);
  return !Number.isNaN(d.getTime());
}
