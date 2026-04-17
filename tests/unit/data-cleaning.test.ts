import { describe, expect, it } from "vitest";
import { detectCrs, inferColumnTypes } from "@/lib/ai/data-cleaning";

describe("detectCrs", () => {
  it("returns 4326 when the WKT AUTHORITY tag is EPSG:4326", () => {
    const wkt = `GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433],AUTHORITY["EPSG","4326"]]`;
    const r = detectCrs({ prjWkt: wkt, firstCoord: [0, 0] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.epsg).toBe(4326);
    expect(r.source).toBe("prj-wkt-4326");
  });

  it("matches WGS84 GEOGCS WKT without AUTHORITY tag", () => {
    const wkt = `GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]`;
    const r = detectCrs({ prjWkt: wkt, firstCoord: null });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.epsg).toBe(4326);
    expect(r.source).toBe("prj-wkt-4326");
  });

  it("carries the EPSG code through for a projected CRS (UTM zone 10N)", () => {
    const wkt = `PROJCS["NAD83 / UTM zone 10N",GEOGCS["NAD83",DATUM["North_American_Datum_1983",SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",-123],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",0],UNIT["metre",1],AUTHORITY["EPSG","26910"]]`;
    const r = detectCrs({ prjWkt: wkt, firstCoord: null });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.epsg).toBe(26910);
    expect(r.source).toBe("prj-wkt-authority");
    expect(r.proj4Def).toContain("PROJCS");
  });

  it("falls back to coord-bounds when there's no .prj and coords are in lng/lat", () => {
    const r = detectCrs({ prjWkt: null, firstCoord: [-121.06, 39.22] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.epsg).toBe(4326);
    expect(r.source).toBe("coord-bounds-4326");
  });

  it("fails when there's no .prj and coords are clearly projected", () => {
    const r = detectCrs({ prjWkt: null, firstCoord: [521000, 4343000] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/outside lng\/lat range/);
  });

  it("fails when there's neither a .prj nor any coordinates", () => {
    const r = detectCrs({ prjWkt: null, firstCoord: null });
    expect(r.ok).toBe(false);
  });
});

describe("inferColumnTypes", () => {
  function feat(props: Record<string, unknown>): GeoJSON.Feature {
    return {
      type: "Feature",
      geometry: { type: "Point", coordinates: [0, 0] },
      properties: props,
    };
  }

  it("classifies purely integer fields as int", () => {
    const hints = inferColumnTypes([
      feat({ count: 1 }),
      feat({ count: 2 }),
      feat({ count: 3 }),
    ]);
    const h = hints.find((x) => x.field === "count");
    expect(h?.inferred).toBe("int");
    expect(h?.alterHint).toContain("integer");
  });

  it("classifies mixed numeric fields as float when any value has a fractional part", () => {
    const hints = inferColumnTypes([
      feat({ elevation: 100 }),
      feat({ elevation: 101.5 }),
      feat({ elevation: 99.9 }),
    ]);
    const h = hints.find((x) => x.field === "elevation");
    expect(h?.inferred).toBe("float");
    expect(h?.alterHint).toContain("double precision");
  });

  it("classifies ISO-8601 date strings as date", () => {
    const hints = inferColumnTypes([
      feat({ captured: "2026-04-16" }),
      feat({ captured: "2026-04-17T12:00:00Z" }),
      feat({ captured: "2026-04-18" }),
    ]);
    const h = hints.find((x) => x.field === "captured");
    expect(h?.inferred).toBe("date");
    expect(h?.alterHint).toContain("timestamptz");
  });

  it("classifies low-cardinality repeating strings as category", () => {
    const kinds = ["residential", "commercial", "park"];
    const features = Array.from({ length: 30 }, (_, i) =>
      feat({ kind: kinds[i % kinds.length] }),
    );
    const hints = inferColumnTypes(features);
    const h = hints.find((x) => x.field === "kind");
    expect(h?.inferred).toBe("category");
    expect(h?.distinctCount).toBe(3);
    expect(h?.alterHint).toBeNull();
  });

  it("classifies high-cardinality strings as plain string", () => {
    const features = Array.from({ length: 50 }, (_, i) => feat({ label: `feat-${i}` }));
    const hints = inferColumnTypes(features);
    const h = hints.find((x) => x.field === "label");
    expect(h?.inferred).toBe("string");
    expect(h?.distinctCount).toBe(50);
  });

  it("handles nulls/empties without crashing and reports nullCount", () => {
    const hints = inferColumnTypes([
      feat({ n: 1 }),
      feat({ n: null }),
      feat({ n: 2 }),
      feat({ n: "" }),
    ]);
    const h = hints.find((x) => x.field === "n");
    expect(h?.inferred).toBe("int");
    expect(h?.nullCount).toBe(2);
    expect(h?.nonNullCount).toBe(2);
  });

  it("caps the sample at 200 features for large layers", () => {
    const many = Array.from({ length: 500 }, (_, i) => feat({ n: i }));
    const hints = inferColumnTypes(many);
    const h = hints.find((x) => x.field === "n");
    expect(h?.nonNullCount).toBeLessThanOrEqual(200);
  });

  it("returns a zero-feature-safe hint when all values are null", () => {
    const hints = inferColumnTypes([feat({ foo: null }), feat({ foo: undefined })]);
    const h = hints.find((x) => x.field === "foo");
    expect(h?.inferred).toBe("string");
    expect(h?.nonNullCount).toBe(0);
    expect(h?.confidence).toBe(0);
  });
});
