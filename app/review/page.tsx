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

type AiEventKind =
  | "nl_sql"
  | "nl_style"
  | "crs_detect"
  | "column_type_infer"
  | "change_detect"
  | "change_narrate";

type AiEvent = {
  id: string;
  kind: AiEventKind;
  model: string;
  prompt: string | null;
  response_summary: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

type Tab = "extractions" | "ai_log";

const FILTERS: Array<{ value: QaStatus | "all"; label: string }> = [
  { value: "pending", label: "Needs review" },
  { value: "human_reviewed", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "all", label: "All" },
];

const KIND_LABELS: Record<AiEventKind, string> = {
  nl_sql: "NL → SQL",
  nl_style: "NL → Style",
  crs_detect: "CRS detect",
  column_type_infer: "Column types",
  change_detect: "Change detect",
  change_narrate: "Change narrate",
};

const AI_FILTERS: Array<{ value: AiEventKind | "all"; label: string }> = [
  { value: "all", label: "All prompts" },
  { value: "nl_sql", label: "NL → SQL" },
  { value: "nl_style", label: "NL → Style" },
  { value: "crs_detect", label: "CRS detect" },
  { value: "column_type_infer", label: "Column types" },
  { value: "change_detect", label: "Change detect" },
  { value: "change_narrate", label: "Change narrate" },
];

export default function ReviewPage() {
  const [tab, setTab] = useState<Tab>("extractions");

  // Extraction-review state (existing).
  const [filter, setFilter] = useState<QaStatus | "all">("pending");
  const [items, setItems] = useState<Extraction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());

  // AI-log state (new); kept separate so switching tabs doesn't clobber.
  const [aiFilter, setAiFilter] = useState<AiEventKind | "all">("all");
  const [aiItems, setAiItems] = useState<AiEvent[]>([]);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiHasMore, setAiHasMore] = useState(false);

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

  const loadAi = useCallback(
    async (f: AiEventKind | "all", opts: { append?: boolean; offset?: number } = {}) => {
      setAiLoading(true);
      setAiError(null);
      try {
        const params = new URLSearchParams();
        if (f !== "all") params.set("kind", f);
        if (opts.offset && opts.offset > 0) params.set("offset", String(opts.offset));
        const qs = params.toString();
        const url = qs ? `/api/ai-events?${qs}` : "/api/ai-events";
        const res = await fetch(url, { cache: "no-store" });
        const body = (await res.json()) as {
          ok: boolean;
          events?: AiEvent[];
          hasMore?: boolean;
          error?: string;
        };
        if (!res.ok || !body.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        const next = body.events ?? [];
        setAiItems((prev) => (opts.append ? [...prev, ...next] : next));
        setAiHasMore(Boolean(body.hasMore));
      } catch (e) {
        setAiError((e as Error).message);
      } finally {
        setAiLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (tab === "extractions") load(filter);
  }, [tab, filter, load]);

  useEffect(() => {
    if (tab === "ai_log") loadAi(aiFilter);
  }, [tab, aiFilter, loadAi]);

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
        <section className="mb-5">
          <h1 className="text-xl font-semibold tracking-tight">
            {tab === "extractions" ? "AI extraction review" : "AI audit log"}
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-[color:var(--muted)]">
            {tab === "extractions" ? (
              <>
                Planner-in-the-loop QA. Every layer produced by AI feature extraction
                sits here until a human editor approves or rejects it. Approved
                layers carry a <code className="font-mono text-xs">human_reviewed</code>
                tag so downstream consumers know the geometry has been inspected.
              </>
            ) : (
              <>
                Read-only history of the last 50 AI decisions in this org —
                natural-language SQL, map styling, CRS auto-detect on ingest, and
                column-type inference — with the rationale the model returned.
                Use it to audit what the AI has been asked for and what it
                decided.
              </>
            )}
          </p>
        </section>

        <div className="mb-4 flex items-center gap-1 border-b border-[color:var(--border)]">
          {(
            [
              { value: "extractions", label: "Extraction review" },
              { value: "ai_log", label: "AI audit log" },
            ] as Array<{ value: Tab; label: string }>
          ).map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => setTab(t.value)}
              className={
                tab === t.value
                  ? "-mb-px border-b-2 border-[color:var(--accent)] px-3 py-2 text-xs font-semibold text-[color:var(--foreground)]"
                  : "-mb-px border-b-2 border-transparent px-3 py-2 text-xs text-[color:var(--muted)] hover:text-[color:var(--foreground)]"
              }
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "extractions" && (
          <>
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
                            href={`/map/${project.slug}?projectId=${project.id}`}
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
          </>
        )}

        {tab === "ai_log" && (
          <>
            <div className="mb-4 flex items-center gap-2">
              {AI_FILTERS.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  onClick={() => setAiFilter(f.value)}
                  className={
                    aiFilter === f.value
                      ? "rounded border border-[color:var(--accent)] bg-[color:var(--accent)]/10 px-3 py-1 text-xs font-semibold text-[color:var(--accent)]"
                      : "rounded border border-[color:var(--border)] px-3 py-1 text-xs text-[color:var(--muted)] hover:text-[color:var(--foreground)]"
                  }
                >
                  {f.label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => loadAi(aiFilter)}
                className="ml-auto rounded border border-[color:var(--border)] px-3 py-1 text-xs font-medium hover:bg-[color:var(--border)]"
              >
                Refresh
              </button>
            </div>

            {aiError && (
              <div className="mb-4 rounded-md border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-600">
                {aiError}
              </div>
            )}

            {aiLoading && aiItems.length === 0 ? (
              <p className="text-sm text-[color:var(--muted)]">Loading…</p>
            ) : aiItems.length === 0 ? (
              <div className="rounded-md border border-[color:var(--border)] bg-[color:var(--card)] p-6 text-sm text-[color:var(--muted)]">
                <p>
                  No AI prompts to show. Either none have been logged yet, or
                  AI audit entries are visible to org admins only.
                </p>
              </div>
            ) : (
              <>
                <ul className="space-y-3">
                  {aiItems.map((ev) => (
                    <AiEventCard key={ev.id} event={ev} />
                  ))}
                </ul>
                {aiHasMore && (
                  <div className="mt-4 flex justify-center">
                    <button
                      type="button"
                      disabled={aiLoading}
                      onClick={() =>
                        loadAi(aiFilter, { append: true, offset: aiItems.length })
                      }
                      className="rounded border border-[color:var(--border)] px-4 py-1.5 text-xs font-medium hover:bg-[color:var(--border)] disabled:opacity-50"
                    >
                      {aiLoading ? "Loading…" : "Load more"}
                    </button>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}

function AiEventCard({ event }: { event: AiEvent }) {
  const kindLabel = KIND_LABELS[event.kind] ?? event.kind;
  const metadata = event.metadata ?? {};
  const rationale =
    typeof metadata.rationale === "string"
      ? (metadata.rationale as string)
      : null;
  const summary = event.response_summary ?? "";

  // Each kind gets a compact one-line hint so the reader can see at-a-glance
  // what happened without expanding metadata. For nl_sql, response_summary
  // already carries the truncated rationale from the logger.
  let patchHint: string | null = null;
  if (event.kind === "nl_style") {
    const patch = (metadata.patch ?? null) as
      | { paint?: Record<string, unknown>; layout?: Record<string, unknown> }
      | null;
    const paintKeys = patch?.paint ? Object.keys(patch.paint) : [];
    const layoutKeys = patch?.layout ? Object.keys(patch.layout) : [];
    const parts: string[] = [];
    if (paintKeys.length > 0) parts.push(`paint: ${paintKeys.join(", ")}`);
    if (layoutKeys.length > 0) parts.push(`layout: ${layoutKeys.join(", ")}`);
    patchHint = parts.length > 0 ? parts.join(" · ") : "declined (empty patch)";
  } else if (event.kind === "crs_detect") {
    const source =
      typeof metadata.source === "string" ? (metadata.source as string) : null;
    const epsg =
      typeof metadata.epsg === "number" ? (metadata.epsg as number) : null;
    const fileName =
      typeof metadata.fileName === "string"
        ? (metadata.fileName as string)
        : null;
    const parts: string[] = [];
    if (epsg) parts.push(`EPSG:${epsg}`);
    if (source) parts.push(`source: ${source}`);
    if (fileName) parts.push(fileName);
    patchHint = parts.length > 0 ? parts.join(" · ") : null;
  } else if (event.kind === "column_type_infer") {
    const hints = Array.isArray(metadata.hints)
      ? (metadata.hints as Array<{ field?: string; inferred?: string }>)
      : [];
    const summaryParts = hints
      .filter((h) => typeof h.field === "string" && typeof h.inferred === "string")
      .map((h) => `${h.field}: ${h.inferred}`)
      .slice(0, 6);
    const more = hints.length > summaryParts.length ? ` +${hints.length - summaryParts.length} more` : "";
    patchHint = summaryParts.length > 0 ? `${summaryParts.join(", ")}${more}` : null;
  }

  // Ingest-kind events don't carry a user prompt — the "prompt" slot holds the
  // .prj WKT for crs_detect, or is empty for column_type_infer. Fall back to
  // the response summary so the card is never a silent blank.
  const promptFull =
    event.prompt ??
    (event.kind === "crs_detect" || event.kind === "column_type_infer"
      ? summary || "(no prompt)"
      : "(no prompt)");
  const promptTruncated =
    promptFull.length > 200 ? `${promptFull.slice(0, 200)}…` : promptFull;

  return (
    <li className="rounded-md border border-[color:var(--border)] bg-[color:var(--card)] p-4">
      <div className="flex items-center gap-2">
        <span className="rounded bg-[color:var(--background)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-[color:var(--muted)]">
          {kindLabel}
        </span>
        <span className="text-[11px] text-[color:var(--muted)]">
          {new Date(event.created_at).toLocaleString()}
        </span>
        <span className="text-[11px] text-[color:var(--muted)]">
          model · <code className="font-mono">{event.model}</code>
        </span>
      </div>
      <p
        className="mt-2 text-sm text-[color:var(--foreground)]"
        title={promptFull}
      >
        {promptTruncated}
      </p>
      {rationale && (
        <div className="mt-2 rounded border border-[color:var(--border)] bg-[color:var(--background)]/60 px-2 py-1.5">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--muted)]">
            Rationale
          </p>
          <p className="mt-0.5 text-[11px] leading-snug text-[color:var(--foreground)]">
            {rationale}
          </p>
        </div>
      )}
      {!rationale && summary && (
        <p className="mt-2 text-[11px] text-[color:var(--muted)]">{summary}</p>
      )}
      {patchHint && (
        <p className="mt-2 text-[11px] text-[color:var(--muted)]">
          <code className="font-mono">{patchHint}</code>
        </p>
      )}
    </li>
  );
}
