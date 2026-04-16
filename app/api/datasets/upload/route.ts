import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FeatureCollectionSchema = z.object({
  type: z.literal("FeatureCollection"),
  features: z.array(z.unknown()).min(1),
});

const BodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  projectId: z.string().uuid().optional(),
  featureCollection: FeatureCollectionSchema,
});

const MAX_BODY_BYTES = 25 * 1024 * 1024; // 25 MB — covers typical GeoJSON; larger uploads go through the chunked path (Phase 1).

export async function POST(req: Request) {
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BODY_BYTES) {
    return NextResponse.json(
      { ok: false, error: `Payload too large (>${MAX_BODY_BYTES} bytes). Use the chunked uploader.` },
      { status: 413 },
    );
  }

  const supabase = await supabaseServer();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  }

  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "Invalid request body.", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  // Resolve the project the dataset belongs to. Default to the caller's
  // primary project if no explicit id was supplied.
  let projectId = parsed.data.projectId;
  if (!projectId) {
    const { data, error } = await supabase.rpc("default_project_for", {
      p_user_id: userData.user.id,
    });
    if (error) {
      return NextResponse.json(
        { ok: false, error: `Could not resolve default project: ${error.message}` },
        { status: 500 },
      );
    }
    if (!data) {
      return NextResponse.json(
        { ok: false, error: "You have no project to write to." },
        { status: 403 },
      );
    }
    projectId = data as string;
  }

  const { data: layerId, error } = await supabase.rpc("ingest_geojson", {
    p_project_id: projectId,
    p_name: parsed.data.name,
    p_feature_collection: parsed.data.featureCollection,
  });

  if (error) {
    const status = error.code === "42501" ? 403 : 400;
    return NextResponse.json({ ok: false, error: error.message }, { status });
  }

  return NextResponse.json({ ok: true, layerId, projectId, name: parsed.data.name });
}
