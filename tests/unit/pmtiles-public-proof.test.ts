import { describe, expect, it, vi } from "vitest";

import { parseArgs, provePublicPmtilesUrl } from "../../scripts/pmtiles-public-proof.mjs";

describe("pmtiles-public-proof", () => {
  it("parses a URL from the public proof environment", () => {
    const previous = process.env.PMTILES_PROOF_URL;
    process.env.PMTILES_PROOF_URL = "https://assets.example.com/pmtiles/layer.pmtiles";
    try {
      expect(parseArgs(["--json"])).toEqual({
        url: "https://assets.example.com/pmtiles/layer.pmtiles",
        json: true,
        help: false,
        rangeBytes: 16,
        timeoutMs: 10_000,
      });
    } finally {
      if (previous === undefined) {
        delete process.env.PMTILES_PROOF_URL;
      } else {
        process.env.PMTILES_PROOF_URL = previous;
      }
    }
  });

  it("captures a secret-safe HTTP 206 PMTiles range proof", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(new TextEncoder().encode("PMTiles fixture bytes"), {
        status: 206,
        headers: {
          "accept-ranges": "bytes",
          "content-range": "bytes 0-15/24",
          "content-type": "application/vnd.pmtiles",
        },
      });
    }) as unknown as typeof fetch;

    const proof = await provePublicPmtilesUrl(
      "https://assets.example.com/private/path/client.pmtiles?signature=secret",
      { fetchImpl },
    );

    expect(proof).toMatchObject({
      ok: true,
      publicHost: "assets.example.com",
      redactedUrl: "https://assets.example.com/[redacted].pmtiles",
      status: 206,
      magic: "PMTiles",
      bytesRead: 16,
      contentRange: "bytes 0-15/24",
      acceptRanges: "bytes",
      proof: "public=assets.example.com range=206 magic=PMTiles",
    });
    expect(JSON.stringify(proof)).not.toContain("signature=secret");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://assets.example.com/private/path/client.pmtiles?signature=secret",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ range: "bytes=0-15" }),
      }),
    );
  });

  it("rejects HTTP 200 responses because the operator gate requires range=206", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(new TextEncoder().encode("PMTiles fixture bytes"), { status: 200 });
    }) as unknown as typeof fetch;

    await expect(
      provePublicPmtilesUrl("https://assets.example.com/private/path/client.pmtiles?signature=secret", {
        fetchImpl,
      }),
    ).rejects.toThrow("Expected HTTP 206 byte-range response");

    await expect(
      provePublicPmtilesUrl("https://assets.example.com/private/path/client.pmtiles?signature=secret", {
        fetchImpl,
      }),
    ).rejects.not.toThrow("signature=secret");
  });
});
