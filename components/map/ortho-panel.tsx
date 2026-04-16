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
  status: OrthoStatus;
  progress?: number;
};

// Two paths to register an orthomosaic:
//   cog:     paste a pre-processed COG URL (fast, for already-processed orthos)
//   imagery: upload raw drone images; server submits to NodeODM and polls
//            until a COG is produced, then swaps in the result.
export function OrthoPanel({
  onLayerAdded,
  projectId,
}: {
  onLayerAdded: (layer: ClientLayer) => void;
  projectId?: string;
}) {
  const [mode, setMode] = useState<Mode>("cog");
  const [cogUrl, setCogUrl] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingOdm | null>(null);
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
      onLayerAdded({
        id: `ortho-${orthoBody.orthomosaicId}`,
        name: displayName,
        color: pickColor(),
        visible: true,
        source: "orthomosaic",
        kind: "raster",
        cogUrl: cogUrl.trim(),
        featureCount: 0,
      });
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
          error?: string;
        };
        if (!submitRes.ok || !submitBody.ok || !submitBody.orthomosaicId) {
          throw new Error(submitBody.error ?? "Failed to submit ODM task.");
        }
        setPending({
          orthomosaicId: submitBody.orthomosaicId,
          flightId,
          displayName,
          status: "processing",
        });
        setName("");
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [name, projectId],
  );

  // Poll NodeODM through our refresh route until the orthomosaic is ready
  // or fails. 5s cadence is plenty for small demo flights; real flights
  // often take 10+ minutes so the backoff below slows after a minute.
  useEffect(() => {
    if (!pending || pending.status === "ready" || pending.status === "failed") return;

    let cancelled = false;
    let delay = 5000;
    let elapsed = 0;

    const tick = async () => {
      if (cancelled) return;
      try {
        const res = await fetch(`/api/orthomosaics/${pending.orthomosaicId}/refresh`, {
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
          setError(body.error ?? "ODM poll failed.");
          return;
        }
        setPending((prev) =>
          prev ? { ...prev, status: body.status!, progress: body.progress } : prev,
        );
        if (body.status === "ready" && body.cogUrl) {
          onLayerAdded({
            id: `ortho-${pending.orthomosaicId}`,
            name: pending.displayName,
            color: pickColor(),
            visible: true,
            source: "orthomosaic",
            kind: "raster",
            cogUrl: body.cogUrl,
            featureCount: 0,
          });
          return;
        }
        if (body.status === "failed") {
          setError("NodeODM processing failed for this flight.");
          return;
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
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
  }, [pending, onLayerAdded]);

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

      {pending && (
        <div className="mt-2 rounded border border-[color:var(--border)] bg-[color:var(--card)] px-2 py-1.5 text-[10px]">
          <div className="flex items-center justify-between">
            <span className="font-medium">{pending.displayName}</span>
            <span className="text-[color:var(--muted)]">{pending.status}</span>
          </div>
          {typeof pending.progress === "number" && (
            <div className="mt-1 h-1 w-full overflow-hidden rounded bg-[color:var(--border)]">
              <div
                className="h-full bg-[color:var(--accent)]"
                style={{ width: `${Math.min(100, Math.max(2, pending.progress))}%` }}
              />
            </div>
          )}
        </div>
      )}

      {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
    </section>
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
