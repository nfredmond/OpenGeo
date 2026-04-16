"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { MapCanvas, type MapCanvasHandle } from "./map-canvas";
import { LayerPanel, type ClientLayer } from "./layer-panel";
import { AiQueryPanel } from "./ai-query-panel";
import { UploadPanel } from "./upload-panel";
import { OrthoPanel } from "./ortho-panel";
import { pickColor } from "./colors";
import { publicEnv } from "@/lib/public-env";

type RemoteLayerSummary = {
  id: string;
  name: string;
  geometry_kind: string;
  feature_count: number;
};

type RemoteOrthomosaic = {
  id: string;
  status: "queued" | "processing" | "ready" | "failed";
  cog_url: string | null;
};

type RemoteFlight = {
  id: string;
  metadata: Record<string, unknown> | null;
  orthomosaics: RemoteOrthomosaic[] | null;
};

export function MapWorkspace({ userEmail }: { userEmail: string | null }) {
  const [layers, setLayers] = useState<ClientLayer[]>([]);
  const [hydrating, setHydrating] = useState(true);
  const mapRef = useRef<MapCanvasHandle>(null);

  const addLayer = useCallback((layer: ClientLayer) => {
    setLayers((prev) => [...prev, layer]);
    if (layer.kind === "raster") {
      mapRef.current?.addRasterLayer({
        id: layer.id,
        name: layer.name,
        tilesUrlTemplate: titilerTilesUrl(layer.cogUrl),
        bbox: null,
        minzoom: 0,
        maxzoom: 22,
      });
    } else {
      mapRef.current?.addGeoJsonLayer(layer);
    }
  }, []);

  const toggleLayer = useCallback((id: string, visible: boolean) => {
    setLayers((prev) => prev.map((l) => (l.id === id ? { ...l, visible } : l)));
    mapRef.current?.toggleLayer(id, visible);
  }, []);

  const removeLayer = useCallback(async (id: string) => {
    setLayers((prev) => prev.filter((l) => l.id !== id));
    mapRef.current?.removeLayer(id);
    await fetch(`/api/layers/${id}`, { method: "DELETE" }).catch(() => undefined);
  }, []);

  // Rehydrate vector layers + raster orthomosaics on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await hydrateVectorLayers(cancelled, addLayer);
        await hydrateOrthomosaics(cancelled, addLayer);
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
            <Link
              href="/projects"
              className="mt-1 inline-block text-[10px] text-[color:var(--muted)] underline-offset-2 hover:text-[color:var(--foreground)] hover:underline"
            >
              ← Projects
            </Link>
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
        <OrthoPanel onLayerAdded={addLayer} />

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

async function hydrateVectorLayers(
  cancelled: boolean,
  addLayer: (l: ClientLayer) => void,
) {
  const list = await fetch("/api/layers", { cache: "no-store" });
  if (!list.ok) return;
  const body = (await list.json()) as { ok: boolean; layers: RemoteLayerSummary[] };
  if (!body.ok || cancelled) return;

  for (const remote of body.layers) {
    const detail = await fetch(`/api/layers/${remote.id}`, { cache: "no-store" });
    if (!detail.ok || cancelled) continue;
    const payload = (await detail.json()) as {
      ok: boolean;
      featureCollection?: GeoJSON.FeatureCollection;
    };
    if (!payload.ok || !payload.featureCollection || cancelled) continue;
    addLayer({
      id: remote.id,
      name: remote.name,
      color: pickColor(),
      visible: true,
      source: "remote",
      kind: "vector",
      data: payload.featureCollection,
      featureCount: remote.feature_count,
    });
  }
}

async function hydrateOrthomosaics(
  cancelled: boolean,
  addLayer: (l: ClientLayer) => void,
) {
  const res = await fetch("/api/flights", { cache: "no-store" });
  if (!res.ok) return;
  const body = (await res.json()) as { ok: boolean; flights: RemoteFlight[] };
  if (!body.ok || cancelled) return;

  for (const flight of body.flights) {
    const orthos = flight.orthomosaics ?? [];
    const readyOrtho = orthos.find((o) => o.status === "ready" && o.cog_url);
    if (!readyOrtho || !readyOrtho.cog_url) continue;
    const metaName = (flight.metadata?.displayName as string | undefined) ?? "Orthomosaic";
    addLayer({
      id: `ortho-${readyOrtho.id}`,
      name: metaName,
      color: pickColor(),
      visible: true,
      source: "orthomosaic",
      kind: "raster",
      cogUrl: readyOrtho.cog_url,
      featureCount: 0,
    });
  }
}

function titilerTilesUrl(cogUrl: string): string {
  const base = publicEnv.NEXT_PUBLIC_TITILER_URL.replace(/\/$/, "");
  return `${base}/cog/tiles/{z}/{x}/{y}.png?url=${encodeURIComponent(cogUrl)}`;
}
