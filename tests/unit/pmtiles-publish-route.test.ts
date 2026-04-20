import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockR2ConfigError extends Error {
    constructor(missing: string[]) {
      super(`Missing R2 configuration: ${missing.join(", ")}`);
      this.name = "R2ConfigError";
    }
  }
  class MockR2UploadError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "R2UploadError";
    }
  }
  class MockTippecanoeError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "TippecanoeError";
    }
  }
  class MockPmtilesGeneratorError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "PmtilesGeneratorError";
    }
  }
  return {
    pmtilesPublishReadiness: vi.fn(),
    pmtilesReadinessError: vi.fn(),
    publishGeoJsonAsPmtiles: vi.fn(),
    R2ConfigError: MockR2ConfigError,
    R2UploadError: MockR2UploadError,
    PmtilesGeneratorError: MockPmtilesGeneratorError,
    TippecanoeError: MockTippecanoeError,
  };
});

vi.mock("next/headers", () => ({
  cookies: () => ({ getAll: () => [], set: () => {} }),
}));

vi.mock("@/lib/env", () => ({
  env: () => ({
    NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-stub",
    SUPABASE_SERVICE_ROLE_KEY: "service-stub",
  }),
  flag: {},
}));

vi.mock("@/lib/pmtiles-publish", () => ({
  PmtilesGeneratorError: mocks.PmtilesGeneratorError,
  publishGeoJsonAsPmtiles: mocks.publishGeoJsonAsPmtiles,
  TippecanoeError: mocks.TippecanoeError,
}));

vi.mock("@/lib/r2", () => ({
  R2ConfigError: mocks.R2ConfigError,
  R2UploadError: mocks.R2UploadError,
}));

vi.mock("@/lib/pmtiles-readiness", () => ({
  pmtilesPublishReadiness: mocks.pmtilesPublishReadiness,
  pmtilesReadinessError: mocks.pmtilesReadinessError,
}));

type LayerRow = {
  id: string;
  name: string;
  geometry_kind: string;
  feature_count: number;
  style: Record<string, unknown> | null;
  dataset: {
    id: string;
    project_id: string;
    name: string;
    kind: string;
  };
};

type State = {
  user: { id: string } | null;
  layer: LayerRow | null;
  canEdit: boolean;
  featureCollection: GeoJSON.FeatureCollection;
  inserts: Record<string, Array<Record<string, unknown>>>;
  rpcCalls: string[];
};

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

const state: State = {
  user: { id: "u1" },
  layer: null,
  canEdit: true,
  featureCollection,
  inserts: { datasets: [], layers: [] },
  rpcCalls: [],
};

const readyState = {
  ok: true,
  missing: [],
  warnings: [],
  r2: { ok: true, missing: [], bucketConfigured: true, publicBaseUrlConfigured: true },
  generation: {
    ok: true,
    mode: "remote",
    missing: [],
    remoteUrlConfigured: true,
    tokenConfigured: true,
    localBinary: null,
  },
};

function resetState() {
  state.user = { id: "u1" };
  state.layer = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Parcels",
    geometry_kind: "point",
    feature_count: 1,
    style: { pointColor: "#123456" },
    dataset: {
      id: "d-source",
      project_id: "22222222-2222-4222-8222-222222222222",
      name: "Parcels",
      kind: "geojson",
    },
  };
  state.canEdit = true;
  state.featureCollection = featureCollection;
  state.inserts = { datasets: [], layers: [] };
  state.rpcCalls = [];
  mocks.pmtilesPublishReadiness.mockReset();
  mocks.pmtilesPublishReadiness.mockReturnValue(readyState);
  mocks.pmtilesReadinessError.mockReset();
  mocks.pmtilesReadinessError.mockReturnValue("PMTiles publishing is not configured: R2_ACCOUNT_ID.");
  mocks.publishGeoJsonAsPmtiles.mockReset();
  mocks.publishGeoJsonAsPmtiles.mockResolvedValue({
    url: "https://assets.example.com/pmtiles/source/parcels.pmtiles",
    key: "pmtiles/source/parcels.pmtiles",
    bytes: 1234,
  });
}

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => ({
    auth: {
      getUser: async () => ({ data: { user: state.user }, error: null }),
    },
    schema: (schemaName: string) => ({
      from: (table: string) => buildFromMock(schemaName, table),
      rpc: async (fn: string, args: Record<string, unknown>) => {
        if (schemaName !== "opengeo") throw new Error(`unexpected schema ${schemaName}`);
        state.rpcCalls.push(fn);
        if (fn === "has_project_access") {
          expect(args).toMatchObject({
            target_project: "22222222-2222-4222-8222-222222222222",
            min_role: "editor",
          });
          return { data: state.canEdit, error: null };
        }
        if (fn === "layer_as_geojson") {
          expect(args.p_layer_id).toBe("11111111-1111-4111-8111-111111111111");
          return { data: state.featureCollection, error: null };
        }
        throw new Error(`unexpected rpc ${fn}`);
      },
    }),
  }),
}));

function buildFromMock(schemaName: string, table: string) {
  if (schemaName !== "opengeo") throw new Error(`unexpected schema ${schemaName}`);
  const chain = {
    _row: null as Record<string, unknown> | null,
    select(_cols: string) {
      return chain;
    },
    eq(_column: string, _value: string) {
      return chain;
    },
    insert(row: Record<string, unknown>) {
      chain._row = row;
      state.inserts[table] ??= [];
      state.inserts[table].push(row);
      return chain;
    },
    async single() {
      if (chain._row) {
        if (table === "datasets") return { data: { id: "d-published" }, error: null };
        if (table === "layers") {
          return {
            data: {
              id: "l-published",
              name: chain._row.name,
              geometry_kind: chain._row.geometry_kind,
              feature_count: chain._row.feature_count,
              style: chain._row.style,
              metadata: chain._row.metadata,
            },
            error: null,
          };
        }
      }
      if (table === "layers") {
        if (!state.layer) {
          return { data: null, error: { code: "PGRST116", message: "Layer not found." } };
        }
        return { data: state.layer, error: null };
      }
      return { data: null, error: null };
    },
  };
  return chain;
}

const { GET, POST } = await import("@/app/api/pmtiles/publish/route");

function req(body: unknown) {
  return new Request("http://localhost/api/pmtiles/publish", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function getReq() {
  return new Request("http://localhost/api/pmtiles/publish", {
    method: "GET",
  });
}

const ctx = { params: Promise.resolve({}) };

describe("GET /api/pmtiles/publish", () => {
  beforeEach(resetState);

  it("401 when unauthenticated", async () => {
    state.user = null;
    const res = await GET(getReq(), ctx);
    expect(res.status).toBe(401);
  });

  it("returns server readiness for authenticated users", async () => {
    const res = await GET(getReq(), ctx);
    const body = (await res.json()) as { ok: boolean; readiness: typeof readyState };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.readiness.ok).toBe(true);
    expect(mocks.pmtilesPublishReadiness).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/pmtiles/publish", () => {
  beforeEach(resetState);

  it("401 when unauthenticated", async () => {
    state.user = null;
    const res = await POST(req({ layerId: "11111111-1111-4111-8111-111111111111" }), ctx);
    expect(res.status).toBe(401);
  });

  it("403 when the user is not an editor", async () => {
    state.canEdit = false;
    const res = await POST(req({ layerId: "11111111-1111-4111-8111-111111111111" }), ctx);
    const body = (await res.json()) as { error: string };
    expect(res.status).toBe(403);
    expect(body.error).toContain("Not authorized");
    expect(mocks.publishGeoJsonAsPmtiles).not.toHaveBeenCalled();
  });

  it("503s before GeoJSON export when publishing infrastructure is not ready", async () => {
    mocks.pmtilesPublishReadiness.mockReturnValueOnce({
      ...readyState,
      ok: false,
      missing: ["R2_ACCOUNT_ID"],
      r2: {
        ...readyState.r2,
        ok: false,
        missing: ["R2_ACCOUNT_ID"],
      },
    });

    const res = await POST(req({ layerId: "11111111-1111-4111-8111-111111111111" }), ctx);
    const body = (await res.json()) as {
      error: string;
      readiness: { ok: boolean; missing: string[] };
    };

    expect(res.status).toBe(503);
    expect(body.error).toContain("R2_ACCOUNT_ID");
    expect(body.readiness.missing).toEqual(["R2_ACCOUNT_ID"]);
    expect(state.rpcCalls).not.toContain("layer_as_geojson");
    expect(mocks.publishGeoJsonAsPmtiles).not.toHaveBeenCalled();
  });

  it("rejects PMTiles-backed source layers", async () => {
    if (state.layer) state.layer.dataset.kind = "pmtiles";
    const res = await POST(req({ layerId: "11111111-1111-4111-8111-111111111111" }), ctx);
    const body = (await res.json()) as { error: string };
    expect(res.status).toBe(400);
    expect(body.error).toContain("already backed by PMTiles");
  });

  it("publishes an existing vector layer and registers the archive", async () => {
    const res = await POST(
      req({
        layerId: "11111111-1111-4111-8111-111111111111",
        projectId: "22222222-2222-4222-8222-222222222222",
        name: "Parcels static",
        sourceLayer: "parcels",
        minzoom: 1,
        maxzoom: 12,
      }),
      ctx,
    );
    const body = (await res.json()) as {
      ok: boolean;
      datasetId: string;
      layer: { id: string; name: string };
      pmtiles: { url: string; sourceLayer: string; bbox: [number, number, number, number] };
    };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.datasetId).toBe("d-published");
    expect(body.layer.id).toBe("l-published");
    expect(body.pmtiles.sourceLayer).toBe("parcels");
    expect(body.pmtiles.bbox).toEqual([-121.1, 39.2, -121.1, 39.2]);
    expect(mocks.publishGeoJsonAsPmtiles).toHaveBeenCalledWith(
      expect.objectContaining({
        featureCollection,
        layerId: "11111111-1111-4111-8111-111111111111",
        name: "Parcels static",
        sourceLayer: "parcels",
        minzoom: 1,
        maxzoom: 12,
      }),
    );
    expect(state.inserts.datasets[0]).toMatchObject({
      project_id: "22222222-2222-4222-8222-222222222222",
      kind: "pmtiles",
      source_uri: "https://assets.example.com/pmtiles/source/parcels.pmtiles",
    });
    expect(state.inserts.layers[0]).toMatchObject({
      dataset_id: "d-published",
      name: "Parcels static",
      geometry_kind: "point",
      feature_count: 1,
      style: { pointColor: "#123456" },
    });
  });

  it("surfaces missing R2 configuration as a service setup error", async () => {
    mocks.publishGeoJsonAsPmtiles.mockRejectedValueOnce(
      new mocks.R2ConfigError(["R2_ACCOUNT_ID"]),
    );
    const res = await POST(req({ layerId: "11111111-1111-4111-8111-111111111111" }), ctx);
    const body = (await res.json()) as { error: string };
    expect(res.status).toBe(503);
    expect(body.error).toContain("R2_ACCOUNT_ID");
  });

  it("surfaces remote generator failures as upstream errors", async () => {
    mocks.publishGeoJsonAsPmtiles.mockRejectedValueOnce(
      new mocks.PmtilesGeneratorError("PMTiles generator failed: 500 boom"),
    );
    const res = await POST(req({ layerId: "11111111-1111-4111-8111-111111111111" }), ctx);
    const body = (await res.json()) as { error: string };
    expect(res.status).toBe(502);
    expect(body.error).toContain("generator failed");
  });
});
