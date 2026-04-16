"use client";

import { useCallback, useRef, useState } from "react";
import { MapCanvas, type MapCanvasHandle } from "./map-canvas";
import { LayerPanel, type ClientLayer } from "./layer-panel";
import { AiQueryPanel } from "./ai-query-panel";
import { UploadPanel } from "./upload-panel";

export function MapWorkspace() {
  const [layers, setLayers] = useState<ClientLayer[]>([]);
  const mapRef = useRef<MapCanvasHandle>(null);

  const addLayer = useCallback((layer: ClientLayer) => {
    setLayers((prev) => [...prev, layer]);
    mapRef.current?.addGeoJsonLayer(layer);
  }, []);

  const toggleLayer = useCallback((id: string, visible: boolean) => {
    setLayers((prev) =>
      prev.map((l) => (l.id === id ? { ...l, visible } : l)),
    );
    mapRef.current?.toggleLayer(id, visible);
  }, []);

  const removeLayer = useCallback((id: string) => {
    setLayers((prev) => prev.filter((l) => l.id !== id));
    mapRef.current?.removeLayer(id);
  }, []);

  return (
    <>
      <aside className="flex w-80 flex-col border-r border-[color:var(--border)] bg-[color:var(--card)]">
        <header className="border-b border-[color:var(--border)] px-5 py-4">
          <h1 className="text-sm font-semibold tracking-tight">OpenGeo</h1>
          <p className="text-xs text-[color:var(--muted)]">
            drone-to-insight workspace
          </p>
        </header>

        <UploadPanel onLayerAdded={addLayer} />

        <LayerPanel
          layers={layers}
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
