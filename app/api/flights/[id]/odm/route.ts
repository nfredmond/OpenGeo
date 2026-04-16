import { NextResponse } from "next/server";
import { z } from "zod";
import { start } from "workflow/api";
import { supabaseServer } from "@/lib/supabase/server";
import { withRoute } from "@/lib/observability/with-route";
import { flag } from "@/lib/env";
import {
  odmCommitTask,
  odmCreateTask,
  odmUploadImage,
} from "@/lib/odm/client";
import { orthomosaicPipelineWorkflow } from "@/workflows/orthomosaic-pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// NodeODM uploads can be large; give the route room to stream without hitting
// the default 1 MB body cap.
export const maxDuration = 300;

const ParamsSchema = z.object({ id: z.string().uuid() });

// Submit a new ODM task for a given flight. Accepts multipart/form-data with:
//   images:       one or more image files (jpg/tif)
//   name:         optional human-readable task name
//   displayName:  optional display label stored on the orthomosaic row
//   odmOptions:   optional JSON string for NodeODM options passthrough
export const POST = withRoute<{ id: string }>("flights.odm.submit", async (req, ctx) => {
  if (!flag.dronePipeline()) {
    return NextResponse.json(
      { ok: false, error: "Drone pipeline is disabled (FEATURE_DRONE_PIPELINE=false)." },
      { status: 503 },
    );
  }

  const raw = await ctx.params;
  const paramsParsed = ParamsSchema.safeParse(raw);
  if (!paramsParsed.success) {
    return NextResponse.json({ ok: false, error: "Invalid flight id." }, { status: 400 });
  }

  const supabase = await supabaseServer();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  }

  // We rely on RLS to prevent cross-org orthomosaic writes. Verify the flight
  // is visible first so we return a clean 404 rather than relying on insert
  // errors.
  const { data: flight, error: flightErr } = await supabase
    .schema("opengeo")
    .from("drone_flights")
    .select("id")
    .eq("id", paramsParsed.data.id)
    .maybeSingle();
  if (flightErr) {
    return NextResponse.json({ ok: false, error: flightErr.message }, { status: 500 });
  }
  if (!flight) {
    return NextResponse.json({ ok: false, error: "Flight not found." }, { status: 404 });
  }

  const form = await req.formData().catch(() => null);
  if (!form) {
    return NextResponse.json(
      { ok: false, error: "Expected multipart/form-data." },
      { status: 400 },
    );
  }

  const images: File[] = [];
  for (const value of form.getAll("images")) {
    if (value instanceof File && value.size > 0) images.push(value);
  }
  if (images.length < 2) {
    return NextResponse.json(
      { ok: false, error: "ODM needs at least 2 images to reconstruct a scene." },
      { status: 400 },
    );
  }

  const taskName = (form.get("name") as string | null)?.trim() || `flight-${paramsParsed.data.id}`;
  const displayName = (form.get("displayName") as string | null)?.trim() || taskName;
  const odmOptionsRaw = form.get("odmOptions") as string | null;
  let odmOptions: Array<{ name: string; value: unknown }> | undefined;
  if (odmOptionsRaw) {
    try {
      const parsed = JSON.parse(odmOptionsRaw);
      if (Array.isArray(parsed)) odmOptions = parsed;
    } catch {
      return NextResponse.json(
        { ok: false, error: "odmOptions must be a JSON array of {name,value} pairs." },
        { status: 400 },
      );
    }
  }

  // Submit to NodeODM.
  let uuid: string;
  try {
    uuid = await odmCreateTask({ name: taskName, options: odmOptions });
    for (const img of images) {
      await odmUploadImage(uuid, { name: img.name, blob: img });
    }
    await odmCommitTask(uuid);
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `NodeODM submission failed: ${(e as Error).message}` },
      { status: 502 },
    );
  }

  // Record the orthomosaic as processing. cog_url stays null until refresh
  // picks up completion and fills it in.
  const { data: ortho, error: orthoErr } = await supabase
    .schema("opengeo")
    .from("orthomosaics")
    .insert({
      flight_id: paramsParsed.data.id,
      status: "processing",
      odm_job_id: uuid,
    })
    .select("id")
    .single();

  if (orthoErr) {
    // ODM task exists but we failed to write the row. Surface the UUID so the
    // caller can retry (or a scheduled job can reconcile later).
    return NextResponse.json(
      {
        ok: false,
        error: `NodeODM task ${uuid} submitted but db insert failed: ${orthoErr.message}`,
        odmJobId: uuid,
      },
      { status: 500 },
    );
  }

  // Kick off the durable polling workflow. If it fails to enqueue, we still
  // return success — the /refresh route is a manual fallback and the row is
  // already persisted as "processing".
  let workflowRunId: string | null = null;
  if (flag.durablePipeline()) {
    try {
      const run = await start(orthomosaicPipelineWorkflow, [ortho.id]);
      workflowRunId = run.runId;
      // Best-effort persist so operators can pivot from a stuck row to the
      // workflow trace without digging through logs. If this fails we keep
      // the in-memory value and return it in the response anyway.
      const { error: runIdErr } = await supabase
        .schema("opengeo")
        .from("orthomosaics")
        .update({ workflow_run_id: run.runId })
        .eq("id", ortho.id);
      if (runIdErr) {
        console.error(`failed to persist workflow_run_id for ortho ${ortho.id}:`, runIdErr);
      }
    } catch (e) {
      console.error(`failed to start workflow for ortho ${ortho.id}:`, e);
    }
  }

  return NextResponse.json({
    ok: true,
    orthomosaicId: ortho.id,
    odmJobId: uuid,
    imageCount: images.length,
    displayName,
    workflowRunId,
  });
});
