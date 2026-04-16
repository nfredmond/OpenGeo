"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type Check =
  | { name: string; status: "ok"; details?: string }
  | { name: string; status: "degraded" | "down"; error: string };

type HealthResponse = {
  status: "ok" | "degraded" | "down";
  service: string;
  version: string;
  ts: string;
  flags: {
    aiNlSql: boolean;
    aiStyleGen: boolean;
    aiFeatureExtraction: boolean;
    dronePipeline: boolean;
    anthropicKeySet: boolean;
  };
  checks: Check[];
};

export default function StatusPage() {
  const [data, setData] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/health?deep=1", { cache: "no-store" });
      const body = (await res.json()) as HealthResponse;
      setData(body);
      setFetchedAt(new Date());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

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
              <Link href="/status" className="text-[color:var(--foreground)]">
                Status
              </Link>
            </nav>
          </div>
          <button
            type="button"
            onClick={refresh}
            disabled={loading}
            className="rounded border border-[color:var(--border)] px-3 py-1 text-xs font-medium hover:bg-[color:var(--border)] disabled:opacity-50"
          >
            {loading ? "Checking…" : "Refresh"}
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8">
        <section className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Stack status</h1>
            <p className="mt-1 text-sm text-[color:var(--muted)]">
              Live check of Supabase + tile/feature servers. Fetched from{" "}
              <code className="font-mono text-xs">/api/health?deep=1</code>.
            </p>
          </div>
          {data && (
            <StatusBadge status={data.status} />
          )}
        </section>

        {error && (
          <div className="mb-4 rounded-md border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-600">
            {error}
          </div>
        )}

        {data && (
          <>
            <ul className="mb-8 grid gap-3 sm:grid-cols-2">
              {data.checks.map((check) => (
                <li
                  key={check.name}
                  className="rounded-md border border-[color:var(--border)] bg-[color:var(--card)] p-4"
                >
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="font-mono text-sm font-semibold">{check.name}</h2>
                    <StatusBadge status={check.status} />
                  </div>
                  <p className="mt-2 text-xs text-[color:var(--muted)]">
                    {check.status === "ok"
                      ? (check.details ?? "responding")
                      : check.error}
                  </p>
                </li>
              ))}
            </ul>

            <section className="rounded-md border border-[color:var(--border)] bg-[color:var(--card)] p-5">
              <h2 className="mb-3 text-sm font-semibold">Feature flags</h2>
              <ul className="grid gap-2 sm:grid-cols-2">
                <FlagRow label="AI NL → SQL" on={data.flags.aiNlSql} />
                <FlagRow label="AI style gen" on={data.flags.aiStyleGen} />
                <FlagRow label="AI feature extraction" on={data.flags.aiFeatureExtraction} />
                <FlagRow label="Drone pipeline" on={data.flags.dronePipeline} />
                <FlagRow label="ANTHROPIC_API_KEY set" on={data.flags.anthropicKeySet} />
              </ul>
            </section>

            <p className="mt-4 text-[11px] text-[color:var(--muted)]">
              {fetchedAt
                ? `Last checked ${fetchedAt.toLocaleTimeString()} · service ${data.service} v${data.version}`
                : null}
            </p>
          </>
        )}
      </main>
    </div>
  );
}

function StatusBadge({ status }: { status: "ok" | "degraded" | "down" }) {
  const color =
    status === "ok"
      ? "bg-emerald-500/20 text-emerald-600 border-emerald-500/40"
      : status === "degraded"
        ? "bg-amber-500/20 text-amber-600 border-amber-500/40"
        : "bg-red-500/20 text-red-600 border-red-500/40";
  return (
    <span className={`rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${color}`}>
      {status}
    </span>
  );
}

function FlagRow({ label, on }: { label: string; on: boolean }) {
  return (
    <li className="flex items-center justify-between rounded border border-[color:var(--border)] bg-[color:var(--background)] px-3 py-2 text-xs">
      <span>{label}</span>
      <span
        className={
          on
            ? "rounded bg-emerald-500/20 px-2 py-0.5 text-[10px] font-semibold text-emerald-600"
            : "rounded bg-[color:var(--border)] px-2 py-0.5 text-[10px] font-semibold text-[color:var(--muted)]"
        }
      >
        {on ? "on" : "off"}
      </span>
    </li>
  );
}
