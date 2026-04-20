export type PmtilesLayerMetadata = {
  url: string;
  sourceLayer: string;
  bbox: [number, number, number, number] | null;
  minzoom: number;
  maxzoom: number;
  attribution: string | null;
};

export function pmtilesSourceUrl(url: string): string {
  return url.startsWith("pmtiles://") ? url : `pmtiles://${url}`;
}

export function parsePmtilesLayerMetadata(
  layerMetadata: unknown,
  datasetSourceUri?: string | null,
): PmtilesLayerMetadata | null {
  if (typeof layerMetadata !== "object" || layerMetadata === null) return null;
  const pmtiles = (layerMetadata as { pmtiles?: unknown }).pmtiles;
  if (typeof pmtiles !== "object" || pmtiles === null) return null;
  const raw = pmtiles as Record<string, unknown>;
  const url = typeof raw.url === "string" ? raw.url : datasetSourceUri;
  const sourceLayer = typeof raw.sourceLayer === "string" ? raw.sourceLayer : null;
  if (!url || !sourceLayer) return null;

  return {
    url,
    sourceLayer,
    bbox: parseBbox(raw.bbox),
    minzoom: typeof raw.minzoom === "number" ? raw.minzoom : 0,
    maxzoom: typeof raw.maxzoom === "number" ? raw.maxzoom : 14,
    attribution: typeof raw.attribution === "string" ? raw.attribution : null,
  };
}

function parseBbox(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  if (!value.every((v) => typeof v === "number" && Number.isFinite(v))) return null;
  return value as [number, number, number, number];
}
