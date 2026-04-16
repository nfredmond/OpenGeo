import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { withRoute } from "@/lib/observability/with-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid() });

export const GET = withRoute<{ id: string }>("layers.get", async (_req, ctx) => {
  const rawParams = await ctx.params;
  const parsed = ParamsSchema.safeParse(rawParams);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "Invalid layer id." }, { status: 400 });
  }

  const supabase = await supabaseServer();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  }

  const { data: layer, error: layerErr } = await supabase
    .schema("opengeo")
    .from("layers")
    .select("id, name, geometry_kind, feature_count")
    .eq("id", parsed.data.id)
    .maybeSingle();

  if (layerErr) return NextResponse.json({ ok: false, error: layerErr.message }, { status: 500 });
  if (!layer) return NextResponse.json({ ok: false, error: "Layer not found." }, { status: 404 });

  const { data: fc, error: fcErr } = await supabase.rpc("layer_as_geojson", {
    p_layer_id: parsed.data.id,
  });
  if (fcErr) {
    return NextResponse.json({ ok: false, error: fcErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, layer, featureCollection: fc });
});

export const DELETE = withRoute<{ id: string }>("layers.delete", async (_req, ctx) => {
  const rawParams = await ctx.params;
  const parsed = ParamsSchema.safeParse(rawParams);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "Invalid layer id." }, { status: 400 });
  }

  const supabase = await supabaseServer();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  }

  const { error } = await supabase
    .schema("opengeo")
    .from("layers")
    .delete()
    .eq("id", parsed.data.id);

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
});
