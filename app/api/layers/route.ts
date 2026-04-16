import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { withRoute } from "@/lib/observability/with-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Lists layers visible to the current user. RLS on opengeo.layers ensures the
// list is filtered to orgs the user belongs to — we do not re-check membership
// here.
export const GET = withRoute("layers.list", async () => {
  const supabase = await supabaseServer();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  }

  const { data, error } = await supabase
    .schema("opengeo")
    .from("layers")
    .select(
      `
      id,
      name,
      geometry_kind,
      feature_count,
      updated_at,
      dataset:datasets!inner (
        id,
        name,
        project:projects!inner (
          id,
          name,
          org:orgs!inner (
            id,
            name,
            slug
          )
        )
      )
    `,
    )
    .order("updated_at", { ascending: false });

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, layers: data ?? [] });
});
