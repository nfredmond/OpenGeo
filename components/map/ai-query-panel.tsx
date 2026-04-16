"use client";

import { Sparkles } from "lucide-react";
import { useState } from "react";
import type { ClientLayer } from "./layer-panel";
import { pickColor } from "./colors";

export function AiQueryPanel({
  onLayerAdded,
}: {
  onLayerAdded: (layer: ClientLayer) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [sql, setSql] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    setSql(null);

    try {
      const res = await fetch("/api/ai/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const body = (await res.json()) as
        | {
            ok: true;
            sql: string;
            featureCollection: GeoJSON.FeatureCollection;
            label: string;
          }
        | { ok: false; error: string; sql?: string };
      if (!res.ok || !body.ok) {
        setError(body.ok === false ? body.error : "Query failed.");
        if (body.ok === false && body.sql) setSql(body.sql);
        return;
      }

      setSql(body.sql);
      onLayerAdded({
        id: `ai-${Date.now().toString(36)}`,
        name: body.label,
        color: pickColor(),
        visible: true,
        source: "ai-query",
        data: body.featureCollection,
        featureCount: body.featureCollection.features.length,
      });
      setPrompt("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="border-t border-[color:var(--border)] bg-[color:var(--background)] px-5 py-4">
      <header className="mb-2 flex items-center gap-2">
        <Sparkles size={14} className="text-[color:var(--accent)]" />
        <h2 className="text-xs font-semibold uppercase tracking-wider text-[color:var(--muted)]">
          Ask the map
        </h2>
      </header>
      <form onSubmit={run} className="flex flex-col gap-2">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="e.g. Show buildings larger than 200 sqm within 100m of Main St"
          rows={3}
          className="w-full rounded-md border border-[color:var(--border)] bg-[color:var(--card)] px-3 py-2 text-sm shadow-sm focus:border-[color:var(--accent)] focus:outline-none"
        />
        <button
          type="submit"
          disabled={busy || !prompt.trim()}
          className="rounded-md bg-[color:var(--accent)] px-3 py-2 text-sm font-medium text-[color:var(--accent-foreground)] transition hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Running…" : "Run"}
        </button>
      </form>

      {sql && (
        <pre className="mt-3 max-h-40 overflow-auto rounded border border-[color:var(--border)] bg-[color:var(--card)] p-2 text-[11px] leading-snug text-[color:var(--muted)]">
          {sql}
        </pre>
      )}
      {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
      <p className="mt-2 text-[11px] leading-snug text-[color:var(--muted)]">
        AI queries execute under a read-only Postgres role. SELECT statements
        only. Results are logged to{" "}
        <code className="font-mono">ai_events</code>.
      </p>
    </section>
  );
}
