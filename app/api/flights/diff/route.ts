import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseService } from "@/lib/supabase/service";
import { withRoute } from "@/lib/observability/with-route";
import { diffFeatures } from "@/lib/change-detection/feature-diff";
import { narrateDiff } from "@/lib/change-detection/narrate";
import { logAiEvent } from "@/lib/ai/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Large diffs + an AI narration round-trip can spend 10–30s on the Anthropic
// call; keep headroom so we're not chopping long narrations.
export const maxDuration = 120;

const BodySchema = z.object({
  fromLayerId: z.string().uuid(),
  toLayerId: z.string().uuid(),
  outputName: z.string().trim().min(1).max(120).optional(),
  thresholds: z
    .object({
      distanceMeters: z.number().positive().max(10_000).optional(),
      iouThreshold: z.number().min(0).max(1).optional(),
      modifiedDistanceMeters: z.number().positive().max(10_000).optional(),
      watchedKeys: z.array(z.string()).max(32).optional(),
    })
    .optional(),
});

type LayerRow = {
  id: string;
  name: string;
  dataset: { id: string; project_id: string };
};

export const POST = withRoute("flights.diff", async (req) => {
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
  const { fromLayerId, toLayerId, outputName, thresholds } = bodyParsed.data;
  if (fromLayerId === toLayerId) {
    return NextResponse.json(
      { ok: false, error: "fromLayerId and toLayerId must differ." },
      { status: 400 },
    );
  }

  // Resolve both layers under RLS — if the caller can't read a layer, this
  // returns null and we 404 without disclosing existence in another project.
  const [fromLayer, toLayer] = await Promise.all([
    fetchLayer(supabase, fromLayerId),
    fetchLayer(supabase, toLayerId),
  ]);
  if (!fromLayer || !toLayer) {
    return NextResponse.json({ ok: false, error: "Layer not found." }, { status: 404 });
  }
  if (fromLayer.dataset.project_id !== toLayer.dataset.project_id) {
    // Cross-project diff isn't meaningful and would confuse the audit log.
    return NextResponse.json(
      { ok: false, error: "Both layers must belong to the same project." },
      { status: 400 },
    );
  }

  // Pull feature collections via the existing RPC. `layer_as_geojson` runs
  // under RLS too, so a layer the caller can't read returns an empty FC.
  const [fromFcRes, toFcRes] = await Promise.all([
    supabase.schema("opengeo").rpc("layer_as_geojson", { p_layer_id: fromLayerId }),
    supabase.schema("opengeo").rpc("layer_as_geojson", { p_layer_id: toLayerId }),
  ]);
  if (fromFcRes.error || toFcRes.error) {
    return NextResponse.json(
      { ok: false, error: (fromFcRes.error ?? toFcRes.error)!.message },
      { status: 500 },
    );
  }
  const fromFc = fromFcRes.data as GeoJSON.FeatureCollection;
  const toFc = toFcRes.data as GeoJSON.FeatureCollection;
  if ((fromFc?.features?.length ?? 0) === 0 || (toFc?.features?.length ?? 0) === 0) {
    return NextResponse.json(
      { ok: false, error: "Both layers must contain at least one feature." },
      { status: 400 },
    );
  }

  const diff = diffFeatures(fromFc, toFc, thresholds ?? {});

  // Edge case: nothing changed. Writing a zero-feature layer would fail inside
  // ingest_geojson's "no valid features" guard, so short-circuit with a clear
  // response and still log an ai_event for visibility.
  if (diff.featureCollection.features.length === 0) {
    await logAiEvent({
      orgId: null,
      actorId: userData.user.id,
      kind: "change_detect",
      model: "feature-diff",
      prompt: `${fromLayer.name} → ${toLayer.name}`,
      responseSummary: "No changes detected.",
      metadata: {
        fromLayerId,
        toLayerId,
        projectId: fromLayer.dataset.project_id,
        counts: diff.counts,
        thresholds: diff.thresholdsUsed,
      },
    });
    return NextResponse.json({
      ok: true,
      layerId: null,
      counts: diff.counts,
      thresholdsUsed: diff.thresholdsUsed,
      narrative: null,
    });
  }

  const layerName =
    outputName ?? `Δ ${fromLayer.name} → ${toLayer.name}`.slice(0, 120);
  const { data: layerId, error: ingestErr } = await supabase
    .schema("opengeo")
    .rpc("ingest_geojson", {
      p_project_id: fromLayer.dataset.project_id,
      p_name: layerName,
      p_feature_collection: diff.featureCollection,
    });
  if (ingestErr) {
    const status = ingestErr.code === "42501" ? 403 : 400;
    return NextResponse.json({ ok: false, error: ingestErr.message }, { status });
  }

  await logAiEvent({
    orgId: null,
    actorId: userData.user.id,
    kind: "change_detect",
    model: "feature-diff",
    prompt: `${fromLayer.name} → ${toLayer.name}`,
    responseSummary: `added=${diff.counts.added} removed=${diff.counts.removed} modified=${diff.counts.modified}`,
    metadata: {
      fromLayerId,
      toLayerId,
      projectId: fromLayer.dataset.project_id,
      outputLayerId: layerId,
      counts: diff.counts,
      thresholds: diff.thresholdsUsed,
    },
  });

  // Narration runs best-effort. A failure here must not poison the diff —
  // the layer is already persisted.
  let narrative: { text: string; model: string } | null = null;
  try {
    const samples = pickSamples(diff.featureCollection);
    const out = await narrateDiff({
      fromLayerName: fromLayer.name,
      toLayerName: toLayer.name,
      counts: diff.counts,
      thresholdsUsed: diff.thresholdsUsed,
      samples,
    });
    narrative = out;

    // Persist the narrative on the diff layer itself so the public share view
    // can render it. Uses the service client because the diff layer has
    // already been created by the authorized ingest_geojson call above.
    await supabaseService()
      .schema("opengeo")
      .from("layers")
      .update({
        metadata: {
          change_detection: {
            from_layer_id: fromLayerId,
            to_layer_id: toLayerId,
            counts: diff.counts,
            thresholds: diff.thresholdsUsed,
            narrative: out.text,
            narrated_at: new Date().toISOString(),
            model: out.model,
          },
        },
      })
      .eq("id", layerId);

    await logAiEvent({
      orgId: null,
      actorId: userData.user.id,
      kind: "change_narrate",
      model: out.model,
      prompt: `${fromLayer.name} → ${toLayer.name}`,
      responseSummary: out.text.slice(0, 240),
      metadata: {
        fromLayerId,
        toLayerId,
        outputLayerId: layerId,
        counts: diff.counts,
      },
    });
  } catch (e) {
    console.error("change-detection narration failed:", (e as Error).message);
  }

  return NextResponse.json({
    ok: true,
    layerId,
    counts: diff.counts,
    thresholdsUsed: diff.thresholdsUsed,
    featureCollection: diff.featureCollection,
    narrative: narrative?.text ?? null,
  });
});

async function fetchLayer(
  supabase: Awaited<ReturnType<typeof supabaseServer>>,
  layerId: string,
): Promise<LayerRow | null> {
  const { data, error } = await supabase
    .schema("opengeo")
    .from("layers")
    .select(
      `
      id,
      name,
      dataset:datasets!inner ( id, project_id )
    `,
    )
    .eq("id", layerId)
    .maybeSingle<LayerRow>();
  if (error || !data) return null;
  return data;
}

// Pull ≤2 example features per change category so the narrator has flavor
// without shipping full payloads to the model.
function pickSamples(
  fc: GeoJSON.FeatureCollection,
): Array<{ changeType: "added" | "removed" | "modified"; properties: Record<string, unknown> }> {
  const byKind: Record<string, number> = { added: 0, removed: 0, modified: 0 };
  const out: Array<{ changeType: "added" | "removed" | "modified"; properties: Record<string, unknown> }> = [];
  for (const f of fc.features) {
    const kind = (f.properties as { change_type?: string } | null)?.change_type;
    if (kind !== "added" && kind !== "removed" && kind !== "modified") continue;
    if (byKind[kind] >= 2) continue;
    byKind[kind]++;
    out.push({
      changeType: kind,
      properties: stripChangeMeta((f.properties ?? {}) as Record<string, unknown>),
    });
    if (out.length >= 6) break;
  }
  return out;
}

function stripChangeMeta(props: Record<string, unknown>): Record<string, unknown> {
  const { change_type: _ct, source_feature_id: _sf, ...rest } = props;
  void _ct;
  void _sf;
  return rest;
}
