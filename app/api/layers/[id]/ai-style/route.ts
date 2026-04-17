import { NextResponse } from "next/server";
import { z } from "zod";
import {
  nlToStyle,
  type GeometryKind,
  type LayerContext,
} from "@/lib/ai/nl-style";
import { logAiEvent } from "@/lib/ai/logger";
import { env, flag } from "@/lib/env";
import { supabaseServer } from "@/lib/supabase/server";
import { withRoute } from "@/lib/observability/with-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid() });
const BodySchema = z.object({
  prompt: z.string().trim().min(3).max(500),
});

const VALID_GEOMETRY_KINDS: ReadonlyArray<GeometryKind> = [
  "point",
  "line",
  "polygon",
  "raster",
];

export const POST = withRoute<{ id: string }>(
  "ai.style",
  async (req, ctx) => {
    if (!flag.aiStyleGen()) {
      return NextResponse.json(
        {
          ok: false,
          error: "AI styling is disabled (FEATURE_AI_STYLE_GEN=false).",
        },
        { status: 503 },
      );
    }
    if (!env().ANTHROPIC_API_KEY) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "ANTHROPIC_API_KEY is not set. Add it to .env.local to enable this feature.",
        },
        { status: 503 },
      );
    }

    const rawParams = await ctx.params;
    const paramParsed = ParamsSchema.safeParse(rawParams);
    if (!paramParsed.success) {
      return NextResponse.json(
        { ok: false, error: "Invalid layer id." },
        { status: 400 },
      );
    }

    const bodyParsed = BodySchema.safeParse(
      await req.json().catch(() => ({})),
    );
    if (!bodyParsed.success) {
      return NextResponse.json(
        { ok: false, error: "Invalid request body." },
        { status: 400 },
      );
    }

    const supabase = await supabaseServer();
    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) {
      return NextResponse.json(
        { ok: false, error: "Not authenticated." },
        { status: 401 },
      );
    }

    const actorId = userData.user.id;
    const layerId = paramParsed.data.id;
    const prompt = bodyParsed.data.prompt;

    // RLS enforces org boundaries; an unauthorized user sees no row here.
    const { data: layer, error: layerErr } = await supabase
      .schema("opengeo")
      .from("layers")
      .select("id, geometry_kind")
      .eq("id", layerId)
      .maybeSingle();
    if (layerErr) {
      return NextResponse.json(
        { ok: false, error: layerErr.message },
        { status: 500 },
      );
    }
    if (!layer) {
      return NextResponse.json(
        { ok: false, error: "Layer not found." },
        { status: 404 },
      );
    }

    const layerKind = layer.geometry_kind as string;
    const geometryKind = (VALID_GEOMETRY_KINDS as ReadonlyArray<string>).includes(
      layerKind,
    )
      ? (layerKind as GeometryKind)
      : "polygon";

    // Sample property keys + a few example values so the model can ground
    // data-driven expressions in keys that actually exist. Skipped for
    // rasters — they have no features table to probe.
    let sampleProperties: LayerContext["sampleProperties"] = [];
    if (geometryKind !== "raster") {
      const { data: rows } = await supabase
        .schema("opengeo")
        .from("features")
        .select("properties")
        .eq("layer_id", layerId)
        .limit(10);
      if (rows) {
        const buckets = new Map<string, string[]>();
        for (const row of rows) {
          const props = (row as { properties: Record<string, unknown> | null })
            .properties;
          if (!props) continue;
          for (const [k, v] of Object.entries(props)) {
            const bucket = buckets.get(k) ?? [];
            if (bucket.length < 5) {
              const asStr =
                v === null || v === undefined ? "null" : String(v);
              if (!bucket.includes(asStr)) bucket.push(asStr);
            }
            buckets.set(k, bucket);
          }
        }
        sampleProperties = Array.from(buckets.entries())
          .slice(0, 20)
          .map(([key, sampleValues]) => ({ key, sampleValues }));
      }
    }

    const layerContext: LayerContext = { geometryKind, sampleProperties };

    let result;
    try {
      result = await nlToStyle(layerContext, prompt);
    } catch (e) {
      const msg = (e as Error).message;
      await logAiEvent({
        orgId: null,
        actorId,
        kind: "nl_style",
        model: env().ANTHROPIC_MODEL,
        prompt,
        responseSummary: `LLM_ERROR: ${msg}`,
        metadata: { layerId, geometryKind },
      });
      return NextResponse.json(
        { ok: false, error: `LLM error: ${msg}` },
        { status: 502 },
      );
    }

    const paintKeys = Object.keys(result.patch.paint ?? {});
    const layoutKeys = Object.keys(result.patch.layout ?? {});
    const isEmpty = paintKeys.length === 0 && layoutKeys.length === 0;

    await logAiEvent({
      orgId: null,
      actorId,
      kind: "nl_style",
      model: env().ANTHROPIC_MODEL,
      prompt,
      responseSummary: isEmpty
        ? `DECLINED: ${result.rationale.slice(0, 120)}`
        : `OK: paint=[${paintKeys.join(",")}] layout=[${layoutKeys.join(",")}]`,
      metadata: {
        layerId,
        geometryKind,
        label: result.label,
        rationale: result.rationale,
        patch: result.patch,
      },
    });

    // No persistence: the UI applies via onApply (live preview) and persists
    // via the existing PATCH /api/layers/[id] when the user clicks Save.
    return NextResponse.json({
      ok: true,
      label: result.label,
      patch: result.patch,
      rationale: result.rationale,
    });
  },
);
