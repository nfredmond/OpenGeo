"use client";

import maplibregl, { type LngLatBoundsLike } from "maplibre-gl";
import { Protocol } from "pmtiles";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import type { ClientLayer } from "./layer-panel";
import { defaultBasemapId, listBasemaps, type BasemapId } from "./basemaps";

type VectorClientLayer = Extract<ClientLayer, { kind?: "vector" }>;

export type MapCanvasHandle = {
  addGeoJsonLayer: (layer: VectorClientLayer) => void;
  addVectorTileLayer: (layer: VectorTileLayer) => void;
  addRasterLayer: (raster: RasterLayer) => void;
  toggleLayer: (id: string, visible: boolean) => void;
  removeLayer: (id: string) => void;
  fitLayer: (id: string) => void;
  setBasemap: (id: BasemapId) => void;
};

export type RasterLayer = {
  id: string;
  name: string;
  tilesUrlTemplate: string;
  bbox: [number, number, number, number] | null; // [west, south, east, north]
  minzoom?: number;
  maxzoom?: number;
  attribution?: string;
};

export type VectorTileLayer = {
  id: string;
  name: string;
  tilesUrlTemplate: string;
  sourceLayer: string;
  geometryKind: string;
  color: string;
  bbox?: [number, number, number, number] | null;
  minzoom?: number;
  maxzoom?: number;
};

// Registry entries — we stash every "apply" we make so we can replay them
// after a setStyle call (which wipes non-basemap layers). Keyed by the
// caller-provided layer id so re-adding the same layer is a no-op.
type Registered =
  | { kind: "geojson"; layer: VectorClientLayer }
  | { kind: "raster"; layer: RasterLayer }
  | { kind: "vector-tile"; layer: VectorTileLayer };

export const MapCanvas = forwardRef<MapCanvasHandle>(function MapCanvas(_, ref) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const registryRef = useRef<Map<string, Registered>>(new Map());
  const hiddenRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const protocol = new Protocol();
    maplibregl.addProtocol("pmtiles", protocol.tile);

    const initial = listBasemaps().find((b) => b.id === defaultBasemapId())
      ?? listBasemaps()[0];

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: initial.style,
      center: [-121.06, 39.22], // Grass Valley, CA — Nat Ford Planning HQ region.
      zoom: 10,
      attributionControl: { compact: true },
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.addControl(new maplibregl.ScaleControl({ unit: "imperial" }), "bottom-left");

    mapRef.current = map;
    return () => {
      map.remove();
      maplibregl.removeProtocol("pmtiles");
      mapRef.current = null;
    };
  }, []);

  useImperativeHandle(ref, () => ({
    addGeoJsonLayer(layer) {
      const map = mapRef.current;
      if (!map) return;
      registryRef.current.set(layer.id, { kind: "geojson", layer });
      const apply = () => applyGeoJsonLayer(map, layer, hiddenRef.current);
      if (map.isStyleLoaded()) apply();
      else map.once("load", apply);
    },

    addRasterLayer(raster) {
      const map = mapRef.current;
      if (!map) return;
      registryRef.current.set(raster.id, { kind: "raster", layer: raster });
      const apply = () => applyRasterLayer(map, raster, hiddenRef.current);
      if (map.isStyleLoaded()) apply();
      else map.once("load", apply);
    },

    addVectorTileLayer(layer) {
      const map = mapRef.current;
      if (!map) return;
      registryRef.current.set(layer.id, { kind: "vector-tile", layer });
      const apply = () => applyVectorTileLayer(map, layer, hiddenRef.current);
      if (map.isStyleLoaded()) apply();
      else map.once("load", apply);
    },

    toggleLayer(id, visible) {
      const map = mapRef.current;
      if (!map) return;
      if (visible) hiddenRef.current.delete(id);
      else hiddenRef.current.add(id);
      for (const suffix of ["-fill", "-line", "-circle", "-raster"]) {
        const layerId = id + suffix;
        if (map.getLayer(layerId)) {
          map.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
        }
      }
    },

    removeLayer(id) {
      const map = mapRef.current;
      if (!map) return;
      registryRef.current.delete(id);
      hiddenRef.current.delete(id);
      for (const suffix of ["-fill", "-line", "-circle", "-raster"]) {
        const layerId = id + suffix;
        if (map.getLayer(layerId)) map.removeLayer(layerId);
      }
      if (map.getSource(id)) map.removeSource(id);
    },

    fitLayer(id) {
      const map = mapRef.current;
      if (!map) return;
      const source = map.getSource(id) as maplibregl.GeoJSONSource | undefined;
      if (!source) return;
      // @ts-expect-error — private accessor on GeoJSONSource; stable across v5.
      const data = source._data as GeoJSON.FeatureCollection | undefined;
      if (data) fitToData(map, data);
    },

    setBasemap(id) {
      const map = mapRef.current;
      if (!map) return;
      const basemap = listBasemaps().find((b) => b.id === id);
      if (!basemap || !basemap.enabled) return;

      // setStyle wipes every non-basemap layer + source. Replay the registry
      // once the new basemap is ready. `diff: false` ensures a clean rebuild.
      map.setStyle(basemap.style, { diff: false });
      map.once("styledata", () => {
        for (const entry of registryRef.current.values()) {
          if (entry.kind === "geojson") {
            applyGeoJsonLayer(map, entry.layer, hiddenRef.current);
          } else if (entry.kind === "raster") {
            applyRasterLayer(map, entry.layer, hiddenRef.current);
          } else {
            applyVectorTileLayer(map, entry.layer, hiddenRef.current);
          }
        }
      });
    },
  }));

  return <div ref={containerRef} className="absolute inset-0" />;
});

// ---- apply functions --------------------------------------------------------

function applyGeoJsonLayer(
  map: maplibregl.Map,
  layer: VectorClientLayer,
  hidden: Set<string>,
) {
  if (map.getSource(layer.id)) return;
  map.addSource(layer.id, { type: "geojson", data: layer.data });
  const geomType = detectGeometryType(layer.data);
  addStyleLayers(map, layer.id, geomType, layer.color);
  applyVisibility(map, layer.id, hidden);
  fitToData(map, layer.data);
}

function applyRasterLayer(
  map: maplibregl.Map,
  raster: RasterLayer,
  hidden: Set<string>,
) {
  if (map.getSource(raster.id)) return;
  map.addSource(raster.id, {
    type: "raster",
    tiles: [raster.tilesUrlTemplate],
    tileSize: 256,
    minzoom: raster.minzoom ?? 0,
    maxzoom: raster.maxzoom ?? 22,
    attribution: raster.attribution,
  });
  map.addLayer({
    id: raster.id + "-raster",
    type: "raster",
    source: raster.id,
    paint: { "raster-opacity": 0.95 },
  });
  applyVisibility(map, raster.id, hidden);
  if (raster.bbox) {
    map.fitBounds(raster.bbox as LngLatBoundsLike, { padding: 48, duration: 600 });
  }
}

function applyVectorTileLayer(
  map: maplibregl.Map,
  layer: VectorTileLayer,
  hidden: Set<string>,
) {
  if (map.getSource(layer.id)) return;
  map.addSource(layer.id, {
    type: "vector",
    tiles: [layer.tilesUrlTemplate],
    minzoom: layer.minzoom ?? 0,
    maxzoom: layer.maxzoom ?? 22,
  });
  addVectorTileStyleLayers(map, layer);
  applyVisibility(map, layer.id, hidden);
  if (layer.bbox) {
    map.fitBounds(layer.bbox as LngLatBoundsLike, { padding: 48, duration: 600 });
  }
}

function applyVisibility(map: maplibregl.Map, id: string, hidden: Set<string>) {
  if (!hidden.has(id)) return;
  for (const suffix of ["-fill", "-line", "-circle", "-raster"]) {
    const layerId = id + suffix;
    if (map.getLayer(layerId)) map.setLayoutProperty(layerId, "visibility", "none");
  }
}

function detectGeometryType(fc: GeoJSON.FeatureCollection): string {
  const first = fc.features[0]?.geometry?.type ?? "Point";
  return first.toLowerCase();
}

function addStyleLayers(
  map: maplibregl.Map,
  sourceId: string,
  geomType: string,
  color: string,
) {
  if (geomType.includes("polygon")) {
    map.addLayer({
      id: sourceId + "-fill",
      type: "fill",
      source: sourceId,
      paint: {
        "fill-color": color,
        "fill-opacity": 0.35,
      },
    });
    map.addLayer({
      id: sourceId + "-line",
      type: "line",
      source: sourceId,
      paint: {
        "line-color": color,
        "line-width": 1.5,
      },
    });
  } else if (geomType.includes("line")) {
    map.addLayer({
      id: sourceId + "-line",
      type: "line",
      source: sourceId,
      paint: {
        "line-color": color,
        "line-width": 2,
      },
    });
  } else {
    map.addLayer({
      id: sourceId + "-circle",
      type: "circle",
      source: sourceId,
      paint: {
        "circle-color": color,
        "circle-radius": 5,
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 1,
      },
    });
  }
}

function addVectorTileStyleLayers(map: maplibregl.Map, layer: VectorTileLayer) {
  const kind = layer.geometryKind.toLowerCase();
  const baseLayer = {
    source: layer.id,
    "source-layer": layer.sourceLayer,
  } as const;
  if (kind.includes("polygon")) {
    map.addLayer({
      ...baseLayer,
      id: layer.id + "-fill",
      type: "fill",
      paint: { "fill-color": layer.color, "fill-opacity": 0.35 },
    });
    map.addLayer({
      ...baseLayer,
      id: layer.id + "-line",
      type: "line",
      paint: { "line-color": layer.color, "line-width": 1.5 },
    });
  } else if (kind.includes("linestring") || kind.includes("line")) {
    map.addLayer({
      ...baseLayer,
      id: layer.id + "-line",
      type: "line",
      paint: { "line-color": layer.color, "line-width": 2 },
    });
  } else {
    map.addLayer({
      ...baseLayer,
      id: layer.id + "-circle",
      type: "circle",
      paint: {
        "circle-color": layer.color,
        "circle-radius": 5,
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 1,
      },
    });
  }
}

function fitToData(map: maplibregl.Map, fc: GeoJSON.FeatureCollection) {
  const bounds = new maplibregl.LngLatBounds();
  let hasPoint = false;
  for (const f of fc.features) {
    walkCoords(f.geometry, (lng, lat) => {
      bounds.extend([lng, lat]);
      hasPoint = true;
    });
  }
  if (hasPoint) {
    map.fitBounds(bounds as unknown as LngLatBoundsLike, { padding: 48, duration: 600 });
  }
}

type GeomLike = GeoJSON.Geometry | null | undefined;
function walkCoords(geom: GeomLike, cb: (lng: number, lat: number) => void) {
  if (!geom) return;
  if (geom.type === "Point") {
    const [lng, lat] = geom.coordinates;
    cb(lng, lat);
  } else if (geom.type === "MultiPoint" || geom.type === "LineString") {
    for (const [lng, lat] of geom.coordinates) cb(lng, lat);
  } else if (geom.type === "MultiLineString" || geom.type === "Polygon") {
    for (const ring of geom.coordinates) for (const [lng, lat] of ring) cb(lng, lat);
  } else if (geom.type === "MultiPolygon") {
    for (const poly of geom.coordinates)
      for (const ring of poly) for (const [lng, lat] of ring) cb(lng, lat);
  } else if (geom.type === "GeometryCollection") {
    for (const g of geom.geometries) walkCoords(g, cb);
  }
}
