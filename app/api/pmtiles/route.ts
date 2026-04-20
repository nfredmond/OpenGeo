import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { withRoute } from "@/lib/observability/with-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GeometryKind = z.enum([
  "point",
  "multipoint",
  "linestring",
  "multilinestring",
  "polygon",
  "multipolygon",
  "geometrycollection",
]);

const BboxSchema = z
  .tuple([z.number(), z.number(), z.number(), z.number()])
  .refine(([west, south, east, north]) => west < east && south < north, {
    message: "bbox must be [west, south, east, north].",
  });

const RegisterBody = z.object({
  projectId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(120),
  url: z.string().trim().url().max(2048),
  sourceLayer: z.string().trim().min(1).max(120).default("default"),
  geometryKind: GeometryKind.default("geometrycollection"),
  featureCount: z.number().int().nonnegative().default(0),
  minzoom: z.number().int().min(0).max(24).default(0),
  maxzoom: z.number().int().min(0).max(24).default(14),
  bbox: BboxSchema.optional(),
  attribution: z.string().trim().max(300).optional(),
});

export const POST = withRoute("pmtiles.register", async (req) => {
  const supabase = await supabaseServer();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  }

  const parsed = RegisterBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "Invalid request body.", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const archiveUrl = new URL(parsed.data.url);
  if (archiveUrl.protocol !== "https:" && archiveUrl.protocol !== "http:") {
    return NextResponse.json(
      { ok: false, error: "PMTiles URL must use http or https." },
      { status: 400 },
    );
  }
  if (!archiveUrl.pathname.toLowerCase().endsWith(".pmtiles")) {
    return NextResponse.json(
      { ok: false, error: "PMTiles URL must point to a .pmtiles archive." },
      { status: 400 },
    );
  }

  const projectId = await resolveProjectId(
    supabase,
    parsed.data.projectId,
    userData.user.id,
  );
  if ("error" in projectId) {
    return NextResponse.json({ ok: false, error: projectId.error }, { status: projectId.status });
  }

  const pmtilesMetadata = {
    url: parsed.data.url,
    sourceLayer: parsed.data.sourceLayer,
    bbox: parsed.data.bbox ?? null,
    minzoom: parsed.data.minzoom,
    maxzoom: parsed.data.maxzoom,
    attribution: parsed.data.attribution ?? null,
  };

  const { data: dataset, error: datasetErr } = await supabase
    .schema("opengeo")
    .from("datasets")
    .insert({
      project_id: projectId.id,
      name: parsed.data.name,
      kind: "pmtiles",
      source_uri: parsed.data.url,
      crs: 3857,
      metadata: { pmtiles: pmtilesMetadata },
      attribution: parsed.data.attribution ?? null,
    })
    .select("id")
    .single();

  if (datasetErr) {
    const status = datasetErr.code === "42501" ? 403 : 400;
    return NextResponse.json({ ok: false, error: datasetErr.message }, { status });
  }

  const { data: layer, error: layerErr } = await supabase
    .schema("opengeo")
    .from("layers")
    .insert({
      dataset_id: dataset.id,
      name: parsed.data.name,
      geometry_kind: parsed.data.geometryKind,
      feature_count: parsed.data.featureCount,
      metadata: { pmtiles: pmtilesMetadata },
    })
    .select("id, name, geometry_kind, feature_count, style, metadata")
    .single();

  if (layerErr) {
    const status = layerErr.code === "42501" ? 403 : 400;
    return NextResponse.json({ ok: false, error: layerErr.message }, { status });
  }

  return NextResponse.json({
    ok: true,
    projectId: projectId.id,
    datasetId: dataset.id,
    layer,
    pmtiles: pmtilesMetadata,
  });
});

async function resolveProjectId(
  supabase: Awaited<ReturnType<typeof supabaseServer>>,
  explicit: string | undefined,
  actorId: string,
): Promise<{ id: string } | { error: string; status: number }> {
  if (explicit) return { id: explicit };
  const { data, error } = await supabase
    .schema("opengeo")
    .rpc("default_project_for", {
      p_user_id: actorId,
    });
  if (error) {
    return { error: `Could not resolve default project: ${error.message}`, status: 500 };
  }
  if (!data) {
    return { error: "You have no project to publish to.", status: 403 };
  }
  return { id: data as string };
}
