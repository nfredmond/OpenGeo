import "server-only";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText, Output } from "ai";
import { z } from "zod";
import { env } from "@/lib/env";
import type { LayerStylePatch } from "@/components/map/map-canvas";

export type GeometryKind = "point" | "line" | "polygon" | "raster";

export type LayerContext = {
  geometryKind: GeometryKind;
  sampleProperties: Array<{ key: string; sampleValues: string[] }>;
};

// Allow-lists per geometry kind. MapLibre silently drops unknown keys, but we
// filter here as defense-in-depth so a hallucinated `line-width` on a point
// layer never leaves this module.
const ALLOWED_PAINT_KEYS: Record<GeometryKind, ReadonlyArray<string>> = {
  polygon: [
    "fill-color",
    "fill-opacity",
    "fill-outline-color",
    "line-color",
    "line-width",
  ],
  line: ["line-color", "line-width", "line-dasharray", "line-opacity"],
  point: [
    "circle-color",
    "circle-radius",
    "circle-stroke-color",
    "circle-stroke-width",
    "circle-opacity",
  ],
  raster: [
    "raster-opacity",
    "raster-contrast",
    "raster-brightness-min",
    "raster-brightness-max",
  ],
};

const ALLOWED_LAYOUT_KEYS: Record<GeometryKind, ReadonlyArray<string>> = {
  polygon: ["visibility"],
  line: ["visibility", "line-cap", "line-join"],
  point: ["visibility"],
  raster: ["visibility"],
};

const NlStyleSchema = z.object({
  label: z
    .string()
    .max(80)
    .describe("A short human-readable name for this style change."),
  patchJson: z
    .string()
    .max(4000)
    .describe(
      "A JSON-encoded MapLibre style patch object with optional paint/layout objects. Use \"{}\" to decline the request.",
    ),
  rationale: z
    .string()
    .max(500)
    .describe(
      "Why this patch answers the prompt, or why the request was declined.",
    ),
});

export type NlStyleResult = {
  label: string;
  patch: LayerStylePatch;
  rationale: string;
};

function buildSystemPrompt(ctx: LayerContext): string {
  const paintKeys = ALLOWED_PAINT_KEYS[ctx.geometryKind].join(", ");
  const layoutKeys = ALLOWED_LAYOUT_KEYS[ctx.geometryKind].join(", ");
  const propLines = ctx.sampleProperties.length
    ? ctx.sampleProperties
        .map(
          (p) =>
            `  - "${p.key}" (samples: ${p.sampleValues
              .slice(0, 5)
              .map((v) => JSON.stringify(v))
              .join(", ")})`,
        )
        .join("\n")
    : "  - (no properties available on this layer)";

  return `You translate natural-language style requests into a MapLibre GL style patch for a single map layer.

Output contract:
- Return a JSON object { label, patchJson, rationale } matching the schema.
- "patchJson" is a JSON string that parses to an object with optional "paint" and "layout" objects.
- Omit what you do not need inside patchJson.
- If the request is unsupported, return patchJson: "{}" and explain in rationale. Never throw. Never fabricate keys.

Target layer:
- Geometry kind: ${ctx.geometryKind}
- Allowed paint keys: ${paintKeys}
- Allowed layout keys: ${layoutKeys}
- NEVER emit keys outside those lists. A hallucinated key will be stripped.

Values:
- Colors accept names ("red", "steelblue"), hex ("#003366"), or rgb/rgba strings.
- Opacity is a number between 0 and 1 (e.g. 0.4, not 40).
- Widths and radii are in pixels as plain numbers (e.g. 2, not "2px").

Data-driven expressions:
- MapLibre lets you read a feature property with ["get", "<key>"], and you can build gradients with "interpolate" or categorical maps with "match".
- Polygon example (color by area_sqm, smaller → lighter):
    ["interpolate", ["linear"], ["get", "area_sqm"], 50, "#eef", 500, "#003"]
- Point example (color by class):
    ["match", ["get", "class"], "building", "#c44", "road", "#999", "#888"]
- Data-driven expressions MUST reference a property key that actually exists on this layer.
- If the user asks for a data-driven style but no suitable key is present, return patch: {} and say so in rationale.

Known properties on this layer:
${propLines}

Style economy:
- Return the smallest patch that answers the prompt. Do not restyle keys the user did not ask about.
- If the user asks for a subjective change ("make it pop", "look nicer"), choose one clear paint tweak and say why in rationale.`;
}

function filterAllowedKeys(
  obj: Record<string, unknown> | undefined,
  allowed: ReadonlyArray<string>,
): Record<string, unknown> | undefined {
  if (!obj) return undefined;
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (allowed.includes(k)) filtered[k] = v;
  }
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

function parsePatchJson(raw: string): LayerStylePatch {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  const patch = parsed as { paint?: unknown; layout?: unknown };
  return {
    paint:
      patch.paint && typeof patch.paint === "object" && !Array.isArray(patch.paint)
        ? (patch.paint as Record<string, unknown>)
        : undefined,
    layout:
      patch.layout && typeof patch.layout === "object" && !Array.isArray(patch.layout)
        ? (patch.layout as Record<string, unknown>)
        : undefined,
  };
}

export async function nlToStyle(
  layerContext: LayerContext,
  prompt: string,
): Promise<NlStyleResult> {
  const model = anthropic(env().ANTHROPIC_MODEL);
  const { output } = await generateText({
    model,
    output: Output.object({ schema: NlStyleSchema }),
    system: buildSystemPrompt(layerContext),
    prompt: `User request: ${prompt}\n\nReturn a JSON object matching the provided schema. patchJson must be valid JSON. If the request is not supported by the allowed keys or the layer's available properties, return patchJson: "{}" and explain why.`,
    temperature: 0,
  });
  const rawPatch = parsePatchJson(output.patchJson);

  const paint = filterAllowedKeys(
    rawPatch.paint,
    ALLOWED_PAINT_KEYS[layerContext.geometryKind],
  );
  const layout = filterAllowedKeys(
    rawPatch.layout,
    ALLOWED_LAYOUT_KEYS[layerContext.geometryKind],
  );

  const patch: LayerStylePatch = {};
  if (paint) patch.paint = paint;
  if (layout) patch.layout = layout;

  return {
    label: output.label,
    patch,
    rationale: output.rationale,
  };
}
