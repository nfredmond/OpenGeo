import { NextResponse } from "next/server";
import { supabaseService } from "@/lib/supabase/service";
import { withRoute } from "@/lib/observability/with-route";
import { parsePmtilesLayerMetadata } from "@/lib/pmtiles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ShareTokenDetail = {
  token_id: string;
  project_id: string;
  scopes: string[] | null;
  expires_at: string | null;
};

// Returns the read-only layer list + feature collections for a shared
// project. Access is gated by the share token — no auth required.
// 404 on invalid/expired/revoked token.
export const GET = withRoute<{ token: string }>("share.layers", async (_req, ctx) => {
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

  // Enforce scope from the exact token row that matched the bearer token.
  const scopes = tokenDetail.scopes ?? [];
  if (!scopes.includes("read:layers")) {
    return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  }

  // Walk datasets → layers. Use the service role to bypass RLS since the
  // token itself is the capability check.
  const { data: datasets, error: dsErr } = await admin
    .schema("opengeo")
    .from("datasets")
    .select("id")
    .eq("project_id", tokenDetail.project_id);
  if (dsErr) {
    return NextResponse.json({ ok: false, error: dsErr.message }, { status: 500 });
  }
  const datasetIds = (datasets ?? []).map((d) => (d as { id: string }).id);
  if (datasetIds.length === 0) {
    return NextResponse.json({ ok: true, layers: [] });
  }

  const { data: layerRows, error: layerErr } = await admin
    .schema("opengeo")
    .from("layers")
    .select("id, name, geometry_kind, feature_count, style, metadata, updated_at, dataset:datasets!inner (source_uri, kind)")
    .in("dataset_id", datasetIds)
    .order("updated_at", { ascending: false });
  if (layerErr) {
    return NextResponse.json({ ok: false, error: layerErr.message }, { status: 500 });
  }

  // Fetch feature collections in parallel. Each via layer_as_geojson RPC.
  const layers = await Promise.all(
    (layerRows ?? []).map(async (row) => {
      const layer = row as unknown as {
        id: string;
        name: string;
        geometry_kind: string;
        feature_count: number;
        style: Record<string, unknown> | null;
        metadata: Record<string, unknown> | null;
        dataset: { source_uri: string | null; kind: string | null } | null;
        updated_at: string;
      };
      const pmtiles = layer.dataset?.kind === "pmtiles"
        ? parsePmtilesLayerMetadata(layer.metadata, layer.dataset.source_uri)
        : null;
      if (pmtiles) {
        return {
          id: layer.id,
          name: layer.name,
          geometryKind: layer.geometry_kind,
          featureCount: layer.feature_count,
          style: layer.style,
          kind: "pmtiles",
          pmtiles,
        };
      }
      const { data: fc } = await admin
        .schema("opengeo")
        .rpc("layer_as_geojson", { p_layer_id: layer.id });
      return {
        id: layer.id,
        name: layer.name,
        geometryKind: layer.geometry_kind,
        featureCount: layer.feature_count,
        style: layer.style,
        featureCollection: fc ?? { type: "FeatureCollection", features: [] },
      };
    }),
  );

  return NextResponse.json({ ok: true, layers });
});
