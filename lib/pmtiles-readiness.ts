import "server-only";
import { env } from "@/lib/env";
import { missingR2Config } from "@/lib/r2";

export type PmtilesPublishReadiness = {
  ok: boolean;
  missing: string[];
  warnings: string[];
  r2: {
    ok: boolean;
    missing: string[];
    bucketConfigured: boolean;
    publicBaseUrlConfigured: boolean;
  };
  generation: {
    ok: boolean;
    mode: "remote" | "local";
    missing: string[];
    remoteUrlConfigured: boolean;
    tokenConfigured: boolean;
    localBinary: string | null;
  };
};

export function pmtilesPublishReadiness(): PmtilesPublishReadiness {
  const cfg = env();
  const r2Missing = missingR2Config();
  const remoteUrlConfigured = Boolean(cfg.PMTILES_GENERATOR_URL);
  const runningOnVercel = process.env.VERCEL === "1" || Boolean(process.env.VERCEL_ENV);
  const localBinary = cfg.TIPPECANOE_BIN.trim();
  const generationMissing: string[] = [];
  const warnings: string[] = [];

  if (!remoteUrlConfigured && runningOnVercel) {
    generationMissing.push("PMTILES_GENERATOR_URL");
  } else if (!remoteUrlConfigured && !localBinary) {
    generationMissing.push("PMTILES_GENERATOR_URL or TIPPECANOE_BIN");
  } else if (!remoteUrlConfigured) {
    warnings.push(`Using local Tippecanoe binary: ${localBinary}.`);
  }

  const missing = [...r2Missing, ...generationMissing];

  return {
    ok: missing.length === 0,
    missing,
    warnings,
    r2: {
      ok: r2Missing.length === 0,
      missing: r2Missing,
      bucketConfigured: Boolean(cfg.R2_BUCKET),
      publicBaseUrlConfigured: Boolean(cfg.R2_PUBLIC_BASE_URL),
    },
    generation: {
      ok: generationMissing.length === 0,
      mode: remoteUrlConfigured ? "remote" : "local",
      missing: generationMissing,
      remoteUrlConfigured,
      tokenConfigured: Boolean(cfg.PMTILES_GENERATOR_TOKEN),
      localBinary: remoteUrlConfigured ? null : localBinary || null,
    },
  };
}

export function pmtilesReadinessError(readiness: PmtilesPublishReadiness): string {
  if (readiness.ok) return "";
  return `PMTiles publishing is not configured: ${readiness.missing.join(", ")}.`;
}
