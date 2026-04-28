import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

// The operator proof is intentionally a standalone Node script so it can run
// without loading `.env.local`; import the module directly for helper coverage.
import {
  normalizePmtilesProof,
  parseArgs,
  provePublicDashboard,
} from "../../scripts/public-dashboard-proof.mjs";

describe("public-dashboard-proof", () => {
  it("parses defaults from a local token environment variable", () => {
    expect(parseArgs(["--json"], { NODE_ENV: "test", OPENGEO_SHARE_TOKEN: "share-secret" })).toEqual({
      token: "share-secret",
      baseUrl: "https://opengeo.vercel.app",
      json: true,
      help: false,
      timeoutMs: 10_000,
      pmtilesProofFile: "",
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

  it("binds a redacted PMTiles range proof to the dashboard layer by fingerprint", async () => {
    const pmtilesUrl = "https://assets.example.com/private/path/client.pmtiles?signature=secret";
    const urlFingerprint = createHash("sha256").update(pmtilesUrl).digest("hex").slice(0, 12);
    const fetchImpl = vi.fn(async () => {
      return Response.json(
        {
          ok: true,
          dashboard: {
            name: "Client PMTiles dashboard",
            layerId: "layer-1",
            layerName: "Client parcels",
            layer: {
              id: "layer-1",
              name: "Client parcels",
              kind: "pmtiles",
              pmtiles: { url: pmtilesUrl, sourceLayer: "parcels" },
            },
            widgets: [
              {
                id: "map",
                type: "pmtiles_map",
                layerId: "layer-1",
                layerName: "Client parcels",
                layer: {
                  id: "layer-1",
                  name: "Client parcels",
                  kind: "pmtiles",
                  pmtiles: { url: pmtilesUrl, sourceLayer: "parcels" },
                },
              },
              { id: "feature-count", type: "feature_count_chart", layerId: "layer-1" },
            ],
          },
        },
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const proof = await provePublicDashboard("token.with.secret", {
      baseUrl: "https://opengeo.example.com",
      fetchImpl,
      pmtilesProof: {
        ok: true,
        publicHost: "assets.example.com",
        status: 206,
        magic: "PMTiles",
        urlFingerprint,
      },
    });

    expect(proof.pmtilesProof).toMatchObject({
      publicHost: "assets.example.com",
      status: 206,
      magic: "PMTiles",
      urlFingerprint,
      matchedDashboardLayerId: "layer-1",
      matchedDashboardLayerName: "Client parcels",
    });
    expect(proof.handoff).toMatchObject({
      contract: "opengeo.public-pmtiles-dashboard.v1",
      checks: expect.arrayContaining([
        { id: "pmtiles-range-206", ok: true, evidence: "range=206" },
        { id: "pmtiles-magic-header", ok: true, evidence: "magic=PMTiles" },
        {
          id: "dashboard-pmtiles-fingerprint-match",
          ok: true,
          evidence: `urlFingerprint=${urlFingerprint}`,
        },
      ]),
    });
    expect(JSON.stringify(proof)).not.toContain(pmtilesUrl);
    expect(JSON.stringify(proof)).not.toContain("signature=secret");
    expect(JSON.stringify(proof)).not.toContain("token.with.secret");
  });

  it("rejects a PMTiles proof that does not match the dashboard URL fingerprint", async () => {
    const pmtilesUrl = "https://assets.example.com/private/path/client.pmtiles?signature=secret";
    const fetchImpl = vi.fn(async () => {
      return Response.json(
        {
          ok: true,
          dashboard: {
            name: "Client PMTiles dashboard",
            layer: {
              kind: "pmtiles",
              pmtiles: { url: pmtilesUrl, sourceLayer: "parcels" },
            },
            widgets: [],
          },
        },
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    await expect(
      provePublicDashboard("token.with.secret", {
        baseUrl: "https://opengeo.example.com",
        fetchImpl,
        pmtilesProof: {
          ok: true,
          publicHost: "assets.example.com",
          status: 206,
          magic: "PMTiles",
          urlFingerprint: "000000000000",
        },
      }),
    ).rejects.toThrow(/did not match/);

    await expect(
      provePublicDashboard("token.with.secret", {
        baseUrl: "https://opengeo.example.com",
        fetchImpl,
        pmtilesProof: {
          ok: true,
          publicHost: "assets.example.com",
          status: 206,
          magic: "PMTiles",
          urlFingerprint: "000000000000",
        },
      }),
    ).rejects.not.toThrow("signature=secret");
  });

  it("requires a real HTTP 206 PMTiles proof contract before handoff matching", () => {
    expect(() =>
      normalizePmtilesProof({
        ok: true,
        publicHost: "assets.example.com",
        status: 200,
        magic: "PMTiles",
        urlFingerprint: "111111111111",
      }),
    ).toThrow(/status=206/);
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
