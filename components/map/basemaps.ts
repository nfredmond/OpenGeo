import type maplibregl from "maplibre-gl";
import { publicEnv } from "@/lib/public-env";

export type BasemapId = "osm" | "carto-positron" | "carto-dark" | "maplibre-demo" | "custom-pmtiles";

export type Basemap = {
  id: BasemapId;
  label: string;
  provenance: string; // Short, human-readable attribution for the status/side panel.
  style: maplibregl.StyleSpecification;
  enabled: boolean;
};

const GLYPHS = "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf";

const OSM_ATTRIBUTION =
  '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const CARTO_ATTRIBUTION =
  '© <a href="https://carto.com/attributions">CARTO</a>, © <a href="https://www.openstreetmap.org/copyright">OSM</a> contributors';

function rasterStyle(tileUrl: string, attribution: string): maplibregl.StyleSpecification {
  return {
    version: 8,
    glyphs: GLYPHS,
    sources: {
      basemap: {
        type: "raster",
        tiles: [tileUrl],
        tileSize: 256,
        attribution,
      },
    },
    layers: [{ id: "basemap", type: "raster", source: "basemap" }],
  };
}

function pmTilesStyle(url: string): maplibregl.StyleSpecification {
  return {
    version: 8,
    glyphs: GLYPHS,
    sources: {
      basemap: {
        type: "vector",
        url: `pmtiles://${url}`,
        attribution: `Protomaps basemap (${url})`,
      },
    },
    // Intentionally empty — styling a Protomaps PMTiles pack is a separate
    // piece of work (Phase 1.5). Until then the basemap surface is blank so
    // the user's layers pop against a neutral backdrop.
    layers: [],
  };
}

export function listBasemaps(): Basemap[] {
  const pmtilesUrl = publicEnv.NEXT_PUBLIC_BASEMAP_PMTILES_URL;
  return [
    {
      id: "osm",
      label: "OpenStreetMap",
      provenance: OSM_ATTRIBUTION.replace(/<[^>]+>/g, ""),
      style: rasterStyle("https://tile.openstreetmap.org/{z}/{x}/{y}.png", OSM_ATTRIBUTION),
      enabled: true,
    },
    {
      id: "carto-positron",
      label: "Carto Positron",
      provenance: "CARTO Positron (light) + OSM",
      style: rasterStyle(
        "https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
        CARTO_ATTRIBUTION,
      ),
      enabled: true,
    },
    {
      id: "carto-dark",
      label: "Carto Dark Matter",
      provenance: "CARTO Dark Matter + OSM",
      style: rasterStyle(
        "https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
        CARTO_ATTRIBUTION,
      ),
      enabled: true,
    },
    {
      id: "maplibre-demo",
      label: "MapLibre demo tiles",
      provenance: "MapLibre demotiles (cached Natural Earth)",
      style: {
        version: 8,
        glyphs: GLYPHS,
        sources: {
          basemap: {
            type: "vector",
            url: "https://demotiles.maplibre.org/tiles/tiles.json",
            attribution: "MapLibre demotiles",
          },
        },
        layers: [
          { id: "bg", type: "background", paint: { "background-color": "#f5f5f4" } },
        ],
      },
      enabled: true,
    },
    {
      id: "custom-pmtiles",
      label: "Custom PMTiles",
      provenance: pmtilesUrl
        ? `Custom: ${pmtilesUrl}`
        : "Set NEXT_PUBLIC_BASEMAP_PMTILES_URL to enable",
      style: pmTilesStyle(pmtilesUrl || "about:blank"),
      enabled: Boolean(pmtilesUrl),
    },
  ];
}

export function defaultBasemapId(): BasemapId {
  return publicEnv.NEXT_PUBLIC_BASEMAP_PMTILES_URL ? "custom-pmtiles" : "osm";
}
