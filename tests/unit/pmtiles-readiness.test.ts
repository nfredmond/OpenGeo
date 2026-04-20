import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  env: {
    R2_ACCOUNT_ID: "account",
    R2_ACCESS_KEY_ID: "access",
    R2_SECRET_ACCESS_KEY: "secret",
    R2_BUCKET: "opengeo-assets",
    R2_PUBLIC_BASE_URL: "https://assets.example.com",
    TIPPECANOE_BIN: "tippecanoe",
    PMTILES_GENERATOR_URL: "https://generator.example.com/generate",
    PMTILES_GENERATOR_TOKEN: "generator-secret",
  },
}));

vi.mock("@/lib/env", () => ({
  env: () => mocks.env,
}));

const { pmtilesPublishReadiness, pmtilesReadinessError } = await import(
  "@/lib/pmtiles-readiness"
);

describe("pmtilesPublishReadiness", () => {
  beforeEach(() => {
    mocks.env.R2_ACCOUNT_ID = "account";
    mocks.env.R2_ACCESS_KEY_ID = "access";
    mocks.env.R2_SECRET_ACCESS_KEY = "secret";
    mocks.env.R2_BUCKET = "opengeo-assets";
    mocks.env.R2_PUBLIC_BASE_URL = "https://assets.example.com";
    mocks.env.TIPPECANOE_BIN = "tippecanoe";
    mocks.env.PMTILES_GENERATOR_URL = "https://generator.example.com/generate";
    mocks.env.PMTILES_GENERATOR_TOKEN = "generator-secret";
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;
  });

  it("is ready when R2 and the remote generator are configured", () => {
    const readiness = pmtilesPublishReadiness();

    expect(readiness.ok).toBe(true);
    expect(readiness.missing).toEqual([]);
    expect(readiness.generation).toMatchObject({
      ok: true,
      mode: "remote",
      remoteUrlConfigured: true,
      tokenConfigured: true,
    });
  });

  it("reports missing R2 settings", () => {
    mocks.env.R2_ACCOUNT_ID = "";
    mocks.env.R2_PUBLIC_BASE_URL = "";

    const readiness = pmtilesPublishReadiness();

    expect(readiness.ok).toBe(false);
    expect(readiness.r2.ok).toBe(false);
    expect(readiness.missing).toEqual(["R2_ACCOUNT_ID", "R2_PUBLIC_BASE_URL"]);
    expect(pmtilesReadinessError(readiness)).toContain("R2_ACCOUNT_ID");
  });

  it("requires the remote generator on Vercel", () => {
    process.env.VERCEL = "1";
    mocks.env.PMTILES_GENERATOR_URL = "";

    const readiness = pmtilesPublishReadiness();

    expect(readiness.ok).toBe(false);
    expect(readiness.generation).toMatchObject({
      ok: false,
      mode: "local",
      missing: ["PMTILES_GENERATOR_URL"],
    });
  });

  it("allows local Tippecanoe outside Vercel", () => {
    mocks.env.PMTILES_GENERATOR_URL = "";

    const readiness = pmtilesPublishReadiness();

    expect(readiness.ok).toBe(true);
    expect(readiness.generation.mode).toBe("local");
    expect(readiness.warnings[0]).toContain("local Tippecanoe");
  });
});
