"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function NewProjectForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slugTouched, setSlugTouched] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !slug.trim() || busy) return;
    setBusy(true);
    setError(null);

    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), slug: slug.trim() }),
      });
      const body = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !body.ok) {
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      setName("");
      setSlug("");
      setSlugTouched(false);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function onNameChange(value: string) {
    setName(value);
    if (!slugTouched) {
      setSlug(slugify(value));
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="rounded-md border border-[color:var(--border)] bg-[color:var(--card)] p-4"
    >
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-[color:var(--muted)]">
        New project
      </h2>
      <div className="space-y-2">
        <label className="block text-xs text-[color:var(--muted)]">
          Name
          <input
            type="text"
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder="Grass Valley RTP 2028"
            className="mt-1 w-full rounded border border-[color:var(--border)] bg-[color:var(--background)] px-2 py-1.5 text-sm text-[color:var(--foreground)] outline-none focus:border-[color:var(--accent)]"
            required
          />
        </label>
        <label className="block text-xs text-[color:var(--muted)]">
          Slug
          <input
            type="text"
            value={slug}
            onChange={(e) => {
              setSlug(e.target.value);
              setSlugTouched(true);
            }}
            placeholder="grass-valley-rtp-2028"
            className="mt-1 w-full rounded border border-[color:var(--border)] bg-[color:var(--background)] px-2 py-1.5 font-mono text-xs text-[color:var(--foreground)] outline-none focus:border-[color:var(--accent)]"
            required
            pattern="[a-z0-9][a-z0-9-]*[a-z0-9]"
          />
        </label>
        <button
          type="submit"
          disabled={busy || !name.trim() || !slug.trim()}
          className="mt-2 w-full rounded bg-[color:var(--accent)] px-3 py-1.5 text-xs font-medium text-white transition hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Creating…" : "Create project"}
        </button>
        {error && <p className="text-xs text-red-500">{error}</p>}
      </div>
    </form>
  );
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}
