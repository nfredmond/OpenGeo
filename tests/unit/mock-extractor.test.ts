import { describe, expect, it } from "vitest";
import { MockExtractor } from "@/lib/extraction/mock-extractor";

describe("MockExtractor", () => {
  const extractor = new MockExtractor();

  it("labels itself and declares a stable model id", () => {
    expect(extractor.name).toBe("mock");
    expect(extractor.model).toBe("opengeo-mock-extractor-v1");
  });

  it("returns more features for tree prompts than building prompts", async () => {
    const trees = await extractor.extract({
      orthomosaicId: "o-1",
      cogUrl: "https://example.com/o1.tif",
      prompt: "all trees",
      bbox: null,
    });
    const buildings = await extractor.extract({
      orthomosaicId: "o-1",
      cogUrl: "https://example.com/o1.tif",
      prompt: "all buildings",
      bbox: null,
    });
    expect(trees.metrics.featureCount).toBeGreaterThan(
      buildings.metrics.featureCount,
    );
  });

  it("is deterministic for identical inputs", async () => {
    const input = {
      orthomosaicId: "o-42",
      cogUrl: "https://example.com/o42.tif",
      prompt: "detect solar panels",
      bbox: null,
    } as const;
    const a = await extractor.extract(input);
    const b = await extractor.extract(input);
    expect(a.featureCollection).toEqual(b.featureCollection);
  });

  it("keeps features inside the requested bbox", async () => {
    const bbox: [number, number, number, number] = [-122.5, 37.7, -122.4, 37.8];
    const { featureCollection } = await extractor.extract({
      orthomosaicId: "o-bbox",
      cogUrl: "https://example.com/o.tif",
      prompt: "buildings",
      bbox,
    });
    for (const f of featureCollection.features) {
      expect(f.geometry.type).toBe("Polygon");
      const ring = (f.geometry as GeoJSON.Polygon).coordinates[0];
      for (const [lng, lat] of ring) {
        expect(lng).toBeGreaterThanOrEqual(bbox[0]);
        expect(lng).toBeLessThanOrEqual(bbox[2]);
        expect(lat).toBeGreaterThanOrEqual(bbox[1]);
        expect(lat).toBeLessThanOrEqual(bbox[3]);
      }
    }
  });

  it("tags each feature with the prompt as a label", async () => {
    const { featureCollection } = await extractor.extract({
      orthomosaicId: "o-label",
      cogUrl: "https://example.com/o.tif",
      prompt: "vehicles on the runway",
      bbox: null,
    });
    for (const f of featureCollection.features) {
      expect(f.properties?.label).toBe("vehicles on the runway");
      expect(typeof f.properties?.confidence).toBe("number");
    }
  });
});
