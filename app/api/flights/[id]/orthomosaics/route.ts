import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { withRoute } from "@/lib/observability/with-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid() });

const BboxPolygon = z.object({
  type: z.literal("Polygon"),
  coordinates: z.array(z.array(z.tuple([z.number(), z.number()]))),
});

// Accept a pre-processed COG (typical ODM output). Direct imagery upload +
// ODM orchestration lives in the next chunk — this endpoint covers the
// "already processed elsewhere" case.
const RegisterBody = z.object({
  cogUrl: z.string().url(),
  dsmUrl: z.string().url().optional(),
  dtmUrl: z.string().url().optional(),
  pointcloudUrl: z.string().url().optional(),
  resolutionCm: z.number().positive().finite().optional(),
  bbox: BboxPolygon.optional(),
  status: z.enum(["queued", "processing", "ready", "failed"]).default("ready"),
  odmJobId: z.string().trim().max(200).optional(),
  error: z.string().trim().max(2000).optional(),
});

export const POST = withRoute<{ id: string }>("flights.orthomosaic.create", async (req, ctx) => {
  const rawParams = await ctx.params;
  const paramsParsed = ParamsSchema.safeParse(rawParams);
  if (!paramsParsed.success) {
    return NextResponse.json({ ok: false, error: "Invalid flight id." }, { status: 400 });
  }

  const supabase = await supabaseServer();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  }

  const bodyParsed = RegisterBody.safeParse(await req.json().catch(() => ({})));
  if (!bodyParsed.success) {
    return NextResponse.json(
      { ok: false, error: "Invalid request body.", issues: bodyParsed.error.issues },
      { status: 400 },
    );
  }

  const { data, error } = await supabase
    .schema("opengeo")
    .from("orthomosaics")
    .insert({
      flight_id: paramsParsed.data.id,
      status: bodyParsed.data.status,
      cog_url: bodyParsed.data.cogUrl,
      dsm_url: bodyParsed.data.dsmUrl ?? null,
      dtm_url: bodyParsed.data.dtmUrl ?? null,
      pointcloud_url: bodyParsed.data.pointcloudUrl ?? null,
      resolution_cm: bodyParsed.data.resolutionCm ?? null,
      bbox: bodyParsed.data.bbox
        ? `SRID=4326;${polygonToWkt(bodyParsed.data.bbox)}`
        : null,
      odm_job_id: bodyParsed.data.odmJobId ?? null,
      error: bodyParsed.data.error ?? null,
    })
    .select("id")
    .single();

  if (error) {
    const status = error.code === "42501" ? 403 : 400;
    return NextResponse.json({ ok: false, error: error.message }, { status });
  }

  return NextResponse.json({ ok: true, orthomosaicId: data.id });
});

function polygonToWkt(poly: { coordinates: number[][][] }): string {
  const rings = poly.coordinates
    .map((ring) => ring.map(([x, y]) => `${x} ${y}`).join(", "))
    .map((ring) => `(${ring})`)
    .join(", ");
  return `POLYGON(${rings})`;
}
