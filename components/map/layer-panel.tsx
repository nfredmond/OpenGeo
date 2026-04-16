"use client";

import { Eye, EyeOff, Layers, Target, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";

export type ClientLayer =
  | {
      id: string;
      name: string;
      color: string;
      visible: boolean;
      source: "upload" | "ai-query" | "remote";
      kind?: "vector";
      data: GeoJSON.FeatureCollection;
      featureCount: number;
    }
  | {
      id: string;
      name: string;
      color: string;
      visible: boolean;
      source: "orthomosaic";
      kind: "raster";
      cogUrl: string;
      featureCount: number;
    };

export function LayerPanel({
  layers,
  hydrating,
  onToggle,
  onRemove,
  onFocus,
}: {
  layers: ClientLayer[];
  hydrating?: boolean;
  onToggle: (id: string, visible: boolean) => void;
  onRemove: (id: string) => void;
  onFocus: (id: string) => void;
}) {
  return (
    <section className="flex-1 overflow-y-auto border-y border-[color:var(--border)] px-5 py-4">
      <header className="mb-3 flex items-center gap-2">
        <Layers size={14} className="text-[color:var(--muted)]" />
        <h2 className="text-xs font-semibold uppercase tracking-wider text-[color:var(--muted)]">
          Layers
        </h2>
      </header>

      {layers.length === 0 ? (
        <p className="text-xs text-[color:var(--muted)]">
          {hydrating ? "Loading your saved layers…" : "No layers yet. Drop a GeoJSON file or run an AI query."}
        </p>
      ) : (
        <ul className="space-y-2">
          {layers.map((layer) => (
            <li
              key={layer.id}
              className="group flex items-center gap-2 rounded border border-[color:var(--border)] bg-[color:var(--background)] px-2 py-1.5"
            >
              <span
                className="h-3 w-3 rounded"
                style={{ backgroundColor: layer.color }}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{layer.name}</div>
                <div className="text-xs text-[color:var(--muted)]">
                  {layer.featureCount} features · {layer.source}
                </div>
              </div>
              <IconBtn
                title={layer.visible ? "Hide" : "Show"}
                onClick={() => onToggle(layer.id, !layer.visible)}
              >
                {layer.visible ? <Eye size={14} /> : <EyeOff size={14} />}
              </IconBtn>
              <IconBtn title="Fit" onClick={() => onFocus(layer.id)}>
                <Target size={14} />
              </IconBtn>
              <IconBtn title="Remove" onClick={() => onRemove(layer.id)}>
                <Trash2 size={14} />
              </IconBtn>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function IconBtn({
  children,
  title,
  onClick,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        "rounded p-1 text-[color:var(--muted)] opacity-0 transition",
        "group-hover:opacity-100 hover:bg-[color:var(--border)] hover:text-[color:var(--foreground)]",
      )}
    >
      {children}
    </button>
  );
}
