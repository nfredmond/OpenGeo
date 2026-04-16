import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { withRoute } from "@/lib/observability/with-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Lists extractions visible to the caller. RLS on opengeo.extractions scopes
// the list to orgs the user belongs to. Optional ?qaStatus= narrows to a
// single review state (default: all), and ?projectSlug= scopes to one
// project via the orthomosaic → flight → project chain.
export const GET = withRoute("extractions.list", async (req) => {
  const supabase = await supabaseServer();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  }

  const url = new URL(req.url);
  const qaStatus = url.searchParams.get("qaStatus");
  const projectSlug = url.searchParams.get("projectSlug");

  let query = supabase
    .schema("opengeo")
    .from("extractions")
    .select(
      `
      id,
      model,
      prompt,
      output_layer_id,
      qa_status,
      metrics,
      created_at,
      orthomosaic:orthomosaics!inner (
        id,
        cog_url,
        flight:drone_flights!inner (
          id,
          project:projects!inner (
            id,
            slug,
            name
          )
        )
      )
    `,
    )
    .order("created_at", { ascending: false })
    .limit(100);

  if (qaStatus) query = query.eq("qa_status", qaStatus);
  if (projectSlug) query = query.eq("orthomosaic.flight.project.slug", projectSlug);

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, extractions: data ?? [] });
});
