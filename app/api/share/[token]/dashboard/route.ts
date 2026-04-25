import { NextResponse } from "next/server";
import {
  dashboardWidgetsFromStored,
  defaultDashboardWidgets,
  validateDashboardWidgetLayers,
  type DashboardWidget,
} from "@/lib/dashboard";
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
  schema_version?: number | null;
  widgets?: unknown;
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

type PublicDashboardLayer = {
  id: string;
  name: string;
  geometryKind: string;
  featureCount: number;
  style: Record<string, unknown> | null;
  kind: "pmtiles";
  pmtiles: PmtilesLayerMetadata;
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
    .select(
      "id, project_id, name, layer_id, metric_kind, is_published, schema_version, widgets, updated_at",
    )
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
  const storedWidgets = dashboardWidgetsFromStored(dashboardRow.widgets, dashboardRow.layer_id);
  const requestedLayerIds = Array.from(
    new Set([dashboardRow.layer_id, ...storedWidgets.map((widget) => widget.layerId)]),
  );

  const { data: layerRows, error: layerErr } = await admin
    .schema("opengeo")
    .from("layers")
    .select(
      "id, name, geometry_kind, feature_count, style, metadata, dataset:datasets!inner (project_id, source_uri, kind)",
    )
    .in("id", requestedLayerIds);

  if (layerErr) {
    return NextResponse.json({ ok: false, error: layerErr.message }, { status: 500 });
  }

  const layerById = new Map<string, PublicDashboardLayer>();
  for (const row of (layerRows ?? []) as unknown as LayerRow[]) {
    if (row.dataset?.project_id !== tokenDetail.project_id || row.dataset.kind !== "pmtiles") {
      continue;
    }
    const pmtiles = parsePmtilesLayerMetadata(row.metadata, row.dataset.source_uri);
    if (!pmtiles) continue;
    layerById.set(row.id, {
      id: row.id,
      name: row.name,
      geometryKind: row.geometry_kind,
      featureCount: Number(row.feature_count ?? 0),
      style: row.style,
      kind: "pmtiles",
      pmtiles,
    });
  }

  const primaryLayer = layerById.get(dashboardRow.layer_id);
  if (!primaryLayer) {
    return NextResponse.json({ ok: true, dashboard: null });
  }
  const widgets = validateDashboardWidgetLayers(storedWidgets, layerById.keys())
    ? defaultDashboardWidgets(dashboardRow.layer_id)
    : storedWidgets;

  return NextResponse.json({
    ok: true,
    dashboard: buildPublicDashboard(dashboardRow, primaryLayer, widgets, layerById),
  });
});

function buildPublicDashboard(
  dashboard: DashboardRow,
  layer: PublicDashboardLayer,
  widgets: DashboardWidget[],
  layerById: Map<string, PublicDashboardLayer>,
) {
  return {
    id: dashboard.id,
    name: dashboard.name,
    layerId: layer.id,
    layerName: layer.name,
    schemaVersion: dashboard.schema_version ?? 1,
    updatedAt: dashboard.updated_at,
    metric: {
      kind: dashboard.metric_kind,
      label: "Features",
      value: layer.featureCount,
    },
    layer,
    widgets: widgets.map((widget) => buildWidget(widget, layerById)),
  };
}

function buildWidget(widget: DashboardWidget, layerById: Map<string, PublicDashboardLayer>) {
  const layer = layerById.get(widget.layerId);
  if (!layer) throw new Error(`Dashboard widget references missing layer ${widget.layerId}`);

  if (widget.type === "pmtiles_map") {
    return {
      ...widget,
      layerName: layer.name,
      layer,
    };
  }

  return {
    ...widget,
    layerName: layer.name,
    metric: {
      kind: "feature_count" as const,
      label: "Features",
      value: layer.featureCount,
    },
    series: [{ label: layer.name, value: layer.featureCount }],
  };
}
