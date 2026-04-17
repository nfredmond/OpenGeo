"use client";

import { useEffect, useMemo, useState } from "react";
import { Sparkles, X } from "lucide-react";
import type { LayerStylePatch } from "./map-canvas";
import type { ClientLayer } from "./layer-panel";

// Minimal defaults per geometry kind. These are the same paint values the
// MapCanvas applies when a layer is first added, so opening the editor on a
// freshly-added layer shows the current state even if the DB has no style row.
function defaultStyleFor(layer: ClientLayer): LayerStylePatch {
  if (layer.kind === "raster") {
    return { paint: { "raster-opacity": 0.95 } };
  }
  const kind =
    layer.kind === "vector-tile"
      ? layer.geometryKind.toLowerCase()
      : detectGeometryKind(layer);
  if (kind.includes("polygon")) {
    return {
      paint: {
        "fill-color": layer.color,
        "fill-opacity": 0.35,
        "line-color": layer.color,
        "line-width": 1.5,
      },
    };
  }
  if (kind.includes("line")) {
    return { paint: { "line-color": layer.color, "line-width": 2 } };
  }
  return {
    paint: {
      "circle-color": layer.color,
      "circle-radius": 5,
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 1,
    },
  };
}

function detectGeometryKind(layer: ClientLayer): string {
  if (layer.kind === "vector-tile") return layer.geometryKind;
  if (layer.kind === "raster") return "raster";
  const first = layer.data.features[0]?.geometry?.type ?? "Point";
  return first;
}

export function StyleEditor({
  layer,
  onApply,
  onSave,
  onClose,
}: {
  layer: ClientLayer;
  onApply: (patch: LayerStylePatch) => void;
  onSave: (patch: LayerStylePatch) => Promise<void>;
  onClose: () => void;
}) {
  const initial = useMemo(() => defaultStyleFor(layer), [layer]);
  const [text, setText] = useState(() => JSON.stringify(initial, null, 2));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [lastApplied, setLastApplied] = useState<LayerStylePatch | null>(initial);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiRationale, setAiRationale] = useState<string | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);

  useEffect(() => {
    setText(JSON.stringify(initial, null, 2));
    setLastApplied(initial);
    setError(null);
    setAiRationale(null);
    setAiError(null);
  }, [initial]);

  async function runAi() {
    if (!aiPrompt.trim() || aiBusy) return;
    setAiBusy(true);
    setAiError(null);
    setAiRationale(null);
    try {
      const res = await fetch(`/api/layers/${layer.id}/ai-style`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: aiPrompt }),
      });
      const body = (await res.json()) as
        | { ok: true; label: string; patch: LayerStylePatch; rationale: string }
        | { ok: false; error: string };
      if (!res.ok || !body.ok) {
        setAiError(body.ok === false ? body.error : "AI styling failed.");
        return;
      }

      // Merge AI patch on top of whatever's in the textarea so the user
      // doesn't lose properties they already tweaked by hand.
      let current: LayerStylePatch = {};
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object") current = parsed;
      } catch {
        // Current text is malformed — fall through with empty base.
      }
      const mergedPaint = { ...(current.paint ?? {}), ...(body.patch.paint ?? {}) };
      const mergedLayout = { ...(current.layout ?? {}), ...(body.patch.layout ?? {}) };
      const merged: LayerStylePatch = {};
      if (Object.keys(mergedPaint).length > 0) merged.paint = mergedPaint;
      if (Object.keys(mergedLayout).length > 0) merged.layout = mergedLayout;

      setText(JSON.stringify(merged, null, 2));
      setLastApplied(merged);
      setAiRationale(body.rationale);
      setError(null);
      onApply(merged);
    } catch (e) {
      setAiError((e as Error).message);
    } finally {
      setAiBusy(false);
    }
  }

  const parsePatch = (): LayerStylePatch | null => {
    try {
      const parsed = JSON.parse(text) as LayerStylePatch;
      if (typeof parsed !== "object" || parsed === null) {
        throw new Error("Root must be an object with paint and/or layout.");
      }
      setError(null);
      return parsed;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <div className="relative flex max-h-[80vh] w-full max-w-xl flex-col rounded-lg border border-[color:var(--border)] bg-[color:var(--card)] shadow-xl">
        <header className="flex items-center justify-between border-b border-[color:var(--border)] px-5 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">Style · {layer.name}</h2>
            <p className="text-[11px] text-[color:var(--muted)]">
              MapLibre paint/layout properties. Apply previews live; Save
              persists to the database.
            </p>
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

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div className="mb-4 rounded border border-[color:var(--border)] bg-[color:var(--background)]/60 p-3">
            <div className="mb-2 flex items-center gap-2">
              <Sparkles size={13} className="text-[color:var(--accent)]" />
              <span className="text-[11px] font-semibold uppercase tracking-wider text-[color:var(--muted)]">
                Style with words
              </span>
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={aiPrompt}
                onChange={(e) => setAiPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void runAi();
                  }
                }}
                placeholder="e.g. dark red fill with thin white stroke, 40% opacity"
                disabled={aiBusy}
                className="flex-1 rounded border border-[color:var(--border)] bg-[color:var(--card)] px-2 py-1.5 text-xs text-[color:var(--foreground)] outline-none focus:border-[color:var(--accent)] disabled:opacity-60"
              />
              <button
                type="button"
                onClick={() => void runAi()}
                disabled={aiBusy || !aiPrompt.trim()}
                className="rounded bg-[color:var(--accent)] px-3 py-1.5 text-xs font-medium text-[color:var(--accent-foreground)] transition hover:opacity-90 disabled:opacity-50"
              >
                {aiBusy ? "Thinking…" : "Apply AI style"}
              </button>
            </div>
            {aiRationale && (
              <div className="mt-2 rounded border border-[color:var(--border)] bg-[color:var(--card)] px-2 py-1.5">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--muted)]">
                  Model rationale
                </p>
                <p className="mt-0.5 text-[11px] leading-snug text-[color:var(--foreground)]">
                  {aiRationale}
                </p>
              </div>
            )}
            {aiError && (
              <p className="mt-2 text-[11px] text-red-500">{aiError}</p>
            )}
          </div>

          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            className="h-72 w-full resize-none rounded border border-[color:var(--border)] bg-[color:var(--background)] p-3 font-mono text-xs text-[color:var(--foreground)] outline-none focus:border-[color:var(--accent)]"
          />

          {error && (
            <p className="mt-2 rounded border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-600">
              {error}
            </p>
          )}

          <div className="mt-3 text-[11px] text-[color:var(--muted)]">
            <p className="font-semibold">Examples</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              <li>
                <code className="font-mono">fill-color</code>, <code className="font-mono">fill-opacity</code> on polygons
              </li>
              <li>
                <code className="font-mono">line-color</code>, <code className="font-mono">line-width</code>, <code className="font-mono">line-dasharray</code>
              </li>
              <li>
                <code className="font-mono">circle-radius</code>, <code className="font-mono">circle-color</code> on points
              </li>
              <li>
                <code className="font-mono">raster-opacity</code> on orthomosaics
              </li>
            </ul>
          </div>
        </div>

        <footer className="flex items-center justify-between gap-2 border-t border-[color:var(--border)] px-5 py-3">
          <button
            type="button"
            onClick={() => {
              setText(JSON.stringify(initial, null, 2));
              onApply(initial);
              setLastApplied(initial);
              setError(null);
            }}
            className="rounded border border-[color:var(--border)] px-3 py-1 text-xs text-[color:var(--muted)] hover:bg-[color:var(--border)] hover:text-[color:var(--foreground)]"
          >
            Revert
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                const patch = parsePatch();
                if (!patch) return;
                onApply(patch);
                setLastApplied(patch);
              }}
              className="rounded border border-[color:var(--accent)] bg-[color:var(--accent)]/10 px-3 py-1 text-xs font-semibold text-[color:var(--accent)] hover:bg-[color:var(--accent)]/20"
            >
              Apply
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={async () => {
                const patch = parsePatch() ?? lastApplied;
                if (!patch) return;
                setSaving(true);
                try {
                  await onSave(patch);
                  onClose();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setSaving(false);
                }
              }}
              className="rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-600 hover:bg-emerald-500/20 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
