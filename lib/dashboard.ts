import { z } from "zod";

const WidgetIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/);

const WidgetTitleSchema = z.string().trim().min(1).max(80);
const WidgetLayerIdSchema = z.string().trim().min(1).max(128);

export const DashboardMapWidgetSchema = z.object({
  id: WidgetIdSchema,
  type: z.literal("pmtiles_map"),
  title: WidgetTitleSchema,
  layerId: WidgetLayerIdSchema,
  zoomToLayer: z.boolean().default(true),
});

export const DashboardFeatureCountChartWidgetSchema = z.object({
  id: WidgetIdSchema,
  type: z.literal("feature_count_chart"),
  title: WidgetTitleSchema,
  layerId: WidgetLayerIdSchema,
  display: z.enum(["stat", "bar"]).default("stat"),
});

export const DashboardWidgetSchema = z.discriminatedUnion("type", [
  DashboardMapWidgetSchema,
  DashboardFeatureCountChartWidgetSchema,
]);

export const DashboardWidgetsSchema = z
  .array(DashboardWidgetSchema)
  .min(2)
  .max(6)
  .superRefine((widgets, ctx) => {
    const ids = new Set<string>();
    let mapCount = 0;
    let chartCount = 0;

    widgets.forEach((widget, index) => {
      if (ids.has(widget.id)) {
        ctx.addIssue({
          code: "custom",
          path: [index, "id"],
          message: "Widget ids must be unique.",
        });
      }
      ids.add(widget.id);

      if (widget.type === "pmtiles_map") mapCount += 1;
      if (widget.type === "feature_count_chart") chartCount += 1;
    });

    if (mapCount !== 1) {
      ctx.addIssue({
        code: "custom",
        message: "Dashboard must include exactly one PMTiles map widget.",
      });
    }
    if (chartCount < 1) {
      ctx.addIssue({
        code: "custom",
        message: "Dashboard must include at least one chart widget.",
      });
    }
  });

export type DashboardMapWidget = z.infer<typeof DashboardMapWidgetSchema>;
export type DashboardFeatureCountChartWidget = z.infer<
  typeof DashboardFeatureCountChartWidgetSchema
>;
export type DashboardWidget = z.infer<typeof DashboardWidgetSchema>;

export function defaultDashboardWidgets(layerId: string): DashboardWidget[] {
  return [
    {
      id: "map",
      type: "pmtiles_map",
      title: "Map",
      layerId,
      zoomToLayer: true,
    },
    {
      id: "feature-count",
      type: "feature_count_chart",
      title: "Features",
      layerId,
      display: "stat",
    },
  ];
}

export function parseDashboardWidgets(value: unknown): DashboardWidget[] | null {
  const parsed = DashboardWidgetsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function dashboardWidgetsFromStored(
  value: unknown,
  fallbackLayerId: string,
): DashboardWidget[] {
  return parseDashboardWidgets(value) ?? defaultDashboardWidgets(fallbackLayerId);
}

export function validateDashboardWidgetLayers(
  widgets: DashboardWidget[],
  layerIds: Iterable<string>,
): string | null {
  const allowed = new Set(layerIds);
  const invalid = widgets.find((widget) => !allowed.has(widget.layerId));
  if (!invalid) return null;
  return `Dashboard widget "${invalid.title}" must reference a PMTiles layer in this project.`;
}
