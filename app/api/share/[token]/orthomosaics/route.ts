import { NextResponse } from "next/server";
import { supabaseService } from "@/lib/supabase/service";
import { withRoute } from "@/lib/observability/with-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Returns ready orthomosaic COG URLs for the shared project.
// 404 on invalid/expired/revoked token or missing read:orthomosaics scope.
export const GET = withRoute<{ token: string }>("share.orthomosaics", async (_req, ctx) => {
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

  const { data: tokenRow } = await admin
    .schema("opengeo")
    .from("project_share_tokens")
    .select("scopes")
    .eq("project_id", projectId as string)
    .is("revoked_at", null)
    .limit(1)
    .maybeSingle();
  const scopes = ((tokenRow as { scopes: string[] | null } | null)?.scopes ?? []) as string[];
  if (!scopes.includes("read:orthomosaics")) {
    return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  }

  const { data: flights, error: flightsErr } = await admin
    .schema("opengeo")
    .from("drone_flights")
    .select("id")
    .eq("project_id", projectId as string);
  if (flightsErr) {
    return NextResponse.json({ ok: false, error: flightsErr.message }, { status: 500 });
  }
  const flightIds = (flights ?? []).map((f) => (f as { id: string }).id);
  if (flightIds.length === 0) {
    return NextResponse.json({ ok: true, orthomosaics: [] });
  }

  const { data: orthoRows, error: orthoErr } = await admin
    .schema("opengeo")
    .from("orthomosaics")
    .select("id, flight_id, status, cog_url, created_at")
    .in("flight_id", flightIds)
    .eq("status", "ready")
    .order("created_at", { ascending: false });
  if (orthoErr) {
    return NextResponse.json({ ok: false, error: orthoErr.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    orthomosaics: (orthoRows ?? []).map((r) => {
      const o = r as {
        id: string;
        flight_id: string;
        status: string;
        cog_url: string | null;
        created_at: string;
      };
      return {
        id: o.id,
        flightId: o.flight_id,
        status: o.status,
        cogUrl: o.cog_url,
        createdAt: o.created_at,
      };
    }),
  });
});
