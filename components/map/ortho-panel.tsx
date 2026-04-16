"use client";

import { Plane, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientLayer } from "./layer-panel";
import { pickColor } from "./colors";

type Mode = "cog" | "imagery";

type OrthoStatus = "queued" | "processing" | "ready" | "failed";

type PendingOdm = {
  orthomosaicId: string;
  flightId: string;
  displayName: string;
  imageCount: number;
  workflowRunId: string | null;
};

// Two paths to register an orthomosaic:
//   cog:     paste a pre-processed COG URL (fast, for already-processed orthos)
//   imagery: upload raw drone images; server submits to NodeODM and polls
//            until a COG is produced, then swaps in the result.
export function OrthoPanel({
  onLayerAdded,
  onLayerReady,
  projectId,
}: {
  onLayerAdded: (layer: ClientLayer) => void;
  onLayerReady?: (layerId: string) => void;
  projectId?: string;
}) {
  const [mode, setMode] = useState<Mode>("cog");
  const [cogUrl, setCogUrl] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingOdm[]>([]);
  const [dragging, setDragging] = useState(false);
  const imageryRef = useRef<HTMLInputElement>(null);

  async function onSubmitCog(e: React.FormEvent) {
    e.preventDefault();
    if (!cogUrl.trim() || busy) return;
    setBusy(true);
    setError(null);

    try {
      const displayName = name.trim() || deriveNameFromUrl(cogUrl) || "Orthomosaic";
      const flightId = await createFlight(projectId, displayName);
      const orthoRes = await fetch(`/api/flights/${flightId}/orthomosaics`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cogUrl: cogUrl.trim(), status: "ready" }),
      });
      const orthoBody = (await orthoRes.json()) as {
        ok: boolean;
        orthomosaicId?: string;
        error?: string;
      };
      if (!orthoRes.ok || !orthoBody.ok || !orthoBody.orthomosaicId) {
        throw new Error(orthoBody.error ?? "Failed to register orthomosaic.");
      }
      const layerId = `ortho-${orthoBody.orthomosaicId}`;
      onLayerAdded({
        id: layerId,
        name: displayName,
        color: pickColor(),
        visible: true,
        source: "orthomosaic",
        kind: "raster",
        cogUrl: cogUrl.trim(),
        featureCount: 0,
      });
      onLayerReady?.(layerId);
      setCogUrl("");
      setName("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const startImageryUpload = useCallback(
    async (files: File[]) => {
      if (files.length < 2) {
        setError("Upload at least 2 drone images — NodeODM needs overlap to reconstruct.");
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const displayName = name.trim() || `flight-${new Date().toISOString().slice(0, 10)}`;
        const flightId = await createFlight(projectId, displayName);
        const form = new FormData();
        for (const f of files) form.append("images", f, f.name);
        form.append("name", displayName);
        form.append("displayName", displayName);

        const submitRes = await fetch(`/api/flights/${flightId}/odm`, {
          method: "POST",
          body: form,
        });
        const submitBody = (await submitRes.json()) as {
          ok: boolean;
          orthomosaicId?: string;
          workflowRunId?: string | null;
          error?: string;
        };
        if (!submitRes.ok || !submitBody.ok || !submitBody.orthomosaicId) {
          throw new Error(submitBody.error ?? "Failed to submit ODM task.");
        }
        setPending((prev) => [
          ...prev,
          {
            orthomosaicId: submitBody.orthomosaicId!,
            flightId,
            displayName,
            imageCount: files.length,
            workflowRunId: submitBody.workflowRunId ?? null,
          },
        ]);
        setName("");
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [name, projectId],
  );

  const dropPending = useCallback((orthomosaicId: string) => {
    setPending((prev) => prev.filter((p) => p.orthomosaicId !== orthomosaicId));
  }, []);

  const handleReady = useCallback(
    (entry: PendingOdm, cogUrl: string) => {
      const layerId = `ortho-${entry.orthomosaicId}`;
      onLayerAdded({
        id: layerId,
        name: entry.displayName,
        color: pickColor(),
        visible: true,
        source: "orthomosaic",
        kind: "raster",
        cogUrl,
        featureCount: 0,
      });
      onLayerReady?.(layerId);
      // Leave the "Ready" pill visible briefly so the user sees the state flip.
      setTimeout(() => dropPending(entry.orthomosaicId), 2500);
    },
    [onLayerAdded, onLayerReady, dropPending],
  );

  return (
    <section className="border-b border-[color:var(--border)] bg-[color:var(--background)] px-5 py-4">
      <header className="mb-2 flex items-center gap-2">
        <Plane size={14} className="text-[color:var(--muted)]" />
        <h2 className="text-xs font-semibold uppercase tracking-wider text-[color:var(--muted)]">
          Orthomosaic
        </h2>
      </header>

      <div className="mb-3 flex gap-1 rounded border border-[color:var(--border)] bg-[color:var(--card)] p-0.5 text-[10px]">
        <ModeBtn active={mode === "cog"} onClick={() => setMode("cog")}>
          From COG URL
        </ModeBtn>
        <ModeBtn active={mode === "imagery"} onClick={() => setMode("imagery")}>
          From raw images
        </ModeBtn>
      </div>

      {mode === "cog" ? (
        <form onSubmit={onSubmitCog} className="flex flex-col gap-2">
          <input
            type="url"
            value={cogUrl}
            onChange={(e) => setCogUrl(e.target.value)}
            placeholder="https://… (COG URL)"
            className="w-full rounded border border-[color:var(--border)] bg-[color:var(--card)] px-3 py-2 text-xs outline-none focus:border-[color:var(--accent)]"
            required
          />
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Display name (optional)"
            className="w-full rounded border border-[color:var(--border)] bg-[color:var(--card)] px-3 py-2 text-xs outline-none focus:border-[color:var(--accent)]"
          />
          <button
            type="submit"
            disabled={busy || !cogUrl.trim()}
            className="rounded bg-[color:var(--accent)] px-3 py-2 text-xs font-medium text-white transition hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Registering…" : "Register"}
          </button>
        </form>
      ) : (
        <div className="flex flex-col gap-2">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Display name (optional)"
            className="w-full rounded border border-[color:var(--border)] bg-[color:var(--card)] px-3 py-2 text-xs outline-none focus:border-[color:var(--accent)]"
          />
          <label
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              void startImageryUpload(Array.from(e.dataTransfer.files));
            }}
            className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded-md border-2 border-dashed px-4 py-6 text-center transition ${
              dragging
                ? "border-[color:var(--accent)] bg-[color:var(--accent)]/10"
                : "border-[color:var(--border)] hover:border-[color:var(--accent)]"
            } ${busy ? "opacity-60" : ""}`}
          >
            <Upload size={16} className="text-[color:var(--muted)]" />
            <span className="text-xs font-medium">
              {busy ? "Uploading…" : "Drop drone images"}
            </span>
            <span className="text-[10px] text-[color:var(--muted)]">
              .jpg / .tif · 2+ with overlap
            </span>
            <input
              ref={imageryRef}
              type="file"
              accept="image/jpeg,image/tiff,.jpg,.jpeg,.tif,.tiff"
              multiple
              hidden
              disabled={busy}
              onChange={(e) => {
                const files = e.target.files ? Array.from(e.target.files) : [];
                if (files.length) void startImageryUpload(files);
              }}
            />
          </label>
          <p className="text-[10px] text-[color:var(--muted)]">
            Requires FEATURE_DRONE_PIPELINE=true and a running NodeODM.
          </p>
        </div>
      )}

      {pending.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {pending.map((p) => (
            <PendingRow
              key={p.orthomosaicId}
              entry={p}
              onReady={handleReady}
              onFailed={(msg) => {
                setError(msg);
                dropPending(p.orthomosaicId);
              }}
            />
          ))}
        </ul>
      )}

      {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
    </section>
  );
}

// Polls NodeODM through our refresh route until the orthomosaic is ready or
// fails. Each pending entry owns its own effect so concurrent uploads don't
// share a single backoff clock.
function PendingRow({
  entry,
  onReady,
  onFailed,
}: {
  entry: PendingOdm;
  onReady: (entry: PendingOdm, cogUrl: string) => void;
  onFailed: (message: string) => void;
}) {
  const [status, setStatus] = useState<OrthoStatus>("processing");
  const [progress, setProgress] = useState<number | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    let delay = 5000;
    let elapsed = 0;

    const tick = async () => {
      if (cancelled) return;
      try {
        const res = await fetch(`/api/orthomosaics/${entry.orthomosaicId}/refresh`, {
          method: "POST",
        });
        const body = (await res.json()) as {
          ok: boolean;
          status?: OrthoStatus;
          cogUrl?: string;
          progress?: number;
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok || !body.ok || !body.status) {
          onFailed(body.error ?? "ODM poll failed.");
          return;
        }
        setStatus(body.status);
        setProgress(body.progress);
        if (body.status === "ready" && body.cogUrl) {
          onReady(entry, body.cogUrl);
          return;
        }
        if (body.status === "failed") {
          onFailed(`NodeODM processing failed for ${entry.displayName}.`);
          return;
        }
      } catch (e) {
        if (!cancelled) onFailed((e as Error).message);
        return;
      }

      elapsed += delay;
      if (elapsed > 60_000) delay = 15_000;
      if (elapsed > 300_000) delay = 30_000;
      if (!cancelled) setTimeout(tick, delay);
    };

    const t = setTimeout(tick, delay);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [entry, onReady, onFailed]);

  return (
    <li className="rounded border border-[color:var(--border)] bg-[color:var(--card)] px-2 py-1.5 text-[10px]">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-medium">{entry.displayName}</span>
        <span className="text-[color:var(--muted)]">
          {status === "ready" ? "Ready" : status}
          {typeof progress === "number" && status !== "ready" && status !== "failed"
            ? ` · ${Math.round(progress)}%`
            : ""}
        </span>
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-[9px] text-[color:var(--muted)]">
        <span>{entry.imageCount} images</span>
        {entry.workflowRunId && <WorkflowRunChip runId={entry.workflowRunId} />}
      </div>
      {typeof progress === "number" && status !== "ready" && status !== "failed" && (
        <div className="mt-1 h-1 w-full overflow-hidden rounded bg-[color:var(--border)]">
          <div
            className="h-full bg-[color:var(--accent)]"
            style={{ width: `${Math.min(100, Math.max(2, progress))}%` }}
          />
        </div>
      )}
    </li>
  );
}

// Shows a truncated run id. Click copies `npx workflow web <id>` so operators
// can pivot from the pending row straight into the durable-run trace.
function WorkflowRunChip({ runId }: { runId: string }) {
  const [copied, setCopied] = useState(false);
  const short = runId.length > 10 ? `${runId.slice(0, 8)}…` : runId;
  return (
    <button
      type="button"
      title={`Copy: npx workflow web ${runId}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(`npx workflow web ${runId}`);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard may be unavailable in non-secure contexts; fall back
          // to a no-op rather than surfacing an error for a nice-to-have.
        }
      }}
      className="rounded border border-[color:var(--border)] px-1 py-0.5 font-mono text-[9px] text-[color:var(--muted)] hover:border-[color:var(--accent)] hover:text-[color:var(--foreground)]"
    >
      {copied ? "copied" : `run · ${short}`}
    </button>
  );
}

function ModeBtn({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 rounded px-2 py-1 font-medium uppercase tracking-wider transition ${
        active
          ? "bg-[color:var(--accent)] text-white"
          : "text-[color:var(--muted)] hover:text-[color:var(--foreground)]"
      }`}
    >
      {children}
    </button>
  );
}

async function createFlight(projectId: string | undefined, displayName: string): Promise<string> {
  const res = await fetch("/api/flights", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId,
      flownAt: new Date().toISOString(),
      metadata: { registeredFromUrl: false, displayName },
    }),
  });
  const body = (await res.json()) as { ok: boolean; flightId?: string; error?: string };
  if (!res.ok || !body.ok || !body.flightId) {
    throw new Error(body.error ?? "Failed to create flight.");
  }
  return body.flightId;
}

function deriveNameFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const path = u.pathname.split("/").pop() ?? "";
    return path.replace(/\.(tif|tiff|cog)$/i, "") || null;
  } catch {
    return null;
  }
}
