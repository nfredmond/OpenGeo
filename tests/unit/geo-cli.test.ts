import { describe, expect, it, vi } from "vitest";
import { __geoCliTest, runGeo, type GeoCliDeps } from "@/cli/src/index";

const completeEnv: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
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
  R2_ACCOUNT_ID: "account",
  R2_ACCESS_KEY_ID: "access",
  R2_SECRET_ACCESS_KEY: "r2-secret-value",
  R2_BUCKET: "opengeo-assets",
  R2_PUBLIC_BASE_URL: "https://assets.example.com",
  PMTILES_GENERATOR_URL: "https://generator.example.com/generate",
  PMTILES_GENERATOR_TOKEN: "generator-token-value",
};

function deps(env: NodeJS.ProcessEnv = { NODE_ENV: "test" }): {
  deps: GeoCliDeps;
  stdout: string[];
  stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    deps: {
      env,
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
      fetch: vi.fn(),
      runCommand: vi.fn(async () => 0),
    },
  };
}

describe("geo CLI", () => {
  it("prints help with doctor command", async () => {
    const io = deps();

    const code = await runGeo(["help"], io.deps);

    expect(code).toBe(0);
    expect(io.stdout.join("\n")).toContain("doctor");
  });

  it("runs doctor checks with normal text output", async () => {
    const io = deps({
      ...completeEnv,
      R2_ACCOUNT_ID: "",
      PMTILES_GENERATOR_URL: "",
    });

    const code = await runGeo(
      ["doctor", "--target=preview", "--scope=pmtiles"],
      io.deps,
    );

    expect(code).toBe(1);
    expect(io.stdout.join("\n")).toContain("pmtiles.r2");
    expect(io.stdout.join("\n")).toContain("PMTILES_GENERATOR_URL");
    expect(io.stdout.join("\n")).not.toContain("r2-secret-value");
    expect(io.stdout.join("\n")).not.toContain("generator-token-value");
  });

  it("runs doctor checks with JSON output", async () => {
    const io = deps(completeEnv);

    const code = await runGeo(
      ["doctor", "--target", "production", "--scope", "core,pmtiles", "--json"],
      io.deps,
    );
    const report = JSON.parse(io.stdout[0]) as {
      ok: boolean;
      target: string;
      scopes: string[];
    };

    expect(code).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.target).toBe("production");
    expect(report.scopes).toEqual(["core", "pmtiles"]);
  });

  it("rejects invalid doctor arguments", async () => {
    const io = deps(completeEnv);

    const code = await runGeo(["doctor", "--scope=bad"], io.deps);

    expect(code).toBe(2);
    expect(io.stderr.join("\n")).toContain("invalid scope");
  });

  it("keeps deploy command behavior injectable", async () => {
    const io = deps(completeEnv);

    const code = await runGeo(["deploy", "--prod"], io.deps);

    expect(code).toBe(0);
    expect(io.deps.runCommand).toHaveBeenCalledWith("vercel", ["deploy", "--prod"]);
  });

  it("prints the first operator loop as text and JSON", async () => {
    const textIo = deps(completeEnv);

    const textCode = await runGeo(["operator-loop"], textIo.deps);

    expect(textCode).toBe(0);
    expect(textIo.stdout.join("\n")).toContain("site-intelligence");
    expect(textIo.stdout.join("\n")).toContain("pnpm gauntlet");

    const jsonIo = deps(completeEnv);
    const jsonCode = await runGeo(["loop", "--json"], jsonIo.deps);
    const loop = JSON.parse(jsonIo.stdout[0]) as { name: string; gates: string[] };

    expect(jsonCode).toBe(0);
    expect(loop.name).toBe("site-intelligence");
    expect(loop.gates.some((gate) => gate.includes("PMTiles"))).toBe(true);
  });

  it("unquotes dotenv values", () => {
    expect(__geoCliTest.unquoteEnvValue('"abc"')).toBe("abc");
    expect(__geoCliTest.unquoteEnvValue("abc # comment")).toBe("abc");
  });
});
