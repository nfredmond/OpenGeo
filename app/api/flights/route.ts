import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { withRoute } from "@/lib/observability/with-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PolygonSchema = z
  .object({
    type: z.literal("Polygon"),
    coordinates: z.array(z.array(z.tuple([z.number(), z.number()]))),
  })
  .nullable()
  .optional();

const CreateBody = z.object({
  projectId: z.string().uuid().optional(),
  flownAt: z.string().datetime({ offset: true }),
  pilot: z.string().trim().max(120).optional().nullable(),
  aircraft: z.string().trim().max(120).optional().nullable(),
  siteGeom: PolygonSchema,
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const GET = withRoute("flights.list", async () => {
  const supabase = await supabaseServer();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  }

  const { data, error } = await supabase
    .schema("opengeo")
    .from("drone_flights")
    .select(
      `
      id,
      project_id,
      flown_at,
      pilot,
      aircraft,
      metadata,
      created_at,
      orthomosaics (
        id,
        status,
        cog_url,
        resolution_cm,
        updated_at
      )
    `,
    )
    .order("flown_at", { ascending: false });

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, flights: data ?? [] });
});

export const POST = withRoute("flights.create", async (req) => {
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

  let projectId = parsed.data.projectId;
  if (!projectId) {
    const { data, error } = await supabase.rpc("default_project_for", {
      p_user_id: userData.user.id,
    });
    if (error || !data) {
      return NextResponse.json(
        { ok: false, error: "Could not resolve default project." },
        { status: 400 },
      );
    }
    projectId = data as string;
  }

  // RLS on drone_flights enforces can_edit(org_of_project(project_id)); we do
  // not re-check it here. The insert will fail if the caller lacks the role.
  const { data, error } = await supabase
    .schema("opengeo")
    .from("drone_flights")
    .insert({
      project_id: projectId,
      flown_at: parsed.data.flownAt,
      pilot: parsed.data.pilot ?? null,
      aircraft: parsed.data.aircraft ?? null,
      // Let Postgres cast the GeoJSON via the geometry column type; Supabase
      // accepts the stringified GeoJSON when the column is a PostGIS geometry.
      site_geom: parsed.data.siteGeom
        ? `SRID=4326;${polygonToWkt(parsed.data.siteGeom)}`
        : null,
      metadata: parsed.data.metadata ?? {},
    })
    .select("id")
    .single();

  if (error) {
    const status = error.code === "42501" ? 403 : 400;
    return NextResponse.json({ ok: false, error: error.message }, { status });
  }

  return NextResponse.json({ ok: true, flightId: data.id, projectId });
});

// Converts a GeoJSON Polygon geometry into a PostGIS EWKT ring string. We
// intentionally stay in text form so we don't have to install pg/postgis
// client adapters — Supabase's PostgREST accepts SRID=4326;... for geometry
// columns.
function polygonToWkt(poly: { coordinates: number[][][] }): string {
  const rings = poly.coordinates
    .map((ring) => ring.map(([x, y]) => `${x} ${y}`).join(", "))
    .map((ring) => `(${ring})`)
    .join(", ");
  return `POLYGON(${rings})`;
}
