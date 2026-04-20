import { describe, expect, it } from "vitest";
import { formatEnvDoctorReport, runEnvDoctor } from "@/lib/env-doctor";

const baseEnv = {
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  SUPABASE_DB_URL: "postgresql://postgres:secret@example.supabase.co:5432/postgres",
  LOCAL_DB_URL: "postgresql://opengeo:opengeo@localhost:5433/opengeo",
  FEATURE_AI_NL_SQL: "false",
  FEATURE_AI_STYLE_GEN: "false",
  FEATURE_AI_FEATURE_EXTRACTION: "false",
  FEATURE_DRONE_PIPELINE: "false",
  FEATURE_DURABLE_PIPELINE: "false",
  OPENGEO_EXTRACTOR: "mock",
};

const pmtilesEnv = {
  R2_ACCOUNT_ID: "account",
  R2_ACCESS_KEY_ID: "access",
  R2_SECRET_ACCESS_KEY: "r2-secret-value",
  R2_BUCKET: "opengeo-assets",
  R2_PUBLIC_BASE_URL: "https://assets.example.com",
  PMTILES_GENERATOR_URL: "https://generator.example.com/generate",
  PMTILES_GENERATOR_TOKEN: "generator-token-value",
  TIPPECANOE_BIN: "tippecanoe",
};

describe("runEnvDoctor", () => {
  it("passes core checks for a complete local env", () => {
    const report = runEnvDoctor({
      env: baseEnv,
      target: "local",
      scopes: ["core"],
    });

    expect(report.ok).toBe(true);
    expect(report.failures).toBe(0);
  });

  it("fails deployed PMTiles checks when R2 and generator settings are missing", () => {
    const report = runEnvDoctor({
      env: baseEnv,
      target: "preview",
      scopes: ["pmtiles"],
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "pmtiles.r2",
          status: "fail",
          keys: expect.arrayContaining(["R2_ACCOUNT_ID", "R2_PUBLIC_BASE_URL"]),
        }),
        expect.objectContaining({
          id: "pmtiles.generator",
          status: "fail",
          keys: ["PMTILES_GENERATOR_URL"],
        }),
      ]),
    );
  });

  it("passes deployed PMTiles checks when R2 and generator settings exist", () => {
    const report = runEnvDoctor({
      env: { ...baseEnv, ...pmtilesEnv },
      target: "production",
      scopes: ["pmtiles"],
    });

    expect(report.ok).toBe(true);
    expect(report.warnings).toBe(0);
  });

  it("requires Anthropic only when AI text features are enabled", () => {
    const disabled = runEnvDoctor({
      env: baseEnv,
      scopes: ["ai"],
    });
    const enabled = runEnvDoctor({
      env: { ...baseEnv, FEATURE_AI_NL_SQL: "true" },
      scopes: ["ai"],
    });

    expect(disabled.ok).toBe(true);
    expect(enabled.ok).toBe(false);
    expect(enabled.checks).toContainEqual(
      expect.objectContaining({
        id: "ai.anthropic-key",
        status: "fail",
        keys: ["ANTHROPIC_API_KEY"],
      }),
    );
  });

  it("formats without exposing values", () => {
    const report = runEnvDoctor({
      env: { ...baseEnv, ...pmtilesEnv },
      target: "production",
      scopes: ["all"],
    });
    const output = formatEnvDoctorReport(report);

    expect(output).toContain("OpenGeo env doctor target=production");
    expect(output).not.toContain("r2-secret-value");
    expect(output).not.toContain("generator-token-value");
  });
});
