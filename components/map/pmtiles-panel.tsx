"use client";

import { Database } from "lucide-react";
import { useEffect, useState } from "react";
import type { ClientLayer } from "./layer-panel";
import { pickColor } from "./colors";
import { pmtilesSourceUrl } from "@/lib/pmtiles";

const geometryKinds = [
  "point",
  "multipoint",
  "linestring",
  "multilinestring",
  "polygon",
  "multipolygon",
  "geometrycollection",
] as const;

type PublishReadiness = {
  ok: boolean;
  missing: string[];
  warnings?: string[];
  generation?: {
    mode: "remote" | "local";
    localBinary: string | null;
  };
};

export function PmtilesPanel({
  onLayerAdded,
  projectId,
  layers,
}: {
  onLayerAdded: (layer: ClientLayer) => void;
  projectId?: string;
  layers: ClientLayer[];
}) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [sourceLayer, setSourceLayer] = useState("default");
  const [geometryKind, setGeometryKind] = useState<(typeof geometryKinds)[number]>("polygon");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedLayerId, setSelectedLayerId] = useState("");
  const [publishName, setPublishName] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<PublishReadiness | null>(null);
  const [readinessLoading, setReadinessLoading] = useState(false);
  const [readinessError, setReadinessError] = useState<string | null>(null);

  const publishableLayers = layers.filter(
    (layer) => layer.kind !== "raster" && layer.source !== "pmtiles",
  );
  const publishSetupBlocked = readinessLoading || readiness?.ok === false;

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setReadinessLoading(true);
    setReadinessError(null);

    fetch("/api/pmtiles/publish", { signal: controller.signal })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          readiness?: PublishReadiness;
          error?: string;
        };
        if (!res.ok || !body.ok || !body.readiness) {
          throw new Error(body.error ?? `PMTiles readiness check failed (${res.status}).`);
        }
        setReadiness(body.readiness);
      })
      .catch((error: Error) => {
        if (error.name === "AbortError") return;
        setReadinessError(error.message);
        setReadiness(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setReadinessLoading(false);
      });

    return () => controller.abort();
  }, [open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const layerName = name.trim() || basenameFromUrl(url);
      const res = await fetch("/api/pmtiles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId,
          name: layerName,
          url: url.trim(),
          sourceLayer: sourceLayer.trim() || "default",
          geometryKind,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok: boolean;
        layer?: {
          id: string;
          name: string;
          geometry_kind: string;
          feature_count: number;
          style?: Record<string, unknown> | null;
        };
        pmtiles?: {
          url: string;
          sourceLayer: string;
          bbox: [number, number, number, number] | null;
          minzoom: number;
          maxzoom: number;
        };
        error?: string;
      };
      if (!res.ok || !body.ok || !body.layer || !body.pmtiles) {
        throw new Error(body.error ?? `PMTiles registration failed (${res.status}).`);
      }
      onLayerAdded({
        id: body.layer.id,
        name: body.layer.name,
        color: pickColor(),
        visible: true,
        source: "pmtiles",
        kind: "vector-tile",
        sourceUrl: pmtilesSourceUrl(body.pmtiles.url),
        sourceLayer: body.pmtiles.sourceLayer,
        geometryKind: body.layer.geometry_kind,
        featureCount: body.layer.feature_count,
        bbox: body.pmtiles.bbox,
        minzoom: body.pmtiles.minzoom,
        maxzoom: body.pmtiles.maxzoom,
        style: body.layer.style as ClientLayer["style"],
      });
      setUrl("");
      setName("");
      setSourceLayer("default");
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function publishExisting(e: React.FormEvent) {
    e.preventDefault();
    if (publishing) return;
    const targetId = selectedLayerId || publishableLayers[0]?.id;
    if (!targetId) return;
    if (readiness?.ok === false) {
      setPublishError(formatReadinessMessage(readiness));
      return;
    }
    setPublishing(true);
    setPublishError(null);
    try {
      const res = await fetch("/api/pmtiles/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId,
          layerId: targetId,
          name: publishName.trim() || undefined,
          sourceLayer: "layer",
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok: boolean;
        layer?: {
          id: string;
          name: string;
          geometry_kind: string;
          feature_count: number;
          style?: Record<string, unknown> | null;
        };
        pmtiles?: {
          url: string;
          sourceLayer: string;
          bbox: [number, number, number, number] | null;
          minzoom: number;
          maxzoom: number;
        };
        error?: string;
      };
      if (!res.ok || !body.ok || !body.layer || !body.pmtiles) {
        throw new Error(body.error ?? `PMTiles publish failed (${res.status}).`);
      }
      onLayerAdded({
        id: body.layer.id,
        name: body.layer.name,
        color: pickColor(),
        visible: true,
        source: "pmtiles",
        kind: "vector-tile",
        sourceUrl: pmtilesSourceUrl(body.pmtiles.url),
        sourceLayer: body.pmtiles.sourceLayer,
        geometryKind: body.layer.geometry_kind,
        featureCount: body.layer.feature_count,
        bbox: body.pmtiles.bbox,
        minzoom: body.pmtiles.minzoom,
        maxzoom: body.pmtiles.maxzoom,
        style: body.layer.style as ClientLayer["style"],
      });
      setPublishName("");
      setSelectedLayerId("");
    } catch (e) {
      setPublishError((e as Error).message);
    } finally {
      setPublishing(false);
    }
  }

  return (
    <section className="border-b border-[color:var(--border)] px-5 py-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between rounded-md border border-[color:var(--border)] px-3 py-2 text-xs font-medium text-[color:var(--muted)] hover:border-[color:var(--accent)] hover:text-[color:var(--foreground)]"
      >
        <span className="flex items-center gap-2">
          <Database size={14} />
          Add PMTiles layer
        </span>
        <span>{open ? "Close" : "Open"}</span>
      </button>

      {open && (
        <div className="mt-3 grid gap-3 text-xs">
          <form onSubmit={publishExisting} className="grid gap-2">
            {readinessLoading && (
              <p className="text-xs text-[color:var(--muted)]">
                Checking PMTiles publishing setup...
              </p>
            )}
            {readinessError && (
              <p className="text-xs text-amber-600">{readinessError}</p>
            )}
            {readiness && (
              <p
                className={
                  readiness.ok
                    ? "text-xs text-[color:var(--muted)]"
                    : "text-xs text-red-500"
                }
              >
                {formatReadinessMessage(readiness)}
              </p>
            )}
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <select
                value={selectedLayerId || publishableLayers[0]?.id || ""}
                onChange={(e) => setSelectedLayerId(e.target.value)}
                disabled={publishableLayers.length === 0}
                className="min-w-0 rounded border border-[color:var(--border)] bg-[color:var(--background)] px-2 py-1.5 outline-none focus:border-[color:var(--accent)] disabled:opacity-50"
              >
                {publishableLayers.length === 0 ? (
                  <option value="">No vector layers</option>
                ) : (
                  publishableLayers.map((layer) => (
                    <option key={layer.id} value={layer.id}>
                      {layer.name}
                    </option>
                  ))
                )}
              </select>
              <button
                type="submit"
                disabled={publishing || publishableLayers.length === 0 || publishSetupBlocked}
                className="rounded bg-[color:var(--accent)] px-3 py-1.5 text-xs font-medium text-white transition hover:opacity-90 disabled:opacity-50"
              >
                {publishing ? "Publishing..." : "Publish"}
              </button>
            </div>
            <input
              value={publishName}
              onChange={(e) => setPublishName(e.target.value)}
              placeholder="Published layer name"
              className="rounded border border-[color:var(--border)] bg-[color:var(--background)] px-2 py-1.5 outline-none focus:border-[color:var(--accent)]"
            />
            {publishError && <p className="text-xs text-red-500">{publishError}</p>}
          </form>

          <form onSubmit={submit} className="grid gap-2 border-t border-[color:var(--border)] pt-3">
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://cdn.example.com/parcels.pmtiles"
              className="rounded border border-[color:var(--border)] bg-[color:var(--background)] px-2 py-1.5 outline-none focus:border-[color:var(--accent)]"
              required
            />
            <div className="grid grid-cols-2 gap-2">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Layer name"
                className="rounded border border-[color:var(--border)] bg-[color:var(--background)] px-2 py-1.5 outline-none focus:border-[color:var(--accent)]"
              />
              <input
                value={sourceLayer}
                onChange={(e) => setSourceLayer(e.target.value)}
                placeholder="source layer"
                className="rounded border border-[color:var(--border)] bg-[color:var(--background)] px-2 py-1.5 outline-none focus:border-[color:var(--accent)]"
              />
            </div>
            <div className="flex items-center gap-2">
              <select
                value={geometryKind}
                onChange={(e) => setGeometryKind(e.target.value as (typeof geometryKinds)[number])}
                className="min-w-0 flex-1 rounded border border-[color:var(--border)] bg-[color:var(--background)] px-2 py-1.5 outline-none focus:border-[color:var(--accent)]"
              >
                {geometryKinds.map((kind) => (
                  <option key={kind} value={kind}>
                    {kind}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                disabled={busy || !url.trim()}
                className="rounded bg-[color:var(--accent)] px-3 py-1.5 text-xs font-medium text-white transition hover:opacity-90 disabled:opacity-50"
              >
                {busy ? "Adding..." : "Add"}
              </button>
            </div>
            {error && <p className="text-xs text-red-500">{error}</p>}
          </form>
        </div>
      )}
    </section>
  );
}

function basenameFromUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return (url.pathname.split("/").pop() ?? "PMTiles layer").replace(/\.pmtiles$/i, "");
  } catch {
    return "PMTiles layer";
  }
}

function formatReadinessMessage(readiness: PublishReadiness): string {
  if (!readiness.ok) {
    return `Publishing unavailable: ${readiness.missing.join(", ")}.`;
  }
  if (readiness.warnings?.length) return readiness.warnings[0];
  if (readiness.generation?.mode === "remote") return "Publishing is ready.";
  return `Publishing will use local Tippecanoe: ${readiness.generation?.localBinary ?? "tippecanoe"}.`;
}
