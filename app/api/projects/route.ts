import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { withRoute } from "@/lib/observability/with-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CreateBody = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, "Slugs must be lowercase alphanumeric with hyphens."),
  orgId: z.string().uuid().optional(),
  visibility: z.enum(["private", "org", "public"]).default("private"),
});

export const GET = withRoute("projects.list", async () => {
  const supabase = await supabaseServer();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  }

  // Projects are RLS-filtered; counts come from dataset/flight rows that the
  // caller can also see. We pull everything in one roundtrip via nested selects
  // and aggregate on the client to avoid needing a custom RPC.
  const { data, error } = await supabase
    .schema("opengeo")
    .from("projects")
    .select(
      `
      id,
      slug,
      name,
      visibility,
      created_at,
      updated_at,
      org:orgs!inner (id, slug, name, plan),
      datasets (id, kind),
      drone_flights (id)
    `,
    )
    .order("updated_at", { ascending: false });

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const projects = (data ?? []).map((p) => ({
    id: p.id,
    slug: p.slug,
    name: p.name,
    visibility: p.visibility,
    created_at: p.created_at,
    updated_at: p.updated_at,
    org: p.org,
    datasetCount: p.datasets?.length ?? 0,
    flightCount: p.drone_flights?.length ?? 0,
  }));

  return NextResponse.json({ ok: true, projects });
});

export const POST = withRoute("projects.create", async (req) => {
  const supabase = await supabaseServer();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  }

  const parsed = CreateBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "Invalid request body.", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  // Resolve the org to attach this project to. Default to the caller's primary
  // org (first owner/admin/editor membership).
  let orgId = parsed.data.orgId;
  if (!orgId) {
    const { data: member, error: memberErr } = await supabase
      .schema("opengeo")
      .from("members")
      .select("org_id")
      .eq("user_id", userData.user.id)
      .in("role", ["owner", "admin", "editor"])
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (memberErr) {
      return NextResponse.json({ ok: false, error: memberErr.message }, { status: 500 });
    }
    if (!member) {
      return NextResponse.json(
        { ok: false, error: "You are not a member of any org." },
        { status: 403 },
      );
    }
    orgId = member.org_id;
  }

  const { data, error } = await supabase
    .schema("opengeo")
    .from("projects")
    .insert({
      org_id: orgId,
      slug: parsed.data.slug,
      name: parsed.data.name,
      visibility: parsed.data.visibility,
    })
    .select("id, slug, name")
    .single();

  if (error) {
    const status = error.code === "23505" ? 409 : error.code === "42501" ? 403 : 400;
    return NextResponse.json({ ok: false, error: error.message }, { status });
  }

  return NextResponse.json({ ok: true, project: data });
});
