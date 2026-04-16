"use client";

import { Map as MapIcon } from "lucide-react";
import { useState } from "react";
import { listBasemaps, type BasemapId } from "./basemaps";

export function BasemapPicker({
  current,
  onChange,
}: {
  current: BasemapId;
  onChange: (id: BasemapId) => void;
}) {
  const [open, setOpen] = useState(false);
  const basemaps = listBasemaps();
  const active = basemaps.find((b) => b.id === current) ?? basemaps[0];

  return (
    <div className="absolute right-3 top-16 z-10">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded border border-[color:var(--border)] bg-[color:var(--card)] px-3 py-1.5 text-xs font-medium text-[color:var(--foreground)] shadow-sm hover:bg-[color:var(--border)]"
        title={`Basemap · ${active.provenance}`}
      >
        <MapIcon size={14} />
        <span className="hidden sm:inline">{active.label}</span>
      </button>

      {open && (
        <div className="mt-2 w-64 rounded border border-[color:var(--border)] bg-[color:var(--card)] p-2 shadow-lg">
          <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--muted)]">
            Basemap
          </p>
          <ul className="space-y-1">
            {basemaps.map((b) => (
              <li key={b.id}>
                <button
                  type="button"
                  disabled={!b.enabled}
                  onClick={() => {
                    onChange(b.id);
                    setOpen(false);
                  }}
                  className={
                    b.id === current
                      ? "w-full rounded bg-[color:var(--accent)]/10 px-2 py-1.5 text-left text-xs"
                      : "w-full rounded px-2 py-1.5 text-left text-xs hover:bg-[color:var(--border)] disabled:opacity-50 disabled:hover:bg-transparent"
                  }
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className={b.id === current ? "font-semibold text-[color:var(--accent)]" : ""}>
                      {b.label}
                    </span>
                    {b.id === current && (
                      <span className="rounded bg-[color:var(--accent)]/20 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-[color:var(--accent)]">
                        on
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block truncate text-[10px] text-[color:var(--muted)]" title={b.provenance}>
                    {b.provenance}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-2 border-t border-[color:var(--border)] px-2 pt-2 text-[10px] text-[color:var(--muted)]">
            Basemap swap re-applies your layers on the new style.
          </p>
        </div>
      )}
    </div>
  );
}
