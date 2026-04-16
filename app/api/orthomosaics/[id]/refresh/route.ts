import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { withRoute } from "@/lib/observability/with-route";
import { flag } from "@/lib/env";
import {
  odmAssetUrl,
  odmGetTaskInfo,
  odmStatusToOrtho,
} from "@/lib/odm/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ id: z.string().uuid() });

// Polls NodeODM for a submitted orthomosaic and reconciles the DB row.
// Returns the current status either way. Designed to be called from the
// browser on-demand (no background worker required for the MVP).
export const POST = withRoute<{ id: string }>("orthomosaics.refresh", async (_req, ctx) => {
  if (!flag.dronePipeline()) {
    return NextResponse.json(
      { ok: false, error: "Drone pipeline is disabled (FEATURE_DRONE_PIPELINE=false)." },
      { status: 503 },
    );
  }

  const raw = await ctx.params;
  const paramsParsed = ParamsSchema.safeParse(raw);
  if (!paramsParsed.success) {
    return NextResponse.json({ ok: false, error: "Invalid orthomosaic id." }, { status: 400 });
  }

  const supabase = await supabaseServer();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  }

  const { data: ortho, error: orthoErr } = await supabase
    .schema("opengeo")
    .from("orthomosaics")
    .select("id, status, cog_url, odm_job_id")
    .eq("id", paramsParsed.data.id)
    .maybeSingle();
  if (orthoErr) {
    return NextResponse.json({ ok: false, error: orthoErr.message }, { status: 500 });
  }
  if (!ortho) {
    return NextResponse.json({ ok: false, error: "Orthomosaic not found." }, { status: 404 });
  }

  // Terminal states — no need to poll.
  if (ortho.status === "ready" || ortho.status === "failed") {
    return NextResponse.json({ ok: true, status: ortho.status, cogUrl: ortho.cog_url });
  }
  if (!ortho.odm_job_id) {
    return NextResponse.json(
      { ok: false, error: "Orthomosaic has no odm_job_id to poll." },
      { status: 400 },
    );
  }

  let info;
  try {
    info = await odmGetTaskInfo(ortho.odm_job_id);
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `NodeODM poll failed: ${(e as Error).message}` },
      { status: 502 },
    );
  }

  const mappedStatus = odmStatusToOrtho(info.status.code);
  const patch: Record<string, unknown> = { status: mappedStatus };
  if (mappedStatus === "ready") {
    patch.cog_url = odmAssetUrl(ortho.odm_job_id, "orthophoto.tif");
    patch.dsm_url = odmAssetUrl(ortho.odm_job_id, "dsm.tif");
    patch.dtm_url = odmAssetUrl(ortho.odm_job_id, "dtm.tif");
    patch.pointcloud_url = odmAssetUrl(ortho.odm_job_id, "georeferenced_model.laz");
    patch.error = null;
  }
  if (mappedStatus === "failed") {
    patch.error = info.status.errorMessage ?? "NodeODM reported failure.";
  }

  // Only PATCH when something actually changed to keep updated_at honest.
  if (mappedStatus !== ortho.status) {
    const { error: updateErr } = await supabase
      .schema("opengeo")
      .from("orthomosaics")
      .update(patch)
      .eq("id", ortho.id);
    if (updateErr) {
      return NextResponse.json({ ok: false, error: updateErr.message }, { status: 500 });
    }
  }

  return NextResponse.json({
    ok: true,
    status: mappedStatus,
    progress: info.progress,
    processingTime: info.processingTime,
    cogUrl: mappedStatus === "ready" ? patch.cog_url : ortho.cog_url,
  });
});
