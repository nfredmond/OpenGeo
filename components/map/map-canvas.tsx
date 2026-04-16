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
import { publicEnv } from "@/lib/public-env";

type VectorClientLayer = Extract<ClientLayer, { kind?: "vector" }>;

export type MapCanvasHandle = {
  addGeoJsonLayer: (layer: VectorClientLayer) => void;
  addRasterLayer: (raster: RasterLayer) => void;
  toggleLayer: (id: string, visible: boolean) => void;
  removeLayer: (id: string) => void;
  fitLayer: (id: string) => void;
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

const FALLBACK_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
  sources: {
    basemap: {
      type: "raster",
      tiles: [
        "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      ],
      tileSize: 256,
      attribution:
        '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    },
  },
  layers: [
    { id: "basemap", type: "raster", source: "basemap" },
  ],
};

export const MapCanvas = forwardRef<MapCanvasHandle>(function MapCanvas(_, ref) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const protocol = new Protocol();
    maplibregl.addProtocol("pmtiles", protocol.tile);

    const style: maplibregl.StyleSpecification = publicEnv
      .NEXT_PUBLIC_BASEMAP_PMTILES_URL
      ? {
          version: 8,
          glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
          sources: {
            basemap: {
              type: "vector",
              url: `pmtiles://${publicEnv.NEXT_PUBLIC_BASEMAP_PMTILES_URL}`,
            },
          },
          layers: [],
        }
      : FALLBACK_STYLE;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style,
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
      const apply = () => {
        if (map.getSource(layer.id)) return;
        map.addSource(layer.id, {
          type: "geojson",
          data: layer.data,
        });
        const geomType = detectGeometryType(layer.data);
        addStyleLayers(map, layer.id, geomType, layer.color);
        fitToData(map, layer.data);
      };
      if (map.isStyleLoaded()) apply();
      else map.once("load", apply);
    },

    addRasterLayer(raster) {
      const map = mapRef.current;
      if (!map) return;
      const apply = () => {
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
        if (raster.bbox) {
          map.fitBounds(raster.bbox as LngLatBoundsLike, { padding: 48, duration: 600 });
        }
      };
      if (map.isStyleLoaded()) apply();
      else map.once("load", apply);
    },

    toggleLayer(id, visible) {
      const map = mapRef.current;
      if (!map) return;
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
  }));

  return <div ref={containerRef} className="absolute inset-0" />;
});

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
