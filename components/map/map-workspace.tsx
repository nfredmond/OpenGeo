"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MapCanvas, type MapCanvasHandle } from "./map-canvas";
import { LayerPanel, type ClientLayer } from "./layer-panel";
import { AiQueryPanel } from "./ai-query-panel";
import { UploadPanel } from "./upload-panel";
import { pickColor } from "./colors";

type RemoteLayerSummary = {
  id: string;
  name: string;
  geometry_kind: string;
  feature_count: number;
};

export function MapWorkspace({ userEmail }: { userEmail: string | null }) {
  const [layers, setLayers] = useState<ClientLayer[]>([]);
  const [hydrating, setHydrating] = useState(true);
  const mapRef = useRef<MapCanvasHandle>(null);

  const addLayer = useCallback((layer: ClientLayer) => {
    setLayers((prev) => [...prev, layer]);
    mapRef.current?.addGeoJsonLayer(layer);
  }, []);

  const toggleLayer = useCallback((id: string, visible: boolean) => {
    setLayers((prev) => prev.map((l) => (l.id === id ? { ...l, visible } : l)));
    mapRef.current?.toggleLayer(id, visible);
  }, []);

  const removeLayer = useCallback(async (id: string) => {
    setLayers((prev) => prev.filter((l) => l.id !== id));
    mapRef.current?.removeLayer(id);
    // Best-effort server delete — in-memory ephemerals (upload-placeholders, AI)
    // will return 404, which we ignore.
    await fetch(`/api/layers/${id}`, { method: "DELETE" }).catch(() => undefined);
  }, []);

  // Rehydrate persisted layers on mount. Each layer is fetched lazily (only
  // its FeatureCollection) to keep the initial payload small.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await fetch("/api/layers", { cache: "no-store" });
        if (!list.ok) return;
        const body = (await list.json()) as {
          ok: boolean;
          layers: RemoteLayerSummary[];
        };
        if (!body.ok || cancelled) return;

        for (const remote of body.layers) {
          const detail = await fetch(`/api/layers/${remote.id}`, { cache: "no-store" });
          if (!detail.ok || cancelled) continue;
          const payload = (await detail.json()) as {
            ok: boolean;
            featureCollection?: GeoJSON.FeatureCollection;
          };
          if (!payload.ok || !payload.featureCollection || cancelled) continue;
          const layer: ClientLayer = {
            id: remote.id,
            name: remote.name,
            color: pickColor(),
            visible: true,
            source: "remote",
            data: payload.featureCollection,
            featureCount: remote.feature_count,
          };
          addLayer(layer);
        }
      } finally {
        if (!cancelled) setHydrating(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [addLayer]);

  return (
    <>
      <aside className="flex w-80 flex-col border-r border-[color:var(--border)] bg-[color:var(--card)]">
        <header className="flex items-start justify-between border-b border-[color:var(--border)] px-5 py-4">
          <div>
            <h1 className="text-sm font-semibold tracking-tight">OpenGeo</h1>
            <p className="text-xs text-[color:var(--muted)]">
              drone-to-insight workspace
            </p>
          </div>
          {userEmail && (
            <form action="/api/auth/signout" method="post" className="flex flex-col items-end gap-1">
              <span className="max-w-[9rem] truncate text-[10px] text-[color:var(--muted)]" title={userEmail}>
                {userEmail}
              </span>
              <button
                type="submit"
                className="text-[10px] font-medium text-[color:var(--muted)] underline-offset-2 hover:text-[color:var(--foreground)] hover:underline"
              >
                Sign out
              </button>
            </form>
          )}
        </header>

        <UploadPanel onLayerAdded={addLayer} />

        <LayerPanel
          layers={layers}
          hydrating={hydrating}
          onToggle={toggleLayer}
          onRemove={removeLayer}
          onFocus={(id) => mapRef.current?.fitLayer(id)}
        />

        <AiQueryPanel onLayerAdded={addLayer} />
      </aside>

      <main className="relative flex-1">
        <MapCanvas ref={mapRef} />
      </main>
    </>
  );
}
