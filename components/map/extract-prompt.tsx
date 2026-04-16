"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles, X } from "lucide-react";
import type { ClientLayer } from "./layer-panel";

export function ExtractPrompt({
  layer,
  onClose,
  onSubmit,
}: {
  layer: ClientLayer;
  onClose: () => void;
  onSubmit: (prompt: string) => Promise<void>;
}) {
  const [value, setValue] = useState("all buildings");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
    textareaRef.current?.select();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit() {
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(trimmed);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <div className="relative flex w-full max-w-md flex-col rounded-lg border border-[color:var(--border)] bg-[color:var(--card)] shadow-xl">
        <header className="flex items-center justify-between border-b border-[color:var(--border)] px-5 py-3">
          <div className="flex items-center gap-2 min-w-0">
            <Sparkles size={14} className="text-[color:var(--accent)]" />
            <h2 className="truncate text-sm font-semibold">Detect features · {layer.name}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-[color:var(--muted)] hover:bg-[color:var(--border)] hover:text-[color:var(--foreground)]"
            title="Close"
          >
            <X size={16} />
          </button>
        </header>

        <div className="px-5 py-4">
          <label className="mb-1 block text-[11px] font-medium text-[color:var(--muted)]">
            What should the AI look for?
          </label>
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void submit();
              }
            }}
            rows={3}
            className="w-full resize-none rounded border border-[color:var(--border)] bg-[color:var(--background)] p-3 text-xs text-[color:var(--foreground)] outline-none focus:border-[color:var(--accent)]"
            placeholder="e.g. all buildings, parcel boundaries, mature trees"
          />
          <p className="mt-2 text-[10px] text-[color:var(--muted)]">
            Results land as a new vector layer and queue for planner review. Cmd/Ctrl+Enter to submit.
          </p>
          {error && (
            <p className="mt-2 rounded border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-600">
              {error}
            </p>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-[color:var(--border)] px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded border border-[color:var(--border)] px-3 py-1 text-xs text-[color:var(--muted)] hover:bg-[color:var(--border)] hover:text-[color:var(--foreground)] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || !value.trim()}
            className="rounded border border-[color:var(--accent)] bg-[color:var(--accent)] px-3 py-1 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Extracting…" : "Extract"}
          </button>
        </footer>
      </div>
    </div>
  );
}
