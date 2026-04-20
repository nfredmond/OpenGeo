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
    .select("id, name, geometry_kind, feature_count, style")
    .eq("id", parsed.data.id)
    .maybeSingle();

  if (layerErr) return NextResponse.json({ ok: false, error: layerErr.message }, { status: 500 });
  if (!layer) return NextResponse.json({ ok: false, error: "Layer not found." }, { status: 404 });

  const { data: fc, error: fcErr } = await supabase
    .schema("opengeo")
    .rpc("layer_as_geojson", {
      p_layer_id: parsed.data.id,
    });
  if (fcErr) {
    return NextResponse.json({ ok: false, error: fcErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, layer, featureCollection: fc });
});

const PatchBody = z.object({
  style: z.record(z.string(), z.unknown()).optional(),
  name: z.string().trim().min(1).max(120).optional(),
});

export const PATCH = withRoute<{ id: string }>("layers.patch", async (req, ctx) => {
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

  const bodyParsed = PatchBody.safeParse(await req.json().catch(() => ({})));
  if (!bodyParsed.success) {
    return NextResponse.json(
      { ok: false, error: "Invalid request body.", issues: bodyParsed.error.issues },
      { status: 400 },
    );
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (bodyParsed.data.style !== undefined) patch.style = bodyParsed.data.style;
  if (bodyParsed.data.name !== undefined) patch.name = bodyParsed.data.name;

  const { data, error } = await supabase
    .schema("opengeo")
    .from("layers")
    .update(patch)
    .eq("id", parsed.data.id)
    .select("id, name, style")
    .maybeSingle();

  if (error) {
    const status = error.code === "42501" ? 403 : 400;
    return NextResponse.json({ ok: false, error: error.message }, { status });
  }
  if (!data) {
    return NextResponse.json({ ok: false, error: "Layer not found." }, { status: 404 });
  }

  return NextResponse.json({ ok: true, layer: data });
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
