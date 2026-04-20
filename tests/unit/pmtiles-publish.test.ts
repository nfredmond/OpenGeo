import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  env: {
    TIPPECANOE_BIN: "tippecanoe",
    PMTILES_GENERATOR_URL: "https://generator.example.com/generate",
    PMTILES_GENERATOR_TOKEN: "secret-token",
  },
}));

vi.mock("@/lib/env", () => ({
  env: () => mocks.env,
}));

const { generatePmtilesArchive, PmtilesGeneratorError } = await import(
  "@/lib/pmtiles-publish"
);

const featureCollection: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [-121.1, 39.2] },
      properties: { name: "A" },
    },
  ],
};

describe("generatePmtilesArchive", () => {
  beforeEach(() => {
    mocks.env.PMTILES_GENERATOR_URL = "https://generator.example.com/generate";
    mocks.env.PMTILES_GENERATOR_TOKEN = "secret-token";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))),
    );
  });

  it("uses the remote generator when PMTILES_GENERATOR_URL is configured", async () => {
    const archive = await generatePmtilesArchive({
      featureCollection,
      name: "Published parcels",
      sourceLayer: "parcels",
      minzoom: 1,
      maxzoom: 12,
    });

    expect(Array.from(archive)).toEqual([1, 2, 3]);
    expect(fetch).toHaveBeenCalledWith(
      "https://generator.example.com/generate",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          accept: "application/vnd.pmtiles",
          authorization: "Bearer secret-token",
          "content-type": "application/json",
        }),
      }),
    );
    const [, init] = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(init?.body as string) as {
      name: string;
      sourceLayer: string;
      minzoom: number;
      maxzoom: number;
    };
    expect(body).toMatchObject({
      name: "Published parcels",
      sourceLayer: "parcels",
      minzoom: 1,
      maxzoom: 12,
    });
  });

  it("does not send authorization when no generator token is configured", async () => {
    mocks.env.PMTILES_GENERATOR_TOKEN = "";
    await generatePmtilesArchive({
      featureCollection,
      name: "Published parcels",
      sourceLayer: "parcels",
      minzoom: 0,
      maxzoom: 14,
    });

    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(init?.headers).not.toHaveProperty("authorization");
  });

  it("throws a typed error when the generator fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    );

    await expect(
      generatePmtilesArchive({
        featureCollection,
        name: "Published parcels",
        sourceLayer: "parcels",
        minzoom: 0,
        maxzoom: 14,
      }),
    ).rejects.toBeInstanceOf(PmtilesGeneratorError);
  });
});
