import { NextResponse } from "next/server";
import { supabaseService } from "@/lib/supabase/service";
import { withRoute } from "@/lib/observability/with-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Returns the read-only layer list + feature collections for a shared
// project. Access is gated by the share token — no auth required.
// 404 on invalid/expired/revoked token.
export const GET = withRoute<{ token: string }>("share.layers", async (_req, ctx) => {
  const { token } = await ctx.params;
  if (!token || token.length < 12 || token.length > 256) {
    return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  }

  const admin = supabaseService();
  const { data: projectId, error: rpcErr } = await admin
    .schema("opengeo")
    .rpc("resolve_share_token", { p_token: token });
  if (rpcErr) {
    return NextResponse.json({ ok: false, error: rpcErr.message }, { status: 500 });
  }
  if (!projectId) {
    return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  }

  // Enforce scope: only tokens with read:layers may list layers.
  const { data: tokenRow } = await admin
    .schema("opengeo")
    .from("project_share_tokens")
    .select("scopes")
    .eq("project_id", projectId as string)
    .is("revoked_at", null)
    .limit(1)
    .maybeSingle();
  const scopes = ((tokenRow as { scopes: string[] | null } | null)?.scopes ?? []) as string[];
  if (!scopes.includes("read:layers")) {
    return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  }

  // Walk datasets → layers. Use the service role to bypass RLS since the
  // token itself is the capability check.
  const { data: datasets, error: dsErr } = await admin
    .schema("opengeo")
    .from("datasets")
    .select("id")
    .eq("project_id", projectId as string);
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
    .select("id, name, geometry_kind, feature_count, style, updated_at")
    .in("dataset_id", datasetIds)
    .order("updated_at", { ascending: false });
  if (layerErr) {
    return NextResponse.json({ ok: false, error: layerErr.message }, { status: 500 });
  }

  // Fetch feature collections in parallel. Each via layer_as_geojson RPC.
  const layers = await Promise.all(
    (layerRows ?? []).map(async (row) => {
      const layer = row as {
        id: string;
        name: string;
        geometry_kind: string;
        feature_count: number;
        style: Record<string, unknown> | null;
        updated_at: string;
      };
      const { data: fc } = await admin.rpc("layer_as_geojson", { p_layer_id: layer.id });
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
