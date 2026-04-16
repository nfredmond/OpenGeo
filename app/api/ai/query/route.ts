import { NextResponse } from "next/server";
import { z } from "zod";
import { nlToSql, validateSql } from "@/lib/ai/nl-sql";
import { aiPool } from "@/lib/db/ai-pool";
import { logAiEvent } from "@/lib/ai/logger";
import { env, flag } from "@/lib/env";
import { supabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  prompt: z.string().min(1).max(2000),
});

export async function POST(req: Request) {
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
  let actorId: string | null = null;
  try {
    const supabase = await supabaseServer();
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
    await logAiEvent({
      orgId: null,
      actorId,
      kind: "nl_sql",
      model: env().ANTHROPIC_MODEL,
      prompt,
      responseSummary: `OK: ${fc.features.length} features`,
      metadata: { sql: generated.sql, rationale: generated.rationale },
    });
    return NextResponse.json({
      ok: true,
      sql: generated.sql,
      label: generated.label,
      rationale: generated.rationale,
      featureCollection: fc,
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
}
