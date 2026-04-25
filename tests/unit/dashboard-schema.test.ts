import { describe, expect, it } from "vitest";
import {
  DashboardWidgetsSchema,
  defaultDashboardWidgets,
  validateDashboardWidgetLayers,
} from "@/lib/dashboard";

describe("dashboard widget schema", () => {
  it("builds the narrow default PMTiles map plus chart widgets", () => {
    expect(defaultDashboardWidgets("layer-1")).toEqual([
      {
        id: "map",
        type: "pmtiles_map",
        title: "Map",
        layerId: "layer-1",
        zoomToLayer: true,
      },
      {
        id: "feature-count",
        type: "feature_count_chart",
        title: "Features",
        layerId: "layer-1",
        display: "stat",
      },
    ]);
  });

  it("rejects generic widget shapes without one map and one chart", () => {
    const parsed = DashboardWidgetsSchema.safeParse([
      {
        id: "map",
        type: "pmtiles_map",
        title: "Map",
        layerId: "layer-1",
      },
      {
        id: "map",
        type: "pmtiles_map",
        title: "Second map",
        layerId: "layer-1",
      },
    ]);

    expect(parsed.success).toBe(false);
  });

  it("guards widget layer references against the project PMTiles set", () => {
    const widgets = defaultDashboardWidgets("layer-1");
    expect(validateDashboardWidgetLayers(widgets, ["layer-1"])).toBeNull();
    expect(validateDashboardWidgetLayers(widgets, ["other-layer"])).toContain(
      "must reference a PMTiles layer",
    );
  });
});
