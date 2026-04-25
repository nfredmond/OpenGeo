import { describe, expect, it } from "vitest";

const inventory = (await import("../../scripts/vercel-env-inventory.mjs")) as {
  requiredVercelEnvKeys: readonly string[];
  createVercelEnvInventoryReport: (input: {
    envs: VercelEnvFixture[];
    targets?: readonly string[];
    requiredKeys?: readonly string[];
  }) => {
    ok: boolean;
    targets: string[];
    requiredKeyCount: number;
    missing: string[];
  };
  findMissingVercelEnvKeys: (
    envs: VercelEnvFixture[],
    targets?: readonly string[],
    requiredKeys?: readonly string[],
  ) => string[];
  parseInventoryArgs: (args: string[]) => {
    targets: string[];
    json: boolean;
    help: boolean;
  };
};

type VercelEnvFixture = {
  key: string;
  target: string | string[];
  gitBranch?: string | null;
};

function completeEnvEntries(): VercelEnvFixture[] {
  return inventory.requiredVercelEnvKeys.flatMap((key) => [
    { key, target: "production" },
    { key, target: "preview" },
  ]);
}

describe("vercel env inventory helpers", () => {
  it("passes when every required key exists globally for production and preview", () => {
    const report = inventory.createVercelEnvInventoryReport({
      envs: completeEnvEntries(),
    });

    expect(report).toEqual({
      ok: true,
      targets: ["production", "preview"],
      requiredKeyCount: inventory.requiredVercelEnvKeys.length,
      missing: [],
    });
  });

  it("accepts one Vercel env record that targets both production and preview", () => {
    const envs = inventory.requiredVercelEnvKeys.map((key) => ({
      key,
      target: ["production", "preview"],
    }));

    expect(inventory.findMissingVercelEnvKeys(envs)).toEqual([]);
  });

  it("does not count branch-scoped preview keys as global preview keys", () => {
    const key = inventory.requiredVercelEnvKeys[0];
    const envs = completeEnvEntries().filter(
      (env) => !(env.key === key && env.target === "preview"),
    );
    envs.push({ key, target: "preview", gitBranch: "feature/demo" });

    expect(inventory.findMissingVercelEnvKeys(envs)).toEqual([`preview:${key}`]);
  });

  it("parses target arguments and keeps output JSON by default", () => {
    expect(inventory.parseInventoryArgs(["--target=preview"])).toEqual({
      targets: ["preview"],
      json: true,
      help: false,
    });

    expect(inventory.parseInventoryArgs(["--targets=production,preview", "--json"]).targets).toEqual([
      "production",
      "preview",
    ]);
  });
});
