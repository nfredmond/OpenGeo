import { describe, expect, it, vi } from "vitest";

// The operator proof is intentionally a standalone Node script so it can run
// without loading `.env.local`; import the module directly for helper coverage.
import { parseArgs, provePublicDashboard } from "../../scripts/public-dashboard-proof.mjs";

describe("public-dashboard-proof", () => {
  it("parses defaults from a local token environment variable", () => {
    expect(parseArgs(["--json"], { NODE_ENV: "test", OPENGEO_SHARE_TOKEN: "share-secret" })).toEqual({
      token: "share-secret",
      baseUrl: "https://opengeo.vercel.app",
      json: true,
      help: false,
      timeoutMs: 10_000,
    });
  });

  it("summarizes a public PMTiles dashboard without exposing the share token", async () => {
    const fetchImpl = vi.fn(async () => {
      return Response.json(
        {
          ok: true,
          dashboard: {
            name: "Client PMTiles dashboard",
            layer: { kind: "pmtiles" },
            widgets: [{ kind: "feature-count" }, { kind: "feature-count" }],
          },
        },
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const proof = await provePublicDashboard("token.with.secret", {
      baseUrl: "https://opengeo.example.com/",
      fetchImpl,
    });

    expect(proof).toMatchObject({
      ok: true,
      publicHost: "opengeo.example.com",
      httpStatus: 200,
      hasDashboard: true,
      name: "Client PMTiles dashboard",
      layerKind: "pmtiles",
      widgetCount: 2,
      sharePage: "https://opengeo.example.com/p/[redacted]",
    });
    expect(JSON.stringify(proof)).not.toContain("token.with.secret");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://opengeo.example.com/api/share/token.with.secret/dashboard",
      expect.objectContaining({
        method: "GET",
        headers: { accept: "application/json" },
      }),
    );
  });

  it("redacts the share token from request failures", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network failed for https://opengeo.example.com/api/share/token.with.secret/dashboard");
    }) as unknown as typeof fetch;

    await expect(
      provePublicDashboard("token.with.secret", {
        baseUrl: "https://opengeo.example.com",
        fetchImpl,
      }),
    ).rejects.toThrow("https://opengeo.example.com/api/share/[redacted]/dashboard");

    await expect(
      provePublicDashboard("token.with.secret", {
        baseUrl: "https://opengeo.example.com",
        fetchImpl,
      }),
    ).rejects.not.toThrow("token.with.secret");
  });

  it("requires the published dashboard layer to be PMTiles", async () => {
    const fetchImpl = vi.fn(async () => {
      return Response.json(
        { ok: true, dashboard: { name: "Wrong layer", layer: { kind: "vector" }, widgets: [] } },
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    await expect(
      provePublicDashboard("share-secret", {
        baseUrl: "https://opengeo.example.com",
        fetchImpl,
      }),
    ).rejects.toThrow(/PMTiles dashboard layer/);
  });
});
