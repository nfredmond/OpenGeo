import { sleep, FatalError, RetryableError } from "workflow";
import { supabaseService } from "@/lib/supabase/service";
import {
  odmAssetUrl,
  odmGetTaskInfo,
  odmStatusToOrtho,
} from "@/lib/odm/client";

// NodeODM reconstruction typically finishes in 2–30 min for MVP-sized flights.
// We poll on a backoff schedule and cap total runtime around two hours to avoid
// orphaned workflows if NodeODM hangs. Both numbers are intentionally generous
// — the workflow is preemptible and restartable, so the upper bound is a
// safety cap, not a performance target.
const MAX_POLL_ATTEMPTS = 120;
const POLL_INTERVAL = "1m";

type OrthoRow = {
  id: string;
  status: "queued" | "processing" | "ready" | "failed";
  odm_job_id: string | null;
};

async function loadOrtho(id: string): Promise<OrthoRow> {
  "use step";
  const { data, error } = await supabaseService()
    .schema("opengeo")
    .from("orthomosaics")
    .select("id, status, odm_job_id")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new RetryableError(`Load ortho ${id} failed: ${error.message}`);
  if (!data) throw new FatalError(`Orthomosaic ${id} not found.`);
  if (!data.odm_job_id) throw new FatalError(`Orthomosaic ${id} has no odm_job_id.`);
  return data as OrthoRow;
}

async function pollOdm(odmJobId: string): Promise<{
  status: "queued" | "processing" | "ready" | "failed";
  progress: number;
  errorMessage?: string;
}> {
  "use step";
  try {
    const info = await odmGetTaskInfo(odmJobId);
    return {
      status: odmStatusToOrtho(info.status.code),
      progress: info.progress,
      errorMessage: info.status.errorMessage,
    };
  } catch (e) {
    // Transient HTTP errors — let the workflow retry this step. The poll loop
    // also owns its own attempt cap, so we don't need to distinguish here.
    throw new RetryableError((e as Error).message);
  }
}

async function writeReady(orthomosaicId: string, odmJobId: string): Promise<void> {
  "use step";
  const { error } = await supabaseService()
    .schema("opengeo")
    .from("orthomosaics")
    .update({
      status: "ready",
      cog_url: odmAssetUrl(odmJobId, "orthophoto.tif"),
      dsm_url: odmAssetUrl(odmJobId, "dsm.tif"),
      dtm_url: odmAssetUrl(odmJobId, "dtm.tif"),
      pointcloud_url: odmAssetUrl(odmJobId, "georeferenced_model.laz"),
      error: null,
    })
    .eq("id", orthomosaicId);
  if (error) throw new RetryableError(`Mark ready failed: ${error.message}`);
}

async function writeFailed(orthomosaicId: string, message: string): Promise<void> {
  "use step";
  const { error } = await supabaseService()
    .schema("opengeo")
    .from("orthomosaics")
    .update({ status: "failed", error: message })
    .eq("id", orthomosaicId);
  if (error) throw new RetryableError(`Mark failed failed: ${error.message}`);
}

async function writeStatus(
  orthomosaicId: string,
  status: "queued" | "processing",
): Promise<void> {
  "use step";
  const { error } = await supabaseService()
    .schema("opengeo")
    .from("orthomosaics")
    .update({ status })
    .eq("id", orthomosaicId);
  if (error) throw new RetryableError(`Mark ${status} failed: ${error.message}`);
}

// Orchestrates the NodeODM task lifecycle for a single orthomosaic row. The
// submit route inserts the row and kicks this off; the workflow owns polling,
// status transitions, and asset-URL write-back. Designed to survive redeploys
// and crashes — step outputs are cached, so resuming continues from the last
// completed poll.
export async function orthomosaicPipelineWorkflow(orthomosaicId: string) {
  "use workflow";

  const ortho = await loadOrtho(orthomosaicId);
  let lastStatus: OrthoRow["status"] = ortho.status;

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    const info = await pollOdm(ortho.odm_job_id as string);

    if (info.status === "ready") {
      console.log(`ortho ${orthomosaicId}: ready after ${attempt + 1} polls`);
      await writeReady(orthomosaicId, ortho.odm_job_id as string);
      return { orthomosaicId, status: "ready", attempts: attempt + 1 };
    }
    if (info.status === "failed") {
      console.log(`ortho ${orthomosaicId}: failed (${info.errorMessage ?? "unknown"})`);
      await writeFailed(
        orthomosaicId,
        info.errorMessage ?? "NodeODM reported failure.",
      );
      return { orthomosaicId, status: "failed", attempts: attempt + 1 };
    }

    if (info.status !== lastStatus) {
      console.log(`ortho ${orthomosaicId}: ${lastStatus} → ${info.status} @ ${info.progress}%`);
      await writeStatus(orthomosaicId, info.status);
      lastStatus = info.status;
    }

    await sleep(POLL_INTERVAL);
  }

  await writeFailed(
    orthomosaicId,
    `NodeODM polling timed out after ${MAX_POLL_ATTEMPTS} attempts.`,
  );
  throw new FatalError(
    `orthomosaic ${orthomosaicId} did not reach a terminal state in time.`,
  );
}
