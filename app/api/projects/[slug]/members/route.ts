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
});

const InviteBody = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  role: z.enum(["admin", "editor", "viewer"]).default("viewer"),
});

type ProjectLookup = { id: string; slug: string; name: string; org_id: string };

async function resolveProject(
  supabase: Awaited<ReturnType<typeof supabaseServer>>,
  slug: string,
): Promise<ProjectLookup | null> {
  const { data, error } = await supabase
    .schema("opengeo")
    .from("projects")
    .select("id, slug, name, org_id")
    .eq("slug", slug)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as ProjectLookup | null) ?? null;
}

async function hasProjectRole(
  supabase: Awaited<ReturnType<typeof supabaseServer>>,
  projectId: string,
  minRole: "viewer" | "editor" | "admin" | "owner",
): Promise<boolean> {
  const { data, error } = await supabase
    .schema("opengeo")
    .rpc("has_project_access", { target_project: projectId, min_role: minRole });
  if (error) throw new Error(error.message);
  return data === true;
}

export const GET = withRoute<{ slug: string }>("projects.members.list", async (_req, ctx) => {
  const rawParams = await ctx.params;
  const parsedParams = ParamsSchema.safeParse(rawParams);
  if (!parsedParams.success) {
    return NextResponse.json({ ok: false, error: "Invalid project slug." }, { status: 400 });
  }

  const supabase = await supabaseServer();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  }

  const project = await resolveProject(supabase, parsedParams.data.slug);
  if (!project) {
    return NextResponse.json({ ok: false, error: "Project not found." }, { status: 404 });
  }

  const canView = await hasProjectRole(supabase, project.id, "viewer");
  if (!canView) {
    return NextResponse.json({ ok: false, error: "Forbidden." }, { status: 403 });
  }

  // Read org-level + project-level members via the service role so we can join
  // against auth.users for display emails without giving the caller direct
  // SELECT on auth.users. The admin+ check above protects this privileged read.
  const canAdmin = await hasProjectRole(supabase, project.id, "admin");
  const admin = canAdmin ? supabaseService() : null;

  const { data: projectMembersRaw, error: pmErr } = await supabase
    .schema("opengeo")
    .from("project_members")
    .select("user_id, role, invited_by, created_at")
    .eq("project_id", project.id);
  if (pmErr) {
    return NextResponse.json({ ok: false, error: pmErr.message }, { status: 500 });
  }

  const { data: orgMembersRaw, error: omErr } = await supabase
    .schema("opengeo")
    .from("members")
    .select("user_id, role, created_at")
    .eq("org_id", project.org_id);
  if (omErr) {
    return NextResponse.json({ ok: false, error: omErr.message }, { status: 500 });
  }

  // Resolve email addresses for display. Only admins see full emails; viewers
  // get an obfuscated placeholder so we don't leak org contacts.
  const allUserIds = Array.from(
    new Set([
      ...(projectMembersRaw ?? []).map((m) => m.user_id as string),
      ...(orgMembersRaw ?? []).map((m) => m.user_id as string),
    ]),
  );

  const emailByUser = new Map<string, string | null>();
  if (admin && allUserIds.length > 0) {
    const { data: authUsers, error: authErr } = await admin
      .schema("auth")
      .from("users")
      .select("id, email")
      .in("id", allUserIds);
    if (!authErr) {
      for (const row of (authUsers ?? []) as { id: string; email: string | null }[]) {
        emailByUser.set(row.id, row.email);
      }
    }
  }

  const members = [
    ...(orgMembersRaw ?? []).map((m) => ({
      userId: m.user_id as string,
      email: emailByUser.get(m.user_id as string) ?? null,
      role: m.role as string,
      scope: "org" as const,
      invitedBy: null as string | null,
      createdAt: m.created_at as string,
    })),
    ...(projectMembersRaw ?? []).map((m) => ({
      userId: m.user_id as string,
      email: emailByUser.get(m.user_id as string) ?? null,
      role: m.role as string,
      scope: "project" as const,
      invitedBy: (m.invited_by as string | null) ?? null,
      createdAt: m.created_at as string,
    })),
  ];

  let invitations: Array<{
    id: string;
    email: string;
    role: string;
    invitedBy: string | null;
    createdAt: string;
  }> = [];
  if (canAdmin) {
    const { data: inviteRows, error: invErr } = await supabase
      .schema("opengeo")
      .from("project_invitations")
      .select("id, email, role, invited_by, created_at, accepted_at")
      .eq("project_id", project.id)
      .is("accepted_at", null)
      .order("created_at", { ascending: false });
    if (invErr) {
      return NextResponse.json({ ok: false, error: invErr.message }, { status: 500 });
    }
    invitations = (inviteRows ?? []).map((r) => ({
      id: r.id as string,
      email: r.email as string,
      role: r.role as string,
      invitedBy: (r.invited_by as string | null) ?? null,
      createdAt: r.created_at as string,
    }));
  }

  return NextResponse.json({
    ok: true,
    project: { id: project.id, slug: project.slug, name: project.name },
    members,
    invitations,
    viewerCanAdmin: canAdmin,
  });
});

export const POST = withRoute<{ slug: string }>("projects.members.invite", async (req, ctx) => {
  const rawParams = await ctx.params;
  const parsedParams = ParamsSchema.safeParse(rawParams);
  if (!parsedParams.success) {
    return NextResponse.json({ ok: false, error: "Invalid project slug." }, { status: 400 });
  }

  const supabase = await supabaseServer();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  }

  const bodyParsed = InviteBody.safeParse(await req.json().catch(() => ({})));
  if (!bodyParsed.success) {
    return NextResponse.json(
      { ok: false, error: "Invalid request body.", issues: bodyParsed.error.issues },
      { status: 400 },
    );
  }

  const project = await resolveProject(supabase, parsedParams.data.slug);
  if (!project) {
    return NextResponse.json({ ok: false, error: "Project not found." }, { status: 404 });
  }

  const canAdmin = await hasProjectRole(supabase, project.id, "admin");
  if (!canAdmin) {
    return NextResponse.json({ ok: false, error: "Forbidden." }, { status: 403 });
  }

  const admin = supabaseService();
  const email = bodyParsed.data.email;
  const role = bodyParsed.data.role;

  const { data: existingUsers, error: lookupErr } = await admin
    .schema("auth")
    .from("users")
    .select("id, email")
    .eq("email", email)
    .limit(1);
  if (lookupErr) {
    return NextResponse.json({ ok: false, error: lookupErr.message }, { status: 500 });
  }

  const existing = (existingUsers ?? [])[0] as { id: string; email: string | null } | undefined;

  if (existing) {
    // User already has an auth account. Give them project access directly;
    // no email needed. upsert() keeps the call idempotent if invited twice.
    const { error: pmErr } = await admin
      .schema("opengeo")
      .from("project_members")
      .upsert(
        {
          project_id: project.id,
          user_id: existing.id,
          role,
          invited_by: userData.user.id,
        },
        { onConflict: "project_id,user_id" },
      );
    if (pmErr) {
      return NextResponse.json({ ok: false, error: pmErr.message }, { status: 500 });
    }
    return NextResponse.json({
      ok: true,
      result: "member_added",
      userId: existing.id,
    });
  }

  // No existing account: record the invitation and fire a magic-link invite.
  // The signup trigger picks up the pending invitation by email and routes the
  // new user into project_members instead of auto-creating a personal org.
  const { data: invite, error: invErr } = await admin
    .schema("opengeo")
    .from("project_invitations")
    .insert({
      project_id: project.id,
      email,
      role,
      invited_by: userData.user.id,
    })
    .select("id")
    .single();
  if (invErr) {
    // 23505 = unique violation on the (project_id, lower(email)) pending index.
    const status = invErr.code === "23505" ? 409 : 500;
    return NextResponse.json({ ok: false, error: invErr.message }, { status });
  }

  const origin = new URL(req.url).origin;
  const redirectTo = `${origin}/auth/callback?next=${encodeURIComponent(
    `/projects/${project.slug}`,
  )}`;

  const { error: emailErr } = await admin.auth.admin.inviteUserByEmail(email, {
    redirectTo,
    data: { invited_to_project: project.slug },
  });
  if (emailErr) {
    // Non-fatal: the invitation row already exists, so the user can still
    // accept via any other magic-link path. Surface the email-send failure
    // so the caller can retry or notify the invitee manually.
    return NextResponse.json({
      ok: true,
      result: "invitation_created_email_failed",
      invitationId: invite.id,
      warning: emailErr.message,
    });
  }

  return NextResponse.json({
    ok: true,
    result: "invitation_sent",
    invitationId: invite.id,
  });
});
