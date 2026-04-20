import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { withRoute } from "@/lib/observability/with-route";
import {
  PmtilesGeneratorError,
  publishGeoJsonAsPmtiles,
  TippecanoeError,
} from "@/lib/pmtiles-publish";
import { R2ConfigError, R2UploadError } from "@/lib/r2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PublishBody = z
  .object({
    layerId: z.string().uuid(),
    projectId: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(120).optional(),
    sourceLayer: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[A-Za-z0-9_-]+$/, {
        message: "sourceLayer may contain only letters, numbers, underscores, and hyphens.",
      })
      .default("layer"),
    minzoom: z.number().int().min(0).max(24).default(0),
    maxzoom: z.number().int().min(0).max(24).default(14),
  })
  .refine((body) => body.minzoom <= body.maxzoom, {
    message: "minzoom must be less than or equal to maxzoom.",
    path: ["minzoom"],
  });

type LayerRow = {
  id: string;
  name: string;
  geometry_kind: string;
  feature_count: number;
  style: Record<string, unknown> | null;
  dataset:
    | {
        id: string;
        project_id: string;
        name: string;
        kind: string;
      }
    | Array<{
        id: string;
        project_id: string;
        name: string;
        kind: string;
      }>
    | null;
};

export const POST = withRoute("pmtiles.publish", async (req) => {
  const supabase = await supabaseServer();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  }

  const parsed = PublishBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "Invalid request body.", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { data: layer, error: layerErr } = await supabase
    .schema("opengeo")
    .from("layers")
    .select(
      "id, name, geometry_kind, feature_count, style, dataset:datasets!inner (id, project_id, name, kind)",
    )
    .eq("id", parsed.data.layerId)
    .single<LayerRow>();

  if (layerErr || !layer) {
    const status = layerErr?.code === "PGRST116" ? 404 : 400;
    return NextResponse.json(
      { ok: false, error: layerErr?.message ?? "Layer not found." },
      { status },
    );
  }

  const dataset = Array.isArray(layer.dataset) ? layer.dataset[0] : layer.dataset;
  if (!dataset) {
    return NextResponse.json({ ok: false, error: "Layer has no dataset." }, { status: 400 });
  }
  if (parsed.data.projectId && parsed.data.projectId !== dataset.project_id) {
    return NextResponse.json(
      { ok: false, error: "Layer does not belong to the requested project." },
      { status: 404 },
    );
  }
  if (dataset.kind === "pmtiles") {
    return NextResponse.json(
      { ok: false, error: "This layer is already backed by PMTiles." },
      { status: 400 },
    );
  }

  const { data: canEdit, error: accessErr } = await supabase
    .schema("opengeo")
    .rpc("has_project_access", {
      target_project: dataset.project_id,
      min_role: "editor",
    });
  if (accessErr) {
    return NextResponse.json({ ok: false, error: accessErr.message }, { status: 500 });
  }
  if (!canEdit) {
    return NextResponse.json({ ok: false, error: "Not authorized." }, { status: 403 });
  }

  const { data: featureCollection, error: geojsonErr } = await supabase
    .schema("opengeo")
    .rpc("layer_as_geojson", {
      p_layer_id: layer.id,
    });
  if (geojsonErr) {
    return NextResponse.json({ ok: false, error: geojsonErr.message }, { status: 400 });
  }
  if (!isFeatureCollection(featureCollection) || featureCollection.features.length === 0) {
    return NextResponse.json(
      { ok: false, error: "Layer has no vector features to publish." },
      { status: 400 },
    );
  }

  const publishName = parsed.data.name ?? `${layer.name} PMTiles`;
  let published;
  try {
    published = await publishGeoJsonAsPmtiles({
      featureCollection,
      layerId: layer.id,
      name: publishName,
      sourceLayer: parsed.data.sourceLayer,
      minzoom: parsed.data.minzoom,
      maxzoom: parsed.data.maxzoom,
    });
  } catch (error) {
    const mapped = mapPublishError(error);
    return NextResponse.json({ ok: false, error: mapped.error }, { status: mapped.status });
  }

  const pmtilesMetadata = {
    url: published.url,
    sourceLayer: parsed.data.sourceLayer,
    bbox: featureCollectionBbox(featureCollection),
    minzoom: parsed.data.minzoom,
    maxzoom: parsed.data.maxzoom,
    attribution: null,
    generatedFromLayerId: layer.id,
    objectKey: published.key,
    bytes: published.bytes,
  };

  const { data: pmtilesDataset, error: datasetErr } = await supabase
    .schema("opengeo")
    .from("datasets")
    .insert({
      project_id: dataset.project_id,
      name: publishName,
      kind: "pmtiles",
      source_uri: published.url,
      crs: 3857,
      metadata: { pmtiles: pmtilesMetadata },
    })
    .select("id")
    .single();
  if (datasetErr) {
    const status = datasetErr.code === "42501" ? 403 : 400;
    return NextResponse.json({ ok: false, error: datasetErr.message }, { status });
  }

  const { data: publishedLayer, error: publishedLayerErr } = await supabase
    .schema("opengeo")
    .from("layers")
    .insert({
      dataset_id: pmtilesDataset.id,
      name: publishName,
      geometry_kind: layer.geometry_kind,
      feature_count: layer.feature_count,
      style: layer.style,
      metadata: { pmtiles: pmtilesMetadata },
    })
    .select("id, name, geometry_kind, feature_count, style, metadata")
    .single();
  if (publishedLayerErr) {
    const status = publishedLayerErr.code === "42501" ? 403 : 400;
    return NextResponse.json({ ok: false, error: publishedLayerErr.message }, { status });
  }

  return NextResponse.json({
    ok: true,
    projectId: dataset.project_id,
    datasetId: pmtilesDataset.id,
    sourceLayerId: layer.id,
    layer: publishedLayer,
    pmtiles: pmtilesMetadata,
  });
});

function mapPublishError(error: unknown): { status: number; error: string } {
  if (error instanceof R2ConfigError) {
    return { status: 503, error: error.message };
  }
  if (error instanceof TippecanoeError) {
    return { status: 503, error: error.message };
  }
  if (error instanceof PmtilesGeneratorError) {
    return { status: 502, error: error.message };
  }
  if (error instanceof R2UploadError) {
    return { status: 502, error: error.message };
  }
  return {
    status: 500,
    error: error instanceof Error ? error.message : "PMTiles publish failed.",
  };
}

function isFeatureCollection(value: unknown): value is GeoJSON.FeatureCollection {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "FeatureCollection" &&
    Array.isArray((value as { features?: unknown }).features)
  );
}

function featureCollectionBbox(
  featureCollection: GeoJSON.FeatureCollection,
): [number, number, number, number] | null {
  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;

  for (const feature of featureCollection.features) {
    visitCoordinates(feature.geometry, (x, y) => {
      west = Math.min(west, x);
      south = Math.min(south, y);
      east = Math.max(east, x);
      north = Math.max(north, y);
    });
  }

  if (![west, south, east, north].every(Number.isFinite)) return null;
  return [west, south, east, north];
}

function visitCoordinates(
  geometry: GeoJSON.Geometry | null,
  visit: (x: number, y: number) => void,
) {
  if (!geometry) return;
  if (geometry.type === "GeometryCollection") {
    for (const child of geometry.geometries) visitCoordinates(child, visit);
    return;
  }
  visitPositionArray(geometry.coordinates, visit);
}

function visitPositionArray(value: unknown, visit: (x: number, y: number) => void) {
  if (!Array.isArray(value)) return;
  if (
    value.length >= 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number"
  ) {
    visit(value[0], value[1]);
    return;
  }
  for (const child of value) visitPositionArray(child, visit);
}
