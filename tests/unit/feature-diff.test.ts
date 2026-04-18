import { describe, expect, it } from "vitest";
import { diffFeatures, type Thresholds } from "@/lib/change-detection/feature-diff";

// Synthetic FeatureCollections exercise each matcher path. Coordinates are
// lon/lat around 39.1°N (Grass Valley, CA) so meters-per-degree math isn't
// degenerate. 0.0001° ≈ 11.1 m latitude, so "a couple meters shift" is
// ~0.00002°.

function pointFc(points: Array<{ id: string; lon: number; lat: number }>): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: points.map((p) => ({
      type: "Feature",
      id: p.id,
      geometry: { type: "Point", coordinates: [p.lon, p.lat] },
      properties: { id: p.id },
    })),
  };
}

function squareFc(items: Array<{ id: string; lon: number; lat: number; sizeDeg: number }>): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: items.map((s) => {
      const half = s.sizeDeg / 2;
      const ring: number[][] = [
        [s.lon - half, s.lat - half],
        [s.lon + half, s.lat - half],
        [s.lon + half, s.lat + half],
        [s.lon - half, s.lat + half],
        [s.lon - half, s.lat - half],
      ];
      return {
        type: "Feature",
        id: s.id,
        geometry: { type: "Polygon", coordinates: [ring] },
        properties: { id: s.id },
      };
    }),
  };
}

function lineFc(items: Array<{ id: string; coords: Array<[number, number]> }>): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: items.map((l) => ({
      type: "Feature",
      id: l.id,
      geometry: { type: "LineString", coordinates: l.coords },
      properties: { id: l.id },
    })),
  };
}

describe("feature-diff", () => {
  it("pure addition: one new point -> counts.added === 1", () => {
    const from = pointFc([{ id: "a", lon: -121.0, lat: 39.1 }]);
    const to = pointFc([
      { id: "a", lon: -121.0, lat: 39.1 },
      { id: "b", lon: -121.001, lat: 39.101 },
    ]);
    const r = diffFeatures(from, to);
    expect(r.counts).toEqual({ added: 1, removed: 0, modified: 0 });
    expect(r.featureCollection.features).toHaveLength(1);
    expect(r.featureCollection.features[0].properties?.change_type).toBe("added");
    expect(r.featureCollection.features[0].properties?.source_feature_id).toBe("b");
  });

  it("pure removal: one missing point -> counts.removed === 1", () => {
    const from = pointFc([
      { id: "a", lon: -121.0, lat: 39.1 },
      { id: "b", lon: -121.001, lat: 39.101 },
    ]);
    const to = pointFc([{ id: "a", lon: -121.0, lat: 39.1 }]);
    const r = diffFeatures(from, to);
    expect(r.counts).toEqual({ added: 0, removed: 1, modified: 0 });
    expect(r.featureCollection.features[0].properties?.change_type).toBe("removed");
  });

  it("point shift below threshold: no modified output", () => {
    const from = pointFc([{ id: "a", lon: -121.0, lat: 39.1 }]);
    // ~0.5 m shift
    const to = pointFc([{ id: "a", lon: -121.0, lat: 39.1 + 0.0000045 }]);
    const thresholds: Partial<Thresholds> = { distanceMeters: 5, modifiedDistanceMeters: 2 };
    const r = diffFeatures(from, to, thresholds);
    expect(r.counts).toEqual({ added: 0, removed: 0, modified: 0 });
    expect(r.featureCollection.features).toHaveLength(0);
  });

  it("point shift above modified threshold: modified emitted", () => {
    const from = pointFc([{ id: "a", lon: -121.0, lat: 39.1 }]);
    // ~3.3 m shift
    const to = pointFc([{ id: "a", lon: -121.0, lat: 39.1 + 0.00003 }]);
    const thresholds: Partial<Thresholds> = { distanceMeters: 5, modifiedDistanceMeters: 2 };
    const r = diffFeatures(from, to, thresholds);
    expect(r.counts.modified).toBe(1);
    expect(r.featureCollection.features[0].properties?.change_type).toBe("modified");
  });

  it("polygon overlap above IoU threshold: treated as match (no change)", () => {
    // Two nearly identical 10×10 m squares (0.0001° ≈ 11 m).
    const from = squareFc([{ id: "p", lon: -121.0, lat: 39.1, sizeDeg: 0.0001 }]);
    const to = squareFc([{ id: "p", lon: -121.0, lat: 39.1, sizeDeg: 0.0001 }]);
    const r = diffFeatures(from, to, { iouThreshold: 0.5, modifiedDistanceMeters: 2 });
    expect(r.counts).toEqual({ added: 0, removed: 0, modified: 0 });
  });

  it("polygon shifted well beyond IoU threshold: removed + added", () => {
    const from = squareFc([{ id: "p", lon: -121.0, lat: 39.1, sizeDeg: 0.0001 }]);
    // Move ~100 m east — clearly non-overlapping.
    const to = squareFc([{ id: "p", lon: -121.0 + 0.0012, lat: 39.1, sizeDeg: 0.0001 }]);
    const r = diffFeatures(from, to, { iouThreshold: 0.5 });
    expect(r.counts.removed).toBe(1);
    expect(r.counts.added).toBe(1);
  });

  it("line matched by Hausdorff under threshold: no change", () => {
    const from = lineFc([
      { id: "l", coords: [[-121.0, 39.1], [-121.0002, 39.1002]] },
    ]);
    const to = lineFc([
      { id: "l", coords: [[-121.0, 39.1], [-121.0002, 39.1002]] },
    ]);
    const r = diffFeatures(from, to, { distanceMeters: 5, modifiedDistanceMeters: 2 });
    expect(r.counts).toEqual({ added: 0, removed: 0, modified: 0 });
  });

  it("line pushed far away: removed + added", () => {
    const from = lineFc([
      { id: "l", coords: [[-121.0, 39.1], [-121.0002, 39.1]] },
    ]);
    const to = lineFc([
      { id: "l", coords: [[-121.0, 39.2], [-121.0002, 39.2]] }, // ~11 km north
    ]);
    const r = diffFeatures(from, to, { distanceMeters: 5 });
    expect(r.counts).toEqual({ added: 1, removed: 1, modified: 0 });
  });

  it("watched property change flips an otherwise-stable match to modified", () => {
    const fromFc = pointFc([{ id: "a", lon: -121.0, lat: 39.1 }]);
    const toFc = pointFc([{ id: "a", lon: -121.0, lat: 39.1 }]);
    // Inject a property that differs.
    fromFc.features[0].properties = { id: "a", height_m: 3.0 };
    toFc.features[0].properties = { id: "a", height_m: 5.0 };
    const r = diffFeatures(fromFc, toFc, {
      watchedKeys: ["height_m"],
      modifiedDistanceMeters: 2,
    });
    expect(r.counts.modified).toBe(1);
  });

  it("rejects non-FeatureCollection input", () => {
    const bad = { type: "Feature", geometry: null, properties: {} } as unknown as GeoJSON.FeatureCollection;
    expect(() =>
      diffFeatures(bad, { type: "FeatureCollection", features: [] }),
    ).toThrow(/FeatureCollection/);
  });

  it("ignores features without geometry and doesn't crash", () => {
    const from: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: [
        { type: "Feature", id: "ghost", geometry: null as unknown as GeoJSON.Geometry, properties: {} },
      ],
    };
    const to: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
    const r = diffFeatures(from, to);
    expect(r.counts).toEqual({ added: 0, removed: 0, modified: 0 });
  });
});
