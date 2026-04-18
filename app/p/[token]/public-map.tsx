"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MapCanvas, type MapCanvasHandle } from "@/components/map/map-canvas";
import { BasemapPicker } from "@/components/map/basemap-picker";
import { defaultBasemapId, type BasemapId } from "@/components/map/basemaps";
import { pickColor } from "@/components/map/colors";
import { publicEnv } from "@/lib/public-env";

type ShareProjectResponse = {
  ok: boolean;
  project?: { id: string; slug: string; name: string };
  org?: { slug: string; name: string } | null;
  expiresAt?: string | null;
  scopes?: string[];
  error?: string;
};

type ShareLayer = {
  id: string;
  name: string;
  geometryKind: string;
  featureCount: number;
  style: Record<string, unknown> | null;
  featureCollection: GeoJSON.FeatureCollection;
};

type ShareOrtho = {
  id: string;
  flightId: string;
  status: string;
  cogUrl: string | null;
  createdAt: string;
};

export function PublicMap({ token }: { token: string }) {
  const [project, setProject] = useState<ShareProjectResponse["project"] | null>(null);
  const [org, setOrg] = useState<ShareProjectResponse["org"]>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [layers, setLayers] = useState<ShareLayer[]>([]);
  const [orthomosaics, setOrthomosaics] = useState<ShareOrtho[]>([]);
  const [visibility, setVisibility] = useState<Record<string, boolean>>({});
  const [basemap, setBasemap] = useState<BasemapId>(defaultBasemapId());
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mapRef = useRef<MapCanvasHandle>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const projRes = await fetch(`/api/share/${encodeURIComponent(token)}/project`, {
          cache: "no-store",
        });
        if (projRes.status === 404) {
          if (!cancelled) setNotFound(true);
          return;
        }
        const projBody = (await projRes.json()) as ShareProjectResponse;
        if (!projRes.ok || !projBody.ok || !projBody.project) {
          throw new Error(projBody.error ?? `Failed (${projRes.status})`);
        }
        if (cancelled) return;
        setProject(projBody.project);
        setOrg(projBody.org ?? null);
        setExpiresAt(projBody.expiresAt ?? null);

        const [layersRes, orthoRes] = await Promise.all([
          fetch(`/api/share/${encodeURIComponent(token)}/layers`, { cache: "no-store" }),
          fetch(`/api/share/${encodeURIComponent(token)}/orthomosaics`, { cache: "no-store" }),
        ]);
        const layersBody = (await layersRes.json()) as {
          ok: boolean;
          layers?: ShareLayer[];
          error?: string;
        };
        const orthoBody = (await orthoRes.json()) as {
          ok: boolean;
          orthomosaics?: ShareOrtho[];
          error?: string;
        };

        if (cancelled) return;
        const nextLayers = layersBody.layers ?? [];
        const nextOrthos = (orthoBody.orthomosaics ?? []).filter((o) => o.cogUrl);
        setLayers(nextLayers);
        setOrthomosaics(nextOrthos);
        const vis: Record<string, boolean> = {};
        for (const l of nextLayers) vis[l.id] = true;
        for (const o of nextOrthos) vis[o.id] = true;
        setVisibility(vis);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // Push layers into MapCanvas once it's mounted + data is ready.
  useEffect(() => {
    if (!mapRef.current) return;
    for (const l of layers) {
      mapRef.current.addGeoJsonLayer({
        id: l.id,
        name: l.name,
        color: pickColor(),
        visible: true,
        source: "remote",
        kind: "vector",
        data: l.featureCollection,
        featureCount: l.featureCount,
        style: (l.style as { paint?: Record<string, unknown>; layout?: Record<string, unknown> }) ?? null,
      });
    }
    for (const o of orthomosaics) {
      if (!o.cogUrl) continue;
      mapRef.current.addRasterLayer({
        id: o.id,
        name: `Orthomosaic ${o.id.slice(0, 8)}`,
        tilesUrlTemplate: titilerTilesUrl(o.cogUrl),
        bbox: null,
        minzoom: 0,
        maxzoom: 22,
      });
    }
    // Fit to the first vector layer if any.
    if (layers.length > 0) mapRef.current.fitLayer(layers[0].id);
  }, [layers, orthomosaics]);

  const toggle = useCallback((id: string) => {
    setVisibility((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      mapRef.current?.toggleLayer(id, next[id]);
      return next;
    });
  }, []);

  const changeBasemap = useCallback((id: BasemapId) => {
    setBasemap(id);
    mapRef.current?.setBasemap(id);
  }, []);

  if (notFound) {
    return (
      <div className="grid h-screen place-items-center p-8 text-center">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">This share link isn&apos;t available.</h1>
          <p className="mt-2 text-sm text-[color:var(--muted)]">
            It may have expired, been revoked, or never existed.
          </p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="grid h-screen place-items-center text-sm text-[color:var(--muted)]">
        Loading shared map…
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="grid h-screen place-items-center p-8 text-sm text-red-500">
        {error ?? "Unavailable."}
      </div>
    );
  }

  const expiryLabel = expiresAt
    ? `Expires ${new Date(expiresAt).toLocaleDateString()}`
    : "No expiry";

  return (
    <div className="flex h-screen w-screen flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-[color:var(--border)] bg-[color:var(--card)] px-4 py-2 text-xs">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="rounded bg-amber-500/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-700">
              Read-only share
            </span>
            <span className="truncate font-semibold">{project.name}</span>
          </div>
          <p className="mt-0.5 truncate text-[10px] text-[color:var(--muted)]">
            {org?.name ? `${org.name} · ` : ""}
            {expiryLabel}
          </p>
        </div>
        <BasemapPicker current={basemap} onChange={changeBasemap} />
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="w-64 shrink-0 border-r border-[color:var(--border)] bg-[color:var(--card)] p-3 text-xs">
          <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--muted)]">
            Layers ({layers.length})
          </h2>
          {layers.length === 0 && orthomosaics.length === 0 ? (
            <p className="text-[color:var(--muted)]">No layers shared.</p>
          ) : (
            <ul className="space-y-1">
              {layers.map((l) => (
                <li key={l.id}>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={visibility[l.id] ?? true}
                      onChange={() => toggle(l.id)}
                    />
                    <span className="truncate">{l.name}</span>
                    <span className="ml-auto text-[10px] text-[color:var(--muted)]">
                      {l.featureCount}
                    </span>
                  </label>
                </li>
              ))}
              {orthomosaics.map((o) => (
                <li key={o.id}>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={visibility[o.id] ?? true}
                      onChange={() => toggle(o.id)}
                    />
                    <span className="truncate">Ortho {o.id.slice(0, 8)}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <div className="min-h-0 flex-1">
          <MapCanvas ref={mapRef} />
        </div>
      </div>
    </div>
  );
}

function titilerTilesUrl(cogUrl: string): string {
  const base = publicEnv.NEXT_PUBLIC_TITILER_URL.replace(/\/$/, "");
  return `${base}/cog/tiles/{z}/{x}/{y}.png?url=${encodeURIComponent(cogUrl)}`;
}
