"use client";

import { Eye, EyeOff, Layers, Palette, Sparkles, Target, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { LayerStylePatch } from "./map-canvas";

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
      style?: LayerStylePatch | null;
    }
  | {
      id: string;
      name: string;
      color: string;
      visible: boolean;
      source: "remote" | "pmtiles";
      kind: "vector-tile";
      tilesUrlTemplate?: string;
      sourceUrl?: string;
      sourceLayer: string;
      geometryKind: string;
      featureCount: number;
      bbox?: [number, number, number, number] | null;
      minzoom?: number;
      maxzoom?: number;
      style?: LayerStylePatch | null;
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
      style?: LayerStylePatch | null;
    };

export function LayerPanel({
  layers,
  hydrating,
  onToggle,
  onRemove,
  onFocus,
  onExtract,
  onEditStyle,
}: {
  layers: ClientLayer[];
  hydrating?: boolean;
  onToggle: (id: string, visible: boolean) => void;
  onRemove: (id: string) => void;
  onFocus: (id: string) => void;
  onExtract?: (layer: ClientLayer) => void;
  onEditStyle?: (layer: ClientLayer) => void;
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
        hydrating ? (
          <p className="text-xs text-[color:var(--muted)]">Loading your saved layers…</p>
        ) : (
          <div className="space-y-1 text-xs text-[color:var(--muted)]">
            <p>No layers yet. Start one of these ways:</p>
            <ul className="list-disc space-y-0.5 pl-5 text-[11px]">
              <li>Drop drone images on the Orthomosaic panel</li>
              <li>Drop a GeoJSON / shapefile on the Upload panel</li>
              <li>Ask the AI panel for a spatial query</li>
            </ul>
          </div>
        )
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
              {onExtract && layer.kind === "raster" && (
                <button
                  type="button"
                  onClick={() => onExtract(layer)}
                  title="Detect features with AI"
                  className="flex items-center gap-1 rounded-full border border-[color:var(--accent)]/40 bg-[color:var(--accent)]/10 px-2 py-0.5 text-[10px] font-medium text-[color:var(--accent)] hover:bg-[color:var(--accent)]/20"
                >
                  <Sparkles size={12} />
                  Detect
                </button>
              )}
              {onEditStyle && (
                <IconBtn title="Edit style" onClick={() => onEditStyle(layer)}>
                  <Palette size={14} />
                </IconBtn>
              )}
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
