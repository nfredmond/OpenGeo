"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { MapCanvas, type MapCanvasHandle, type LayerStylePatch } from "./map-canvas";
import { LayerPanel, type ClientLayer } from "./layer-panel";
import { AiQueryPanel } from "./ai-query-panel";
import { UploadPanel } from "./upload-panel";
import { OrthoPanel } from "./ortho-panel";
import { BasemapPicker } from "./basemap-picker";
import { StyleEditor } from "./style-editor";
import { defaultBasemapId, type BasemapId } from "./basemaps";
import { pickColor } from "./colors";
import { publicEnv } from "@/lib/public-env";

type RemoteLayerSummary = {
  id: string;
  name: string;
  geometry_kind: string;
  feature_count: number;
  style?: LayerStylePatch | null;
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

type ProjectContext = { id: string; slug: string; name: string };

export function MapWorkspace({
  userEmail,
  project,
}: {
  userEmail: string | null;
  project?: ProjectContext;
}) {
  const [layers, setLayers] = useState<ClientLayer[]>([]);
  const [hydrating, setHydrating] = useState(true);
  const [basemap, setBasemap] = useState<BasemapId>(defaultBasemapId());
  const [editingLayer, setEditingLayer] = useState<ClientLayer | null>(null);
  const mapRef = useRef<MapCanvasHandle>(null);

  const changeBasemap = useCallback((id: BasemapId) => {
    setBasemap(id);
    mapRef.current?.setBasemap(id);
  }, []);

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
    } else if (layer.kind === "vector-tile") {
      mapRef.current?.addVectorTileLayer({
        id: layer.id,
        name: layer.name,
        tilesUrlTemplate: layer.tilesUrlTemplate,
        sourceLayer: layer.sourceLayer,
        geometryKind: layer.geometryKind,
        color: layer.color,
      });
    } else {
      mapRef.current?.addGeoJsonLayer(layer);
    }
    if (layer.style) {
      mapRef.current?.setLayerStyle(layer.id, layer.style);
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

  const extractFromOrtho = useCallback(
    async (layer: ClientLayer) => {
      if (layer.kind !== "raster") return;
      const orthoId = layer.id.startsWith("ortho-") ? layer.id.slice(6) : layer.id;
      const prompt = window.prompt(
        "What features should AI detect in this orthomosaic?",
        "all buildings",
      );
      if (!prompt || !prompt.trim()) return;
      const res = await fetch(`/api/orthomosaics/${orthoId}/extract`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: prompt.trim() }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok: boolean;
        layerId?: string;
        featureCollection?: GeoJSON.FeatureCollection;
        featureCount?: number;
        error?: string;
      };
      if (!res.ok || !body.ok || !body.layerId || !body.featureCollection) {
        window.alert(body.error ?? `Extract failed (${res.status}).`);
        return;
      }
      addLayer({
        id: body.layerId,
        name: `AI: ${prompt.trim()}`,
        color: pickColor(),
        visible: true,
        source: "ai-query",
        kind: "vector",
        data: body.featureCollection,
        featureCount: body.featureCount ?? body.featureCollection.features.length,
      });
    },
    [addLayer],
  );

  const projectSlug = project?.slug;
  // Rehydrate vector layers + raster orthomosaics on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await hydrateVectorLayers(cancelled, addLayer, projectSlug);
        await hydrateOrthomosaics(cancelled, addLayer, projectSlug);
      } finally {
        if (!cancelled) setHydrating(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [addLayer, projectSlug]);

  return (
    <>
      <aside className="flex w-80 flex-col border-r border-[color:var(--border)] bg-[color:var(--card)]">
        <header className="flex items-start justify-between border-b border-[color:var(--border)] px-5 py-4">
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold tracking-tight">
              {project ? project.name : "OpenGeo"}
            </h1>
            <p className="text-xs text-[color:var(--muted)]">
              {project ? `project · ${project.slug}` : "drone-to-insight workspace"}
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

        <UploadPanel onLayerAdded={addLayer} projectId={project?.id} />
        <OrthoPanel onLayerAdded={addLayer} projectId={project?.id} />

        <LayerPanel
          layers={layers}
          hydrating={hydrating}
          onToggle={toggleLayer}
          onRemove={removeLayer}
          onFocus={(id) => mapRef.current?.fitLayer(id)}
          onExtract={extractFromOrtho}
          onEditStyle={setEditingLayer}
        />

        <AiQueryPanel onLayerAdded={addLayer} />
      </aside>

      <main className="relative flex-1">
        <MapCanvas ref={mapRef} />
        <BasemapPicker current={basemap} onChange={changeBasemap} />
      </main>

      {editingLayer && (
        <StyleEditor
          layer={editingLayer}
          onApply={(patch) => mapRef.current?.setLayerStyle(editingLayer.id, patch)}
          onSave={async (patch) => {
            const res = await fetch(`/api/layers/${editingLayer.id}`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ style: patch }),
            });
            if (!res.ok) {
              const body = (await res.json().catch(() => ({}))) as { error?: string };
              throw new Error(body.error ?? `HTTP ${res.status}`);
            }
            mapRef.current?.setLayerStyle(editingLayer.id, patch);
          }}
          onClose={() => setEditingLayer(null)}
        />
      )}
    </>
  );
}

// Layers with more features than this get rendered via Martin vector tiles
// rather than inlined GeoJSON. Small layers stay as GeoJSON so editing and
// AI-query results remain instantly visible without a tile roundtrip.
const TILE_THRESHOLD = 2000;

async function hydrateVectorLayers(
  cancelled: boolean,
  addLayer: (l: ClientLayer) => void,
  projectSlug?: string,
) {
  const url = projectSlug
    ? `/api/layers?projectSlug=${encodeURIComponent(projectSlug)}`
    : "/api/layers";
  const list = await fetch(url, { cache: "no-store" });
  if (!list.ok) return;
  const body = (await list.json()) as { ok: boolean; layers: RemoteLayerSummary[] };
  if (!body.ok || cancelled) return;

  for (const remote of body.layers) {
    if (remote.feature_count > TILE_THRESHOLD) {
      addLayer({
        id: remote.id,
        name: remote.name,
        color: pickColor(),
        visible: true,
        source: "remote",
        kind: "vector-tile",
        tilesUrlTemplate: martinTilesUrl(remote.id),
        sourceLayer: "layer",
        geometryKind: remote.geometry_kind,
        featureCount: remote.feature_count,
        style: remote.style ?? null,
      });
      continue;
    }

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
      style: remote.style ?? null,
    });
  }
}

async function hydrateOrthomosaics(
  cancelled: boolean,
  addLayer: (l: ClientLayer) => void,
  projectSlug?: string,
) {
  const url = projectSlug
    ? `/api/flights?projectSlug=${encodeURIComponent(projectSlug)}`
    : "/api/flights";
  const res = await fetch(url, { cache: "no-store" });
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

function martinTilesUrl(layerId: string): string {
  const base = publicEnv.NEXT_PUBLIC_MARTIN_URL.replace(/\/$/, "");
  return `${base}/opengeo_layer_mvt/{z}/{x}/{y}?layer_id=${encodeURIComponent(layerId)}`;
}
