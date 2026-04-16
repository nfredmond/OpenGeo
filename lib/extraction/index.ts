import "server-only";
import { env } from "@/lib/env";
import { MockExtractor } from "./mock-extractor";
import type { Extractor } from "./types";

export type { Extractor, ExtractionInput, ExtractionResult, ExtractionPrompt } from "./types";

// Selects the extractor implementation at runtime. The default is the mock
// extractor so `docker compose up -d && pnpm dev` gives a working pipeline
// out of the box. Real implementations plug in by returning a different
// Extractor from this factory (or by reading env flags like
// OPENGEO_EXTRACTOR_URL once the HTTP-backed implementation exists).
export function getExtractor(): Extractor {
  const preferred = process.env.OPENGEO_EXTRACTOR ?? "mock";
  switch (preferred) {
    case "mock":
    default:
      return new MockExtractor();
  }
}

// Re-export for callers that want to guard on the feature flag without
// pulling env.ts directly.
export function extractionEnabled(): boolean {
  return env().FEATURE_AI_FEATURE_EXTRACTION === "true";
}
