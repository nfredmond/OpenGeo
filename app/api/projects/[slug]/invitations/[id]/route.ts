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
  "projects.invitations.cancel",
  async (req, ctx) => {
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

    const projectId = new URL(req.url).searchParams.get("projectId");
    if (projectId && !z.string().uuid().safeParse(projectId).success) {
      return NextResponse.json({ ok: false, error: "Invalid project id." }, { status: 400 });
    }

    let projectQuery = supabase
      .schema("opengeo")
      .from("projects")
      .select("id");
    if (projectId) {
      projectQuery = projectQuery.eq("id", projectId).eq("slug", parsed.data.slug);
      const { data: project, error: pErr } = await projectQuery.maybeSingle<ProjectLookup>();
      if (pErr) return NextResponse.json({ ok: false, error: pErr.message }, { status: 500 });
      if (!project) return NextResponse.json({ ok: false, error: "Project not found." }, { status: 404 });
      return cancelInvitation(parsed.data.id, project.id);
    }

    const { data: projects, error: pErr } = await projectQuery
      .eq("slug", parsed.data.slug)
      .limit(2)
      .returns<ProjectLookup[]>();
    if (pErr) return NextResponse.json({ ok: false, error: pErr.message }, { status: 500 });
    if ((projects ?? []).length > 1) {
      return NextResponse.json(
        { ok: false, error: "Project slug is ambiguous. Open the project from the Projects list." },
        { status: 409 },
      );
    }
    const project = (projects ?? [])[0];
    if (!project) return NextResponse.json({ ok: false, error: "Project not found." }, { status: 404 });

    return cancelInvitation(parsed.data.id, project.id);

    async function cancelInvitation(invitationId: string, targetProjectId: string) {
      const { data: canAdmin, error: aErr } = await supabase
        .schema("opengeo")
        .rpc("has_project_access", { target_project: targetProjectId, min_role: "admin" });
      if (aErr) return NextResponse.json({ ok: false, error: aErr.message }, { status: 500 });
      if (canAdmin !== true) {
        return NextResponse.json({ ok: false, error: "Forbidden." }, { status: 403 });
      }

      const admin = supabaseService();
      const { error: delErr } = await admin
        .schema("opengeo")
        .from("project_invitations")
        .delete()
        .eq("id", invitationId)
        .eq("project_id", targetProjectId);
      if (delErr) {
        return NextResponse.json({ ok: false, error: delErr.message }, { status: 500 });
      }

      return NextResponse.json({ ok: true, cancelled: invitationId });
    }
  },
);
