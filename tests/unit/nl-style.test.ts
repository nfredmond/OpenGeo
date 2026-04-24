import { describe, expect, it, vi, beforeEach } from "vitest";

const generateTextMock = vi.fn();

vi.mock("@ai-sdk/anthropic", () => ({
  anthropic: (id: string) => ({ id, provider: "anthropic" }),
}));

vi.mock("ai", () => ({
  generateText: (args: unknown) => generateTextMock(args),
  Output: {
    object: ({ schema }: { schema: unknown }) => ({ type: "object", schema }),
  },
}));

vi.mock("@/lib/env", () => ({
  env: () => ({ ANTHROPIC_MODEL: "test-model" }),
}));

// Import after vi.mock so the mocks are in place at module-resolution time.
const { nlToStyle } = await import("@/lib/ai/nl-style");
type LayerContext = Parameters<typeof nlToStyle>[0];

const polygonCtx: LayerContext = {
  geometryKind: "polygon",
  sampleProperties: [
    { key: "area_sqm", sampleValues: ["120", "340", "880"] },
    { key: "class", sampleValues: ["building"] },
  ],
};

const pointCtx: LayerContext = {
  geometryKind: "point",
  sampleProperties: [],
};

describe("nlToStyle", () => {
  beforeEach(() => {
    generateTextMock.mockReset();
  });

  it("keeps only allowed paint keys for the layer's geometry kind", async () => {
    generateTextMock.mockResolvedValueOnce({
      output: {
        label: "Dark red polygons",
        patchJson: JSON.stringify({
          paint: {
            "fill-color": "#8b0000",
            "fill-opacity": 0.6,
            // Disallowed for polygon — the filter should drop it.
            "circle-radius": 5,
          },
        }),
        rationale: "Dark red fill at 60% opacity.",
      },
    });

    const result = await nlToStyle(
      polygonCtx,
      "dark red polygons at 60% opacity",
    );

    expect(result.label).toBe("Dark red polygons");
    expect(result.patch.paint).toEqual({
      "fill-color": "#8b0000",
      "fill-opacity": 0.6,
    });
    expect(result.patch.paint).not.toHaveProperty("circle-radius");
  });

  it("passes through data-driven expressions that reference a real property key", async () => {
    generateTextMock.mockResolvedValueOnce({
      output: {
        label: "Color by area",
        patchJson: JSON.stringify({
          paint: {
            "fill-color": [
              "interpolate",
              ["linear"],
              ["get", "area_sqm"],
              50,
              "#eef",
              500,
              "#003",
            ],
          },
        }),
        rationale: "Interpolated gradient on area_sqm.",
      },
    });

    const result = await nlToStyle(
      polygonCtx,
      "color by area_sqm, bigger darker",
    );

    const fillColor = result.patch.paint?.["fill-color"] as unknown[];
    expect(Array.isArray(fillColor)).toBe(true);
    expect(fillColor[0]).toBe("interpolate");
    const getExpr = fillColor[2] as string[];
    expect(getExpr[0]).toBe("get");
    expect(getExpr[1]).toBe("area_sqm");
  });

  it("returns an empty patch when the model declines a nonsense prompt", async () => {
    generateTextMock.mockResolvedValueOnce({
      output: {
        label: "Declined",
        patchJson: "{}",
        rationale:
          "Declined — 'make it explode' is not a supported style change.",
      },
    });

    const result = await nlToStyle(polygonCtx, "make it explode");
    expect(result.patch).toEqual({});
    expect(result.rationale).toMatch(/declined/i);
  });

  it("filters disallowed layout keys per geometry kind", async () => {
    generateTextMock.mockResolvedValueOnce({
      output: {
        label: "Point style",
        patchJson: JSON.stringify({
          paint: { "circle-color": "#ff0000", "circle-radius": 8 },
          layout: {
            visibility: "visible",
            // Disallowed for point:
            "line-cap": "round",
          },
        }),
        rationale: "Red dots.",
      },
    });

    const result = await nlToStyle(pointCtx, "red dots");
    expect(result.patch.paint).toEqual({
      "circle-color": "#ff0000",
      "circle-radius": 8,
    });
    expect(result.patch.layout).toEqual({ visibility: "visible" });
  });

  it("grounds the system prompt on the layer's actual sample properties", async () => {
    generateTextMock.mockResolvedValueOnce({
      output: {
        label: "noop",
        patchJson: JSON.stringify({ paint: { "fill-color": "#fff" } }),
        rationale: "ok",
      },
    });

    await nlToStyle(polygonCtx, "anything");
    const call = generateTextMock.mock.calls[0]?.[0] as { system: string };
    expect(call.system).toContain("area_sqm");
    expect(call.system).toContain("class");
    expect(call.system).toContain("polygon");

    const allowedLine =
      call.system.match(/Allowed paint keys: (.+)/)?.[1] ?? "";
    expect(allowedLine).toContain("fill-color");
    expect(allowedLine).not.toContain("circle-color");
  });

  it("reports 'no properties available' when the layer has no sample properties", async () => {
    generateTextMock.mockResolvedValueOnce({
      output: {
        label: "noop",
        patchJson: JSON.stringify({ paint: { "circle-color": "#fff" } }),
        rationale: "ok",
      },
    });

    await nlToStyle(pointCtx, "anything");
    const call = generateTextMock.mock.calls[0]?.[0] as { system: string };
    expect(call.system).toContain("no properties available");
  });
});
