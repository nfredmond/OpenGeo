import { NextResponse } from "next/server";
import { z } from "zod";
import { nlToSql, validateSql } from "@/lib/ai/nl-sql";
import { aiPool } from "@/lib/db/ai-pool";
import { logAiEvent } from "@/lib/ai/logger";
import { env, flag } from "@/lib/env";
import { supabaseServer } from "@/lib/supabase/server";
import { withRoute } from "@/lib/observability/with-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  prompt: z.string().min(1).max(2000),
});

export const POST = withRoute("ai.query", async (req) => {
  if (!flag.aiNlSql()) {
    return NextResponse.json(
      { ok: false, error: "NL→SQL is disabled (FEATURE_AI_NL_SQL=false)." },
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

  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "Invalid request body." },
      { status: 400 },
    );
  }

  // Resolve the signed-in user (best-effort). Audit logging uses this when
  // present; the query itself runs against the read-only role regardless.
  // We hoist the client so the happy-path branch can reuse it to persist the
  // result as a layer via ingest_geojson.
  const supabase = await supabaseServer();
  let actorId: string | null = null;
  try {
    const { data } = await supabase.auth.getUser();
    actorId = data.user?.id ?? null;
  } catch {
    // No session — allow anonymous querying in dev.
  }

  const { prompt } = parsed.data;

  let generated;
  try {
    generated = await nlToSql(prompt);
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `LLM error: ${(e as Error).message}` },
      { status: 502 },
    );
  }

  const gate = validateSql(generated.sql);
  if (!gate.ok) {
    await logAiEvent({
      orgId: null,
      actorId,
      kind: "nl_sql",
      model: env().ANTHROPIC_MODEL,
      prompt,
      responseSummary: `REJECTED: ${gate.reason}`,
      metadata: { sql: generated.sql },
    });
    return NextResponse.json(
      { ok: false, error: gate.reason, sql: generated.sql },
      { status: 422 },
    );
  }

  // Wrap the query in ST_AsGeoJSON so we can stream features back to the
  // client without an extra serialization step.
  const wrapped = `
    with inner_q as (${generated.sql.trim().replace(/;+\s*$/, "")})
    select
      jsonb_build_object(
        'type', 'Feature',
        'geometry', ST_AsGeoJSON(ST_Transform(geom, 4326))::jsonb,
        'properties', to_jsonb(inner_q) - 'geom'
      ) as feature
    from inner_q
    where geom is not null
  `;

  try {
    const result = await aiPool().query(wrapped);
    const fc: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: result.rows.map((r) => r.feature),
    };

    // Best-effort persistence: if the caller is signed in and has a default
    // project, mirror uploads and extractions by writing the result as a
    // layer via opengeo.ingest_geojson. Preview is the primary contract —
    // never fail the response because of a persistence error.
    let layerId: string | null = null;
    let warning: string | null = null;
    if (fc.features.length === 0) {
      warning = "Query returned zero features — not saved.";
    } else if (!actorId) {
      warning = "Sign in to save AI queries as layers.";
    } else {
      const { data: projectId, error: projectErr } = await supabase.rpc(
        "default_project_for",
        { p_user_id: actorId },
      );
      if (projectErr) {
        console.error("ai/query: default_project_for failed:", projectErr);
        warning = `Persist failed: ${projectErr.message}`;
      } else if (!projectId) {
        warning = "No default project found — result not saved.";
      } else {
        const { data: newLayerId, error: ingestErr } = await supabase.rpc(
          "ingest_geojson",
          {
            p_project_id: projectId,
            p_name: generated.label,
            p_feature_collection: fc,
          },
        );
        if (ingestErr) {
          console.error("ai/query: ingest_geojson failed:", ingestErr);
          warning = `Persist failed: ${ingestErr.message}`;
        } else {
          layerId = newLayerId as string;
        }
      }
    }

    await logAiEvent({
      orgId: null,
      actorId,
      kind: "nl_sql",
      model: env().ANTHROPIC_MODEL,
      prompt,
      responseSummary: `OK: ${fc.features.length} features`,
      metadata: {
        sql: generated.sql,
        rationale: generated.rationale,
        layerId,
      },
    });
    return NextResponse.json({
      ok: true,
      sql: generated.sql,
      label: generated.label,
      rationale: generated.rationale,
      featureCollection: fc,
      layerId,
      warning,
    });
  } catch (e) {
    const msg = (e as Error).message;
    await logAiEvent({
      orgId: null,
      actorId,
      kind: "nl_sql",
      model: env().ANTHROPIC_MODEL,
      prompt,
      responseSummary: `DB_ERROR: ${msg}`,
      metadata: { sql: generated.sql },
    });
    return NextResponse.json(
      { ok: false, error: `DB error: ${msg}`, sql: generated.sql },
      { status: 500 },
    );
  }
});
