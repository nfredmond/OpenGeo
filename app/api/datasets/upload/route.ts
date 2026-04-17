import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { withRoute } from "@/lib/observability/with-route";
import { decodeShapefileZip } from "@/lib/ingest/decode-shapefile";
import {
  firstCoordinate,
  reprojectFeatureCollection,
} from "@/lib/ingest/reproject";
import { detectCrs, inferColumnTypes } from "@/lib/ai/data-cleaning";
import { logAiEvent } from "@/lib/ai/logger";

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

export const POST = withRoute("datasets.upload", async (req) => {
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

  const contentType = req.headers.get("content-type") ?? "";
  const actorId = userData.user.id;

  if (contentType.startsWith("multipart/form-data")) {
    return handleShapefileUpload(req, supabase, actorId);
  }

  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "Invalid request body.", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const projectId = await resolveProjectId(supabase, parsed.data.projectId, actorId);
  if ("error" in projectId) {
    return NextResponse.json({ ok: false, error: projectId.error }, { status: projectId.status });
  }

  const { data: layerId, error } = await supabase.rpc("ingest_geojson", {
    p_project_id: projectId.id,
    p_name: parsed.data.name,
    p_feature_collection: parsed.data.featureCollection,
  });

  if (error) {
    const status = error.code === "42501" ? 403 : 400;
    return NextResponse.json({ ok: false, error: error.message }, { status });
  }

  return NextResponse.json({ ok: true, layerId, projectId: projectId.id, name: parsed.data.name });
});

async function handleShapefileUpload(
  req: Request,
  supabase: Awaited<ReturnType<typeof supabaseServer>>,
  actorId: string,
) {
  const form = await req.formData();
  const file = form.get("file");
  const rawName = form.get("name");
  const rawProjectId = form.get("projectId");

  if (!(file instanceof File)) {
    return NextResponse.json(
      { ok: false, error: "Multipart upload requires a 'file' field containing a .zip shapefile." },
      { status: 400 },
    );
  }
  const name =
    typeof rawName === "string" && rawName.trim().length > 0
      ? rawName.trim()
      : file.name.replace(/\.zip$/i, "");
  if (!name || name.length > 120) {
    return NextResponse.json(
      { ok: false, error: "Provide a 'name' field (<=120 chars)." },
      { status: 400 },
    );
  }
  const projectId = await resolveProjectId(
    supabase,
    typeof rawProjectId === "string" && rawProjectId.length > 0 ? rawProjectId : undefined,
    actorId,
  );
  if ("error" in projectId) {
    return NextResponse.json({ ok: false, error: projectId.error }, { status: projectId.status });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  let decoded;
  try {
    decoded = await decodeShapefileZip(bytes);
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `Shapefile decode failed: ${(e as Error).message}` },
      { status: 400 },
    );
  }
  if (decoded.featureCollection.features.length === 0) {
    return NextResponse.json(
      { ok: false, error: "Shapefile parsed but contained zero features." },
      { status: 400 },
    );
  }

  const crs = detectCrs({
    prjWkt: decoded.prjWkt,
    firstCoord: firstCoordinate(decoded.featureCollection),
  });
  if (!crs.ok) {
    return NextResponse.json(
      { ok: false, error: `CRS detect failed: ${crs.reason}` },
      { status: 400 },
    );
  }

  // Log the CRS decision before doing anything destructive so a reviewer
  // can audit it even if the downstream insert fails.
  await logAiEvent({
    orgId: null,
    actorId,
    kind: "crs_detect",
    model: "opengeo-ingest-v1",
    prompt: decoded.prjWkt?.slice(0, 1000),
    responseSummary: crs.detail,
    metadata: {
      source: crs.source,
      epsg: crs.epsg,
      componentsFound: decoded.componentsFound,
      fileName: file.name,
      layerName: name,
    },
  });

  const fc =
    crs.proj4Def === "EPSG:4326"
      ? decoded.featureCollection
      : reprojectFeatureCollection(decoded.featureCollection, crs.proj4Def, "EPSG:4326");

  const typeHints = inferColumnTypes(fc.features);
  await logAiEvent({
    orgId: null,
    actorId,
    kind: "column_type_infer",
    model: "opengeo-ingest-v1",
    responseSummary: `Inferred ${typeHints.length} column type(s) from up to 200 features.`,
    metadata: {
      hints: typeHints,
      fileName: file.name,
      layerName: name,
    },
  });

  const { data: layerId, error } = await supabase.rpc("ingest_geojson", {
    p_project_id: projectId.id,
    p_name: name,
    p_feature_collection: fc,
  });

  if (error) {
    const status = error.code === "42501" ? 403 : 400;
    return NextResponse.json({ ok: false, error: error.message }, { status });
  }

  return NextResponse.json({
    ok: true,
    layerId,
    projectId: projectId.id,
    name,
    crs: {
      source: crs.source,
      epsg: crs.epsg,
      detail: crs.detail,
    },
    columns: typeHints.map((h) => ({
      field: h.field,
      inferred: h.inferred,
      confidence: h.confidence,
      distinctCount: h.distinctCount,
    })),
    shapefileComponents: decoded.componentsFound,
  });
}

async function resolveProjectId(
  supabase: Awaited<ReturnType<typeof supabaseServer>>,
  explicit: string | undefined,
  actorId: string,
): Promise<{ id: string } | { error: string; status: number }> {
  if (explicit) return { id: explicit };
  const { data, error } = await supabase.rpc("default_project_for", {
    p_user_id: actorId,
  });
  if (error) {
    return { error: `Could not resolve default project: ${error.message}`, status: 500 };
  }
  if (!data) {
    return { error: "You have no project to write to.", status: 403 };
  }
  return { id: data as string };
}
