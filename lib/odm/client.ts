import "server-only";
import { env } from "@/lib/env";

// NodeODM status codes (from the NodeODM REST API):
//  10 = queued, 20 = running, 30 = failed, 40 = completed, 50 = canceled
export type OdmStatusCode = 10 | 20 | 30 | 40 | 50;

export type OdmTaskInfo = {
  uuid: string;
  name: string | null;
  dateCreated: number;
  processingTime: number;
  status: { code: OdmStatusCode; errorMessage?: string };
  options: Array<{ name: string; value: unknown }>;
  imagesCount: number;
  progress: number;
};

function baseUrl(): string {
  const fromEnv = env().ODM_API_URL;
  // Local docker-compose exposes NodeODM at :3002 (host) / :3000 (container).
  return (fromEnv || "http://localhost:3002").replace(/\/$/, "");
}

function authHeaders(): Record<string, string> {
  const token = env().ODM_API_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

type OdmInitOptions = {
  name?: string;
  // NodeODM options are name/value pairs; see `/options` endpoint for the list.
  options?: Array<{ name: string; value: unknown }>;
  webhook?: string;
  skipPostProcessing?: boolean;
};

/** Initialize a new task. Returns the server-assigned UUID. */
export async function odmCreateTask(init: OdmInitOptions = {}): Promise<string> {
  const body = new URLSearchParams();
  if (init.name) body.set("name", init.name);
  if (init.options) body.set("options", JSON.stringify(init.options));
  if (init.webhook) body.set("webhook", init.webhook);
  if (init.skipPostProcessing) body.set("skipPostProcessing", "true");

  const res = await fetch(`${baseUrl()}/task/new/init`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...authHeaders(),
    },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`NodeODM init failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { uuid?: string; error?: string };
  if (!json.uuid) throw new Error(`NodeODM init returned no uuid: ${JSON.stringify(json)}`);
  return json.uuid;
}

/** Upload one image to an initialized task. `image` must be a Blob/File. */
export async function odmUploadImage(
  uuid: string,
  image: { name: string; blob: Blob },
): Promise<void> {
  const form = new FormData();
  form.append("images", image.blob, image.name);
  const res = await fetch(`${baseUrl()}/task/new/upload/${uuid}`, {
    method: "POST",
    headers: authHeaders(),
    body: form,
  });
  if (!res.ok) {
    throw new Error(`NodeODM upload failed for ${image.name}: ${res.status} ${await res.text()}`);
  }
}

/** Commit a task for processing after all images have been uploaded. */
export async function odmCommitTask(uuid: string): Promise<void> {
  const res = await fetch(`${baseUrl()}/task/new/commit/${uuid}`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) {
    throw new Error(`NodeODM commit failed: ${res.status} ${await res.text()}`);
  }
}

/** Poll NodeODM for a task's current status. */
export async function odmGetTaskInfo(uuid: string): Promise<OdmTaskInfo> {
  const res = await fetch(`${baseUrl()}/task/${uuid}/info`, {
    headers: authHeaders(),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`NodeODM info failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as OdmTaskInfo;
}

/** Build the download URL for a specific asset of a completed task. */
export function odmAssetUrl(uuid: string, asset: string): string {
  return `${baseUrl()}/task/${uuid}/download/${asset}`;
}

export function odmStatusToOrtho(code: OdmStatusCode): "queued" | "processing" | "ready" | "failed" {
  switch (code) {
    case 10:
      return "queued";
    case 20:
      return "processing";
    case 30:
    case 50:
      return "failed";
    case 40:
      return "ready";
  }
}
