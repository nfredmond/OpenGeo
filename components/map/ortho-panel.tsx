"use client";

import { Plane } from "lucide-react";
import { useState } from "react";
import type { ClientLayer } from "./layer-panel";
import { pickColor } from "./colors";

// Registers a pre-processed COG orthomosaic (already on R2, S3, or any HTTPS
// host) against a new drone_flights row. Direct imagery upload + ODM
// orchestration lands in the next chunk — this covers the "already
// processed elsewhere" case, which is the common on-boarding path for
// planners who already have their orthos.
export function OrthoPanel({
  onLayerAdded,
}: {
  onLayerAdded: (layer: ClientLayer) => void;
}) {
  const [cogUrl, setCogUrl] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!cogUrl.trim() || busy) return;
    setBusy(true);
    setError(null);

    try {
      const displayName = name.trim() || deriveNameFromUrl(cogUrl) || "Orthomosaic";

      const flightRes = await fetch("/api/flights", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          flownAt: new Date().toISOString(),
          metadata: { registeredFromUrl: true, displayName },
        }),
      });
      const flightBody = (await flightRes.json()) as { ok: boolean; flightId?: string; error?: string };
      if (!flightRes.ok || !flightBody.ok || !flightBody.flightId) {
        throw new Error(flightBody.error ?? "Failed to create flight.");
      }

      const orthoRes = await fetch(`/api/flights/${flightBody.flightId}/orthomosaics`, {
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

  return (
    <section className="border-b border-[color:var(--border)] bg-[color:var(--background)] px-5 py-4">
      <header className="mb-2 flex items-center gap-2">
        <Plane size={14} className="text-[color:var(--muted)]" />
        <h2 className="text-xs font-semibold uppercase tracking-wider text-[color:var(--muted)]">
          Register orthomosaic
        </h2>
      </header>
      <form onSubmit={onSubmit} className="flex flex-col gap-2">
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
      {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
    </section>
  );
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
