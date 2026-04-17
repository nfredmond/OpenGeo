import "server-only";
import { env } from "@/lib/env";
import { HttpExtractor } from "./http-extractor";
import { MockExtractor } from "./mock-extractor";
import type { Extractor } from "./types";

export type { Extractor, ExtractionInput, ExtractionResult, ExtractionPrompt } from "./types";

// Selects the extractor implementation at runtime. The default is the mock
// extractor so `docker compose up -d && pnpm dev` gives a working pipeline
// out of the box. Setting OPENGEO_EXTRACTOR=http switches to the HTTP-backed
// LangSAM service — either a local docker-compose CPU container for dev or
// Modal for production. See ADR-002 and services/extractor/README.md.
export function getExtractor(): Extractor {
  const preferred = process.env.OPENGEO_EXTRACTOR ?? "mock";
  switch (preferred) {
    case "http": {
      const e = env();
      if (!e.OPENGEO_EXTRACTOR_URL) {
        throw new Error(
          "OPENGEO_EXTRACTOR=http requires OPENGEO_EXTRACTOR_URL to be set.",
        );
      }
      return new HttpExtractor(
        e.OPENGEO_EXTRACTOR_URL,
        e.OPENGEO_EXTRACTOR_TOKEN,
      );
    }
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
