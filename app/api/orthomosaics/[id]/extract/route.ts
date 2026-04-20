import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { withRoute } from "@/lib/observability/with-route";
import { extractionEnabled, getExtractor } from "@/lib/extraction";
import { logAiEvent } from "@/lib/ai/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Extraction can take 10s–60s depending on the model; keep the timeout wide.
export const maxDuration = 120;

const ParamsSchema = z.object({ id: z.string().uuid() });

const BodySchema = z.object({
  prompt: z.string().trim().min(1).max(500),
  layerName: z.string().trim().min(1).max(120).optional(),
  bbox: z
    .tuple([z.number(), z.number(), z.number(), z.number()])
    .optional(),
});

export const POST = withRoute<{ id: string }>(
  "orthomosaics.extract",
  async (req, ctx) => {
    if (!extractionEnabled()) {
      return NextResponse.json(
        { ok: false, error: "Feature extraction is disabled (FEATURE_AI_FEATURE_EXTRACTION=false)." },
        { status: 503 },
      );
    }

    const raw = await ctx.params;
    const paramsParsed = ParamsSchema.safeParse(raw);
    if (!paramsParsed.success) {
      return NextResponse.json({ ok: false, error: "Invalid orthomosaic id." }, { status: 400 });
    }

    const supabase = await supabaseServer();
    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) {
      return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
    }

    const bodyParsed = BodySchema.safeParse(await req.json().catch(() => ({})));
    if (!bodyParsed.success) {
      return NextResponse.json(
        { ok: false, error: "Invalid request body.", issues: bodyParsed.error.issues },
        { status: 400 },
      );
    }

    // Resolve ortho + parent flight/project in one shot. RLS ensures we only
    // see rows in orgs the caller belongs to.
    const { data: ortho, error: orthoErr } = await supabase
      .schema("opengeo")
      .from("orthomosaics")
      .select(
        `
        id,
        status,
        cog_url,
        flight:drone_flights!inner (
          id,
          project_id
        )
      `,
      )
      .eq("id", paramsParsed.data.id)
      .maybeSingle<{
        id: string;
        status: string;
        cog_url: string | null;
        flight: { id: string; project_id: string };
      }>();
    if (orthoErr) {
      return NextResponse.json({ ok: false, error: orthoErr.message }, { status: 500 });
    }
    if (!ortho) {
      return NextResponse.json({ ok: false, error: "Orthomosaic not found." }, { status: 404 });
    }
    if (ortho.status !== "ready" || !ortho.cog_url) {
      return NextResponse.json(
        { ok: false, error: "Orthomosaic is not ready — wait for ODM to finish." },
        { status: 409 },
      );
    }

    const extractor = getExtractor();
    const result = await extractor
      .extract({
        orthomosaicId: ortho.id,
        cogUrl: ortho.cog_url,
        prompt: bodyParsed.data.prompt,
        bbox: bodyParsed.data.bbox ?? null,
      })
      .catch((e: Error) => ({ error: e.message }) as const);

    if ("error" in result) {
      await logAiEvent({
        orgId: null,
        actorId: userData.user.id,
        kind: "extract",
        model: extractor.model,
        prompt: bodyParsed.data.prompt,
        responseSummary: `ERROR: ${result.error}`,
        metadata: { orthomosaicId: ortho.id, extractor: extractor.name },
      });
      return NextResponse.json({ ok: false, error: result.error }, { status: 502 });
    }

    // Ingest results into a new layer via the existing opengeo.ingest_geojson
    // RPC. This keeps features in the same shape as uploaded vector layers
    // so the viewer, tiles, and AI query all treat them identically.
    const layerName = bodyParsed.data.layerName ?? `AI: ${bodyParsed.data.prompt}`.slice(0, 120);
    const { data: layerId, error: ingestErr } = await supabase
      .schema("opengeo")
      .rpc("ingest_geojson", {
        p_project_id: ortho.flight.project_id,
        p_name: layerName,
        p_feature_collection: result.featureCollection,
      });
    if (ingestErr) {
      const status = ingestErr.code === "42501" ? 403 : 400;
      return NextResponse.json({ ok: false, error: ingestErr.message }, { status });
    }

    // Audit: link the run to the new layer and record metrics.
    await supabase
      .schema("opengeo")
      .from("extractions")
      .insert({
        orthomosaic_id: ortho.id,
        model: extractor.model,
        prompt: bodyParsed.data.prompt,
        output_layer_id: layerId,
        qa_status: "pending",
        metrics: result.metrics as unknown as Record<string, unknown>,
        created_by: userData.user.id,
      });
    await logAiEvent({
      orgId: null,
      actorId: userData.user.id,
      kind: "extract",
      model: extractor.model,
      prompt: bodyParsed.data.prompt,
      responseSummary: `OK: ${result.metrics.featureCount} features`,
      metadata: {
        orthomosaicId: ortho.id,
        outputLayerId: layerId,
        extractor: extractor.name,
        latencyMs: result.metrics.latencyMs,
      },
    });

    return NextResponse.json({
      ok: true,
      layerId,
      featureCount: result.metrics.featureCount,
      model: extractor.model,
      latencyMs: result.metrics.latencyMs,
      featureCollection: result.featureCollection,
    });
  },
);
