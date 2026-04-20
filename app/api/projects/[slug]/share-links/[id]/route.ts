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

type ProjectLookup = { id: string };

export const DELETE = withRoute<{ slug: string; id: string }>(
  "projects.share-links.revoke",
  async (req, ctx) => {
    const rawParams = await ctx.params;
    const parsedParams = ParamsSchema.safeParse(rawParams);
    if (!parsedParams.success) {
      return NextResponse.json(
        { ok: false, error: "Invalid parameters.", issues: parsedParams.error.issues },
        { status: 400 },
      );
    }
    const { slug, id } = parsedParams.data;

    const supabase = await supabaseServer();
    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) {
      return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
    }

    const projectId = new URL(req.url).searchParams.get("projectId");
    if (projectId && !z.string().uuid().safeParse(projectId).success) {
      return NextResponse.json({ ok: false, error: "Invalid project id." }, { status: 400 });
    }

    const projectQuery = supabase
      .schema("opengeo")
      .from("projects")
      .select("id");
    let project: ProjectLookup | null = null;
    if (projectId) {
      const { data, error: projErr } = await projectQuery
        .eq("id", projectId)
        .eq("slug", slug)
        .maybeSingle<ProjectLookup>();
      if (projErr) {
        return NextResponse.json({ ok: false, error: projErr.message }, { status: 500 });
      }
      project = data ?? null;
    } else {
      const { data, error: projErr } = await projectQuery
        .eq("slug", slug)
        .limit(2)
        .returns<ProjectLookup[]>();
      if (projErr) {
        return NextResponse.json({ ok: false, error: projErr.message }, { status: 500 });
      }
      if ((data ?? []).length > 1) {
        return NextResponse.json(
          { ok: false, error: "Project slug is ambiguous. Open the project from the Projects list." },
          { status: 409 },
        );
      }
      project = (data ?? [])[0] ?? null;
    }
    if (!project) {
      return NextResponse.json({ ok: false, error: "Project not found." }, { status: 404 });
    }

    const { data: canAdmin, error: rpcErr } = await supabase
      .schema("opengeo")
      .rpc("has_project_access", {
        target_project: project.id,
        min_role: "admin",
      });
    if (rpcErr) {
      return NextResponse.json({ ok: false, error: rpcErr.message }, { status: 500 });
    }
    if (canAdmin !== true) {
      return NextResponse.json({ ok: false, error: "Forbidden." }, { status: 403 });
    }

    // Soft-revoke so resolver lookups can distinguish "revoked" from "never
    // existed" in logs. The token row is retained for audit until the project
    // is deleted (cascade).
    const admin = supabaseService();
    const { error: updateErr } = await admin
      .schema("opengeo")
      .from("project_share_tokens")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", id)
      .eq("project_id", project.id);
    if (updateErr) {
      return NextResponse.json({ ok: false, error: updateErr.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, id });
  },
);
