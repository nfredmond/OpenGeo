import { NextResponse } from "next/server";
import { supabaseService } from "@/lib/supabase/service";
import { withRoute } from "@/lib/observability/with-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Resolves the share token to a project and returns minimal public metadata.
// Token is the capability; 404 on invalid/expired/revoked. Never leak whether
// the token was "wrong" vs "revoked" vs "expired" — all collapse to 404.
export const GET = withRoute<{ token: string }>("share.project", async (_req, ctx) => {
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

  const { data: project, error: projErr } = await admin
    .schema("opengeo")
    .from("projects")
    .select("id, slug, name, visibility, org_id")
    .eq("id", projectId as string)
    .maybeSingle();
  if (projErr) {
    return NextResponse.json({ ok: false, error: projErr.message }, { status: 500 });
  }
  if (!project) {
    return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  }
  const projRow = project as { id: string; slug: string; name: string; org_id: string };

  const { data: org } = await admin
    .schema("opengeo")
    .from("orgs")
    .select("slug, name")
    .eq("id", projRow.org_id)
    .maybeSingle();

  // Token metadata for the banner (expiry date shown as "expires in N days").
  const { data: tokenRow } = await admin
    .schema("opengeo")
    .from("project_share_tokens")
    .select("expires_at, scopes")
    .eq("project_id", projRow.id)
    .is("revoked_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return NextResponse.json({
    ok: true,
    project: { id: projRow.id, slug: projRow.slug, name: projRow.name },
    org: org
      ? {
          slug: (org as { slug: string }).slug,
          name: (org as { name: string }).name,
        }
      : null,
    expiresAt: (tokenRow as { expires_at: string | null } | null)?.expires_at ?? null,
    scopes:
      ((tokenRow as { scopes: string[] | null } | null)?.scopes as string[] | null) ??
      ["read:layers", "read:orthomosaics"],
  });
});
