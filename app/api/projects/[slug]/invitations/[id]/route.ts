import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseService } from "@/lib/supabase/service";
import { withRoute } from "@/lib/observability/with-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/),
  id: z.string().uuid(),
});

export const DELETE = withRoute<{ slug: string; id: string }>(
  "projects.invitations.cancel",
  async (_req, ctx) => {
    const rawParams = await ctx.params;
    const parsed = ParamsSchema.safeParse(rawParams);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: "Invalid parameters." }, { status: 400 });
    }

    const supabase = await supabaseServer();
    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) {
      return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
    }

    const { data: project, error: pErr } = await supabase
      .schema("opengeo")
      .from("projects")
      .select("id")
      .eq("slug", parsed.data.slug)
      .maybeSingle();
    if (pErr) return NextResponse.json({ ok: false, error: pErr.message }, { status: 500 });
    if (!project) return NextResponse.json({ ok: false, error: "Project not found." }, { status: 404 });

    const { data: canAdmin, error: aErr } = await supabase
      .schema("opengeo")
      .rpc("has_project_access", { target_project: project.id, min_role: "admin" });
    if (aErr) return NextResponse.json({ ok: false, error: aErr.message }, { status: 500 });
    if (canAdmin !== true) {
      return NextResponse.json({ ok: false, error: "Forbidden." }, { status: 403 });
    }

    const admin = supabaseService();
    const { error: delErr } = await admin
      .schema("opengeo")
      .from("project_invitations")
      .delete()
      .eq("id", parsed.data.id)
      .eq("project_id", project.id);
    if (delErr) {
      return NextResponse.json({ ok: false, error: delErr.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, cancelled: parsed.data.id });
  },
);
