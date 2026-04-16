// Pluggable AI feature-extraction interface.
//
// Real implementations (segment-geospatial / SAM, Claude Vision, YOLOv8,
// Mask2Former) live behind this contract so the product shell can swap
// them without touching API routes or UI. The mock extractor in
// ./mock-extractor.ts exists to keep the end-to-end flow demo-able
// without a model server running.

export type ExtractionPrompt =
  | { kind: "text"; text: string }
  | { kind: "point"; lng: number; lat: number; label?: "include" | "exclude" }
  | { kind: "bbox"; bbox: [number, number, number, number] };

export type ExtractionInput = {
  orthomosaicId: string;
  cogUrl: string;
  prompt: string;
  prompts?: ExtractionPrompt[];
  bbox?: [number, number, number, number] | null;
};

export type ExtractionResult = {
  featureCollection: GeoJSON.FeatureCollection;
  metrics: {
    model: string;
    latencyMs: number;
    featureCount: number;
    // Free-form extras that a specific model wants to surface (e.g. iou,
    // confidence thresholds, seed).
    extras?: Record<string, unknown>;
  };
};

export interface Extractor {
  readonly name: string;
  readonly model: string;
  extract(input: ExtractionInput): Promise<ExtractionResult>;
}
