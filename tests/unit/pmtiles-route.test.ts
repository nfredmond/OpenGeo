import { beforeEach, describe, expect, it, vi } from "vitest";

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

type State = {
  user: { id: string } | null;
  rpcProjectId: string | null;
  inserts: Record<string, Array<Record<string, unknown>>>;
  insertErrors: Record<string, { code?: string; message: string } | null>;
};

const state: State = {
  user: { id: "u1" },
  rpcProjectId: "p1",
  inserts: { datasets: [], layers: [] },
  insertErrors: { datasets: null, layers: null },
};

function resetState() {
  state.user = { id: "u1" };
  state.rpcProjectId = "p1";
  state.inserts = { datasets: [], layers: [] };
  state.insertErrors = { datasets: null, layers: null };
}

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => ({
    auth: {
      getUser: async () => ({ data: { user: state.user }, error: null }),
    },
    schema: (schemaName: string) => ({
      from: (table: string) => buildFromMock(table),
      rpc: async (fn: string, args: Record<string, unknown>) => {
        if (schemaName !== "opengeo") throw new Error(`unexpected schema ${schemaName}`);
        if (fn === "default_project_for") {
          expect(args.p_user_id).toBe("u1");
          return { data: state.rpcProjectId, error: null };
        }
        throw new Error(`unexpected rpc ${fn}`);
      },
    }),
  }),
}));

function buildFromMock(table: string) {
  const chain = {
    _row: null as Record<string, unknown> | null,
    insert(row: Record<string, unknown>) {
      chain._row = row;
      state.inserts[table] ??= [];
      state.inserts[table].push(row);
      return chain;
    },
    select(_cols: string) {
      return chain;
    },
    async single() {
      const error = state.insertErrors[table];
      if (error) return { data: null, error };
      if (table === "datasets") return { data: { id: "d1" }, error: null };
      if (table === "layers") {
        return {
          data: {
            id: "l1",
            name: chain._row?.name,
            geometry_kind: chain._row?.geometry_kind,
            feature_count: chain._row?.feature_count,
            style: {},
            metadata: chain._row?.metadata,
          },
          error: null,
        };
      }
      return { data: null, error: null };
    },
  };
  return chain;
}

const { POST } = await import("@/app/api/pmtiles/route");

function req(body: unknown) {
  return new Request("http://localhost/api/pmtiles", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ctx = { params: Promise.resolve({}) };

describe("POST /api/pmtiles", () => {
  beforeEach(resetState);

  it("401 when unauthenticated", async () => {
    state.user = null;
    const res = await POST(req({}), ctx);
    expect(res.status).toBe(401);
  });

  it("400 when the URL is not a PMTiles archive", async () => {
    const res = await POST(
      req({
        projectId: "11111111-1111-4111-8111-111111111111",
        name: "Bad",
        url: "https://example.com/not-a-tile.txt",
      }),
      ctx,
    );
    const body = (await res.json()) as { error: string };
    expect(res.status).toBe(400);
    expect(body.error).toContain(".pmtiles");
  });

  it("registers a hosted PMTiles archive as a dataset and layer", async () => {
    const res = await POST(
      req({
        projectId: "11111111-1111-4111-8111-111111111111",
        name: "Published parcels",
        url: "https://cdn.example.com/parcels.pmtiles",
        sourceLayer: "parcels",
        geometryKind: "polygon",
        featureCount: 42,
      }),
      ctx,
    );
    const body = (await res.json()) as {
      ok: boolean;
      datasetId: string;
      layer: { id: string; name: string };
      pmtiles: { url: string; sourceLayer: string };
    };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.datasetId).toBe("d1");
    expect(body.layer.id).toBe("l1");
    expect(state.inserts.datasets[0]).toMatchObject({
      project_id: "11111111-1111-4111-8111-111111111111",
      name: "Published parcels",
      kind: "pmtiles",
      source_uri: "https://cdn.example.com/parcels.pmtiles",
    });
    expect(state.inserts.layers[0]).toMatchObject({
      dataset_id: "d1",
      name: "Published parcels",
      geometry_kind: "polygon",
      feature_count: 42,
    });
    expect(body.pmtiles.sourceLayer).toBe("parcels");
  });

  it("uses default_project_for when projectId is omitted", async () => {
    const res = await POST(
      req({
        name: "Default project archive",
        url: "https://cdn.example.com/default.pmtiles",
      }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(state.inserts.datasets[0].project_id).toBe("p1");
  });
});
