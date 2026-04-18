"use client";

import { GitCompare } from "lucide-react";
import { useMemo, useState } from "react";
import type { ClientLayer } from "./layer-panel";
import { pickColor } from "./colors";

// Compare two vector layers → render a change-typed diff layer with
// red (removed) / green (added) / amber (modified) feature colors.
// The route handles all auth + persistence; this panel only talks to it.
//
// Only vector layers participate: raster orthomosaics don't have
// discrete features, and vector-tile-backed layers (>2000 features) would
// need a tile-side diff that's out of scope for the feature-level v1.
export function ComparePanel({
  layers,
  onLayerAdded,
}: {
  layers: ClientLayer[];
  onLayerAdded: (layer: ClientLayer) => void;
}) {
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [busy, setBusy] = useState(false);
  const [narrative, setNarrative] = useState<string | null>(null);
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const candidates = useMemo(
    () =>
      layers.filter(
        (l): l is Extract<ClientLayer, { kind?: "vector" }> =>
          l.kind === undefined || l.kind === "vector",
      ),
    [layers],
  );

  const canRun = fromId && toId && fromId !== toId && !busy;

  async function run(e: React.FormEvent) {
    e.preventDefault();
    if (!canRun) return;
    setBusy(true);
    setError(null);
    setNarrative(null);
    setCounts(null);

    try {
      const res = await fetch("/api/flights/diff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fromLayerId: fromId, toLayerId: toId }),
      });
      const body = (await res.json()) as {
        ok: boolean;
        layerId?: string | null;
        counts?: Record<string, number>;
        narrative?: string | null;
        featureCollection?: GeoJSON.FeatureCollection;
        error?: string;
      };
      if (!res.ok || !body.ok) {
        setError(body.error ?? `Compare failed (${res.status}).`);
        return;
      }
      setCounts(body.counts ?? null);
      setNarrative(body.narrative ?? null);

      if (body.layerId && body.featureCollection) {
        const from = candidates.find((l) => l.id === fromId);
        const to = candidates.find((l) => l.id === toId);
        onLayerAdded({
          id: body.layerId,
          name: `Δ ${from?.name ?? "A"} → ${to?.name ?? "B"}`,
          color: pickColor(),
          visible: true,
          source: "ai-query",
          kind: "vector",
          data: body.featureCollection,
          featureCount: body.featureCollection.features.length,
          // Paint by change_type — MapLibre match expression on the property
          // that diffFeatures attaches to every output feature.
          style: {
            paint: {
              "fill-color": [
                "match",
                ["get", "change_type"],
                "added",
                "#16a34a",
                "removed",
                "#dc2626",
                "modified",
                "#f59e0b",
                "#9ca3af",
              ],
              "circle-color": [
                "match",
                ["get", "change_type"],
                "added",
                "#16a34a",
                "removed",
                "#dc2626",
                "modified",
                "#f59e0b",
                "#9ca3af",
              ],
              "line-color": [
                "match",
                ["get", "change_type"],
                "added",
                "#16a34a",
                "removed",
                "#dc2626",
                "modified",
                "#f59e0b",
                "#9ca3af",
              ],
              "fill-opacity": 0.4,
              "circle-radius": 6,
              "line-width": 2,
            },
          },
        });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (candidates.length < 2) return null;

  return (
    <section className="border-t border-[color:var(--border)] bg-[color:var(--background)] px-5 py-4">
      <header className="mb-2 flex items-center gap-2">
        <GitCompare size={14} className="text-[color:var(--muted)]" />
        <h2 className="text-xs font-semibold uppercase tracking-wider text-[color:var(--muted)]">
          Compare layers
        </h2>
      </header>
      <form onSubmit={run} className="flex flex-col gap-2 text-xs">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-[color:var(--muted)]">
            From
          </span>
          <select
            value={fromId}
            onChange={(e) => setFromId(e.target.value)}
            className="rounded-md border border-[color:var(--border)] bg-[color:var(--card)] px-2 py-1.5"
          >
            <option value="">— choose a baseline layer —</option>
            {candidates.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name} ({l.featureCount})
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-[color:var(--muted)]">
            To
          </span>
          <select
            value={toId}
            onChange={(e) => setToId(e.target.value)}
            className="rounded-md border border-[color:var(--border)] bg-[color:var(--card)] px-2 py-1.5"
          >
            <option value="">— choose a newer layer —</option>
            {candidates.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name} ({l.featureCount})
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={!canRun}
          className="rounded-md bg-[color:var(--accent)] px-3 py-2 font-medium text-[color:var(--accent-foreground)] transition hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Comparing…" : "Compare"}
        </button>
      </form>

      {counts && (
        <div className="mt-3 flex flex-wrap gap-1 text-[11px]">
          <span className="rounded bg-green-500/20 px-2 py-0.5 text-green-700 dark:text-green-400">
            +{counts.added ?? 0} added
          </span>
          <span className="rounded bg-red-500/20 px-2 py-0.5 text-red-700 dark:text-red-400">
            −{counts.removed ?? 0} removed
          </span>
          <span className="rounded bg-amber-500/20 px-2 py-0.5 text-amber-700 dark:text-amber-400">
            Δ{counts.modified ?? 0} modified
          </span>
        </div>
      )}
      {narrative && (
        <div className="mt-2 rounded border border-[color:var(--border)] bg-[color:var(--card)] px-2 py-1.5">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--muted)]">
            AI narration
          </p>
          <p className="mt-0.5 text-[11px] leading-snug">{narrative}</p>
        </div>
      )}
      {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
    </section>
  );
}
