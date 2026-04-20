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
  userId: z.string().uuid(),
});

type ProjectLookup = { id: string; slug: string; org_id: string };

export const DELETE = withRoute<{ slug: string; userId: string }>(
  "projects.members.remove",
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

    // Resolve project by id+slug when possible. Slug-only links are still
    // supported, but duplicate visible slugs must be disambiguated by projectId.
    const projectQuery = supabase
      .schema("opengeo")
      .from("projects")
      .select("id, slug, org_id");
    let project: ProjectLookup | null = null;
    if (projectId) {
      const { data, error: pErr } = await projectQuery
        .eq("id", projectId)
        .eq("slug", parsed.data.slug)
        .maybeSingle<ProjectLookup>();
      if (pErr) return NextResponse.json({ ok: false, error: pErr.message }, { status: 500 });
      project = data ?? null;
    } else {
      const { data, error: pErr } = await projectQuery
        .eq("slug", parsed.data.slug)
        .limit(2)
        .returns<ProjectLookup[]>();
      if (pErr) return NextResponse.json({ ok: false, error: pErr.message }, { status: 500 });
      if ((data ?? []).length > 1) {
        return NextResponse.json(
          { ok: false, error: "Project slug is ambiguous. Open the project from the Projects list." },
          { status: 409 },
        );
      }
      project = (data ?? [])[0] ?? null;
    }
    if (!project) return NextResponse.json({ ok: false, error: "Project not found." }, { status: 404 });

    const { data: canAdmin, error: aErr } = await supabase
      .schema("opengeo")
      .rpc("has_project_access", { target_project: project.id, min_role: "admin" });
    if (aErr) return NextResponse.json({ ok: false, error: aErr.message }, { status: 500 });
    if (canAdmin !== true) {
      return NextResponse.json({ ok: false, error: "Forbidden." }, { status: 403 });
    }

    // Service-role from here on so the last-owner guard can count across rows
    // that the scoped client may not be able to see (org members are visible
    // to org members only).
    const admin = supabaseService();

    const { data: targetRow, error: tErr } = await admin
      .schema("opengeo")
      .from("project_members")
      .select("role")
      .eq("project_id", project.id)
      .eq("user_id", parsed.data.userId)
      .maybeSingle();
    if (tErr) return NextResponse.json({ ok: false, error: tErr.message }, { status: 500 });
    if (!targetRow) {
      return NextResponse.json(
        { ok: false, error: "User is not a project member (or only has org-level access)." },
        { status: 404 },
      );
    }

    // Last-owner guard: if removing this row would leave the project with no
    // admin+/owner at all (neither via project_members nor via org.members),
    // refuse. Cheap upper bound: count survivors in each table.
    if (targetRow.role === "owner" || targetRow.role === "admin") {
      const { count: pmSurvivors, error: pmCountErr } = await admin
        .schema("opengeo")
        .from("project_members")
        .select("user_id", { count: "exact", head: true })
        .eq("project_id", project.id)
        .in("role", ["owner", "admin"])
        .neq("user_id", parsed.data.userId);
      if (pmCountErr) {
        return NextResponse.json({ ok: false, error: pmCountErr.message }, { status: 500 });
      }

      const { count: orgSurvivors, error: orgCountErr } = await admin
        .schema("opengeo")
        .from("members")
        .select("user_id", { count: "exact", head: true })
        .eq("org_id", project.org_id)
        .in("role", ["owner", "admin"]);
      if (orgCountErr) {
        return NextResponse.json({ ok: false, error: orgCountErr.message }, { status: 500 });
      }

      if ((pmSurvivors ?? 0) + (orgSurvivors ?? 0) === 0) {
        return NextResponse.json(
          {
            ok: false,
            error: "Cannot remove the last admin/owner. Invite or promote another admin first.",
          },
          { status: 400 },
        );
      }
    }

    const { error: delErr } = await admin
      .schema("opengeo")
      .from("project_members")
      .delete()
      .eq("project_id", project.id)
      .eq("user_id", parsed.data.userId);
    if (delErr) {
      return NextResponse.json({ ok: false, error: delErr.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, removed: parsed.data.userId });
  },
);
