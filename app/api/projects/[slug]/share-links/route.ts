import { NextResponse } from "next/server";
import { createHash, randomBytes } from "node:crypto";
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

const MintBody = z.object({
  expiresInDays: z.number().int().positive().max(3650).optional(),
  scopes: z.array(z.string().min(1).max(64)).max(16).optional(),
  label: z.string().trim().max(120).optional(),
});

type ProjectLookup = { id: string; slug: string };

async function resolveProject(
  supabase: Awaited<ReturnType<typeof supabaseServer>>,
  slug: string,
): Promise<ProjectLookup | null> {
  const { data, error } = await supabase
    .schema("opengeo")
    .from("projects")
    .select("id, slug")
    .eq("slug", slug)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as ProjectLookup | null) ?? null;
}

async function requireAdmin(
  supabase: Awaited<ReturnType<typeof supabaseServer>>,
  projectId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .schema("opengeo")
    .rpc("has_project_access", { target_project: projectId, min_role: "admin" });
  if (error) throw new Error(error.message);
  return data === true;
}

// Token is "<prefix>.<secret>". Prefix is 10 url-safe chars (for display);
// secret is 32 random bytes base64url-encoded. Keep this in sync with the
// resolver in supabase/migrations/20260417120200_share_tokens.sql.
function mintToken(): { token: string; prefix: string; hash: string } {
  const prefix = randomBytes(8).toString("base64url").slice(0, 10);
  const secret = randomBytes(32).toString("base64url");
  const token = `${prefix}.${secret}`;
  const hash = createHash("sha256").update(token).digest("hex");
  return { token, prefix, hash };
}

export const POST = withRoute<{ slug: string }>(
  "projects.share-links.mint",
  async (req, ctx) => {
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

    const bodyParsed = MintBody.safeParse(await req.json().catch(() => ({})));
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

    const canAdmin = await requireAdmin(supabase, project.id);
    if (!canAdmin) {
      return NextResponse.json({ ok: false, error: "Forbidden." }, { status: 403 });
    }

    const { token, prefix, hash } = mintToken();
    const expiresAt = bodyParsed.data.expiresInDays
      ? new Date(Date.now() + bodyParsed.data.expiresInDays * 24 * 60 * 60 * 1000).toISOString()
      : null;
    const scopes = bodyParsed.data.scopes ?? ["read:layers", "read:orthomosaics"];

    const admin = supabaseService();
    const { data: inserted, error: insertErr } = await admin
      .schema("opengeo")
      .from("project_share_tokens")
      .insert({
        project_id: project.id,
        token_prefix: prefix,
        token_hash: hash,
        scopes,
        expires_at: expiresAt,
        created_by: userData.user.id,
      })
      .select("id, token_prefix, scopes, expires_at, created_at")
      .single();
    if (insertErr) {
      return NextResponse.json({ ok: false, error: insertErr.message }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      // Token is returned exactly once; hashed at rest. Admin UI must show
      // this to the user and never re-fetch it.
      token,
      id: inserted.id,
      prefix: inserted.token_prefix,
      scopes: inserted.scopes,
      expiresAt: inserted.expires_at,
      createdAt: inserted.created_at,
    });
  },
);

export const GET = withRoute<{ slug: string }>(
  "projects.share-links.list",
  async (_req, ctx) => {
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

    const canAdmin = await requireAdmin(supabase, project.id);
    if (!canAdmin) {
      return NextResponse.json({ ok: false, error: "Forbidden." }, { status: 403 });
    }

    const { data: rows, error: listErr } = await supabase
      .schema("opengeo")
      .from("project_share_tokens")
      .select(
        "id, token_prefix, scopes, expires_at, revoked_at, last_used_at, created_at",
      )
      .eq("project_id", project.id)
      .order("created_at", { ascending: false });
    if (listErr) {
      return NextResponse.json({ ok: false, error: listErr.message }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      tokens: (rows ?? []).map((r) => ({
        id: r.id as string,
        prefix: r.token_prefix as string,
        scopes: (r.scopes as string[] | null) ?? [],
        expiresAt: (r.expires_at as string | null) ?? null,
        revokedAt: (r.revoked_at as string | null) ?? null,
        lastUsedAt: (r.last_used_at as string | null) ?? null,
        createdAt: r.created_at as string,
      })),
    });
  },
);
