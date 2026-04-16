"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type QaStatus = "pending" | "ai_ok" | "human_reviewed" | "rejected";

type Extraction = {
  id: string;
  model: string;
  prompt: string | null;
  output_layer_id: string | null;
  qa_status: QaStatus;
  metrics: Record<string, unknown> | null;
  created_at: string;
  orthomosaic: {
    id: string;
    cog_url: string | null;
    flight: {
      id: string;
      project: { id: string; slug: string; name: string };
    };
  };
};

const FILTERS: Array<{ value: QaStatus | "all"; label: string }> = [
  { value: "pending", label: "Needs review" },
  { value: "human_reviewed", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "all", label: "All" },
];

export default function ReviewPage() {
  const [filter, setFilter] = useState<QaStatus | "all">("pending");
  const [items, setItems] = useState<Extraction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());

  const load = useCallback(async (f: QaStatus | "all") => {
    setLoading(true);
    setError(null);
    try {
      const url = f === "all" ? "/api/extractions" : `/api/extractions?qaStatus=${f}`;
      const res = await fetch(url, { cache: "no-store" });
      const body = (await res.json()) as { ok: boolean; extractions?: Extraction[]; error?: string };
      if (!res.ok || !body.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setItems(body.extractions ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(filter);
  }, [filter, load]);

  const decide = useCallback(
    async (id: string, qaStatus: QaStatus) => {
      setPendingIds((prev) => new Set(prev).add(id));
      try {
        const res = await fetch(`/api/extractions/${id}/qa`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ qaStatus }),
        });
        const body = (await res.json()) as { ok: boolean; error?: string };
        if (!res.ok || !body.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        setItems((prev) => prev.filter((x) => x.id !== id));
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setPendingIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [],
  );

  return (
    <div className="min-h-screen bg-[color:var(--background)]">
      <header className="border-b border-[color:var(--border)] bg-[color:var(--card)]">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
          <div>
            <Link href="/" className="text-sm font-semibold tracking-tight">
              OpenGeo
            </Link>
            <nav className="mt-1 flex items-center gap-4 text-xs text-[color:var(--muted)]">
              <Link href="/projects" className="hover:text-[color:var(--foreground)]">
                Projects
              </Link>
              <Link href="/map" className="hover:text-[color:var(--foreground)]">
                Map
              </Link>
              <Link href="/review" className="text-[color:var(--foreground)]">
                Review
              </Link>
              <Link href="/status" className="hover:text-[color:var(--foreground)]">
                Status
              </Link>
            </nav>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8">
        <section className="mb-6">
          <h1 className="text-xl font-semibold tracking-tight">AI extraction review</h1>
          <p className="mt-1 max-w-2xl text-sm text-[color:var(--muted)]">
            Planner-in-the-loop QA. Every layer produced by AI feature extraction
            sits here until a human editor approves or rejects it. Approved
            layers carry a <code className="font-mono text-xs">human_reviewed</code>
            tag so downstream consumers know the geometry has been inspected.
          </p>
        </section>

        <div className="mb-4 flex items-center gap-2">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setFilter(f.value)}
              className={
                filter === f.value
                  ? "rounded border border-[color:var(--accent)] bg-[color:var(--accent)]/10 px-3 py-1 text-xs font-semibold text-[color:var(--accent)]"
                  : "rounded border border-[color:var(--border)] px-3 py-1 text-xs text-[color:var(--muted)] hover:text-[color:var(--foreground)]"
              }
            >
              {f.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => load(filter)}
            className="ml-auto rounded border border-[color:var(--border)] px-3 py-1 text-xs font-medium hover:bg-[color:var(--border)]"
          >
            Refresh
          </button>
        </div>

        {error && (
          <div className="mb-4 rounded-md border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-600">
            {error}
          </div>
        )}

        {loading && items.length === 0 ? (
          <p className="text-sm text-[color:var(--muted)]">Loading…</p>
        ) : items.length === 0 ? (
          <p className="rounded-md border border-[color:var(--border)] bg-[color:var(--card)] p-6 text-sm text-[color:var(--muted)]">
            {filter === "pending"
              ? "Inbox empty — all AI extractions have been reviewed."
              : "No extractions match this filter."}
          </p>
        ) : (
          <ul className="space-y-3">
            {items.map((item) => {
              const busy = pendingIds.has(item.id);
              const project = item.orthomosaic.flight.project;
              const featureCount =
                (item.metrics as { featureCount?: number } | null)?.featureCount ?? null;
              return (
                <li
                  key={item.id}
                  className="rounded-md border border-[color:var(--border)] bg-[color:var(--card)] p-4"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="rounded bg-[color:var(--background)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-[color:var(--muted)]">
                          {item.qa_status}
                        </span>
                        <span className="text-[11px] text-[color:var(--muted)]">
                          {new Date(item.created_at).toLocaleString()}
                        </span>
                      </div>
                      <h2 className="mt-2 truncate text-sm font-semibold">
                        {item.prompt ?? "(no prompt)"}
                      </h2>
                      <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-[color:var(--muted)]">
                        <span>
                          project ·{" "}
                          <Link
                            href={`/map/${project.slug}`}
                            className="text-[color:var(--accent)] hover:underline"
                          >
                            {project.name}
                          </Link>
                        </span>
                        <span>model · <code className="font-mono">{item.model}</code></span>
                        {featureCount !== null && <span>{featureCount} features</span>}
                      </div>
                    </div>
                    {item.qa_status === "pending" ? (
                      <div className="flex shrink-0 items-center gap-2">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => decide(item.id, "human_reviewed")}
                          className="rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-600 hover:bg-emerald-500/20 disabled:opacity-50"
                        >
                          {busy ? "…" : "Approve"}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => decide(item.id, "rejected")}
                          className="rounded border border-red-500/40 bg-red-500/10 px-3 py-1 text-xs font-semibold text-red-600 hover:bg-red-500/20 disabled:opacity-50"
                        >
                          {busy ? "…" : "Reject"}
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => decide(item.id, "pending")}
                        className="rounded border border-[color:var(--border)] px-3 py-1 text-xs text-[color:var(--muted)] hover:text-[color:var(--foreground)] disabled:opacity-50"
                      >
                        Reset to pending
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </div>
  );
}
