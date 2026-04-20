import { NextResponse } from "next/server";
import { supabaseService } from "@/lib/supabase/service";
import { withRoute } from "@/lib/observability/with-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ShareTokenDetail = {
  token_id: string;
  project_id: string;
  scopes: string[] | null;
  expires_at: string | null;
};

// Resolves the share token to a project and returns minimal public metadata.
// Token is the capability; 404 on invalid/expired/revoked. Never leak whether
// the token was "wrong" vs "revoked" vs "expired" — all collapse to 404.
export const GET = withRoute<{ token: string }>("share.project", async (_req, ctx) => {
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

  const { data: project, error: projErr } = await admin
    .schema("opengeo")
    .from("projects")
    .select("id, slug, name, visibility, org_id")
    .eq("id", tokenDetail.project_id)
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

  return NextResponse.json({
    ok: true,
    project: { id: projRow.id, slug: projRow.slug, name: projRow.name },
    org: org
      ? {
          slug: (org as { slug: string }).slug,
          name: (org as { name: string }).name,
        }
      : null,
    expiresAt: tokenDetail.expires_at ?? null,
    scopes: tokenDetail.scopes ?? [],
  });
});
