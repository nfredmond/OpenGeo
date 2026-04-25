import { NextResponse } from "next/server";
import { withRoute } from "@/lib/observability/with-route";
import { parsePmtilesLayerMetadata, type PmtilesLayerMetadata } from "@/lib/pmtiles";
import { supabaseService } from "@/lib/supabase/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ShareTokenDetail = {
  token_id: string;
  project_id: string;
  scopes: string[] | null;
  expires_at: string | null;
};

type DashboardRow = {
  id: string;
  project_id: string;
  name: string;
  layer_id: string;
  metric_kind: "feature_count";
  is_published: boolean;
  updated_at: string;
};

type LayerRow = {
  id: string;
  name: string;
  geometry_kind: string;
  feature_count: number | string | null;
  style: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  dataset: {
    project_id: string;
    source_uri: string | null;
    kind: string | null;
  } | null;
};

// Returns the single published project dashboard, if one exists. The existing
// share token remains the only public capability; dashboard reads require the
// same read:layers scope as the PMTiles map layer they expose.
export const GET = withRoute<{ token: string }>("share.dashboard", async (_req, ctx) => {
  const { token } = await ctx.params;
  if (!token || token.length < 12 || token.length > 256) {
    return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  }

  const admin = supabaseService();
  const { data: tokenRows, error: rpcErr } = await admin
    .schema("opengeo")
    .rpc("resolve_share_token_detail", { p_token: token });
  if (rpcErr) {
    return NextResponse.json({ ok: false, error: rpcErr.message }, { status: 500 });
  }
  const tokenDetail = ((tokenRows ?? []) as ShareTokenDetail[])[0];
  if (!tokenDetail) {
    return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  }

  const scopes = tokenDetail.scopes ?? [];
  if (!scopes.includes("read:layers")) {
    return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  }

  const { data: dashboard, error: dashErr } = await admin
    .schema("opengeo")
    .from("project_dashboards")
    .select("id, project_id, name, layer_id, metric_kind, is_published, updated_at")
    .eq("project_id", tokenDetail.project_id)
    .eq("is_published", true)
    .maybeSingle();

  if (dashErr) {
    return NextResponse.json({ ok: false, error: dashErr.message }, { status: 500 });
  }
  if (!dashboard) {
    return NextResponse.json({ ok: true, dashboard: null });
  }

  const dashboardRow = dashboard as DashboardRow;
  const { data: layer, error: layerErr } = await admin
    .schema("opengeo")
    .from("layers")
    .select(
      "id, name, geometry_kind, feature_count, style, metadata, dataset:datasets!inner (project_id, source_uri, kind)",
    )
    .eq("id", dashboardRow.layer_id)
    .maybeSingle();

  if (layerErr) {
    return NextResponse.json({ ok: false, error: layerErr.message }, { status: 500 });
  }
  if (!layer) {
    return NextResponse.json({ ok: true, dashboard: null });
  }

  const layerRow = layer as unknown as LayerRow;
  if (layerRow.dataset?.project_id !== tokenDetail.project_id || layerRow.dataset.kind !== "pmtiles") {
    return NextResponse.json({ ok: true, dashboard: null });
  }

  const pmtiles = parsePmtilesLayerMetadata(layerRow.metadata, layerRow.dataset.source_uri);
  if (!pmtiles) {
    return NextResponse.json({ ok: true, dashboard: null });
  }

  return NextResponse.json({
    ok: true,
    dashboard: buildPublicDashboard(dashboardRow, layerRow, pmtiles),
  });
});

function buildPublicDashboard(
  dashboard: DashboardRow,
  layer: LayerRow,
  pmtiles: PmtilesLayerMetadata,
) {
  const featureCount = Number(layer.feature_count ?? 0);
  return {
    id: dashboard.id,
    name: dashboard.name,
    layerId: layer.id,
    layerName: layer.name,
    updatedAt: dashboard.updated_at,
    metric: {
      kind: dashboard.metric_kind,
      label: "Features",
      value: featureCount,
    },
    layer: {
      id: layer.id,
      name: layer.name,
      geometryKind: layer.geometry_kind,
      featureCount,
      style: layer.style,
      kind: "pmtiles",
      pmtiles,
    },
  };
}
