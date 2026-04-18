import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Server-only shims so the route module's imports succeed in a Node test env.
vi.mock("next/headers", () => ({
  cookies: () => ({ getAll: () => [], set: () => {} }),
}));

vi.mock("@/lib/env", () => ({
  env: () => ({
    NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-stub",
    SUPABASE_SERVICE_ROLE_KEY: "service-stub",
    ANTHROPIC_MODEL: "claude-opus-4-7",
  }),
  flag: {},
}));

// Skip the Anthropic round-trip. narrateDiff returns a deterministic string.
vi.mock("@/lib/change-detection/narrate", () => ({
  narrateDiff: vi.fn(async () => ({ text: "3 features added.", model: "stub-model" })),
}));

vi.mock("@/lib/ai/logger", () => ({
  logAiEvent: vi.fn(async () => {}),
}));

type LayerRow = {
  id: string;
  name: string;
  dataset: { id: string; project_id: string };
};

type FakeState = {
  user: { id: string } | null;
  layers: Record<string, LayerRow>;
  featureCollections: Record<string, GeoJSON.FeatureCollection>;
  // ingest_geojson behavior: returns layerId or throws with a code.
  ingestResult: { data: string | null; error: { code?: string; message: string } | null };
  // Tracks UPDATE opengeo.layers payloads so we can assert narrative writes.
  layerUpdates: Array<{ id: string; payload: Record<string, unknown> }>;
};

const FROM_ID = "11111111-1111-4111-8111-111111111111";
const TO_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ID = "33333333-3333-4333-8333-333333333333";

const FROM_FC: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      id: "a",
      geometry: { type: "Point", coordinates: [-121.0, 39.1] },
      properties: {},
    },
  ],
};
const TO_FC: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      id: "a",
      geometry: { type: "Point", coordinates: [-121.0, 39.1] },
      properties: {},
    },
    {
      type: "Feature",
      id: "b",
      geometry: { type: "Point", coordinates: [-121.001, 39.101] },
      properties: {},
    },
  ],
};

const state: FakeState = {
  user: { id: "u1" },
  layers: {},
  featureCollections: {},
  ingestResult: { data: "new-layer-id", error: null },
  layerUpdates: [],
};

function resetState() {
  state.user = { id: "u1" };
  state.layers = {
    [FROM_ID]: { id: FROM_ID, name: "Flight A", dataset: { id: "d1", project_id: "p1" } },
    [TO_ID]: { id: TO_ID, name: "Flight B", dataset: { id: "d2", project_id: "p1" } },
    [OTHER_ID]: { id: OTHER_ID, name: "Other", dataset: { id: "d3", project_id: "p2" } },
  };
  state.featureCollections = { [FROM_ID]: FROM_FC, [TO_ID]: TO_FC };
  state.ingestResult = { data: "new-layer-id", error: null };
  state.layerUpdates = [];
}

function buildFromMock(table: string) {
  const chain = {
    _eqId: undefined as string | undefined,
    select(_cols: string) {
      return chain;
    },
    eq(col: string, val: string) {
      if (col === "id") chain._eqId = val;
      return chain;
    },
    async maybeSingle() {
      if (table === "layers") {
        const match = chain._eqId
          ? Object.values(state.layers).find((l) => l.id === chain._eqId)
          : null;
        return { data: match ?? null, error: null };
      }
      return { data: null, error: null };
    },
    update(payload: Record<string, unknown>) {
      return {
        eq(_col: string, id: string) {
          state.layerUpdates.push({ id, payload });
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
  };
  return chain;
}

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => ({
    auth: {
      getUser: async () => ({ data: { user: state.user }, error: null }),
    },
    schema: (_s: string) => ({ from: (t: string) => buildFromMock(t) }),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === "layer_as_geojson") {
        const fc = state.featureCollections[args.p_layer_id as string];
        return {
          data: fc ?? { type: "FeatureCollection", features: [] },
          error: null,
        };
      }
      if (fn === "ingest_geojson") {
        return state.ingestResult;
      }
      throw new Error(`unexpected rpc ${fn}`);
    },
  }),
}));

vi.mock("@/lib/supabase/service", () => ({
  supabaseService: () => ({
    schema: (_s: string) => ({ from: (t: string) => buildFromMock(t) }),
  }),
}));

const routeMod = await import("@/app/api/flights/diff/route");

function req(body: Record<string, unknown>) {
  return new Request("http://localhost/api/flights/diff", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// withRoute handlers want (req, ctx). Our route doesn't use dynamic params,
// but the type requires a ctx, so hand it an empty params promise.
const ctx = { params: Promise.resolve({}) };

describe("POST /api/flights/diff", () => {
  beforeEach(resetState);
  afterEach(resetState);

  it("401 when unauthenticated", async () => {
    state.user = null;
    const res = await routeMod.POST(req({ fromLayerId: FROM_ID, toLayerId: TO_ID }), ctx);
    expect(res.status).toBe(401);
  });

  it("400 when fromLayerId === toLayerId", async () => {
    const res = await routeMod.POST(req({ fromLayerId: FROM_ID, toLayerId: FROM_ID }), ctx);
    expect(res.status).toBe(400);
  });

  it("404 when the caller cannot read a layer", async () => {
    const missing = "44444444-4444-4444-8444-444444444444";
    const res = await routeMod.POST(req({ fromLayerId: missing, toLayerId: TO_ID }), ctx);
    expect(res.status).toBe(404);
  });

  it("400 when the two layers sit in different projects", async () => {
    const res = await routeMod.POST(req({ fromLayerId: FROM_ID, toLayerId: OTHER_ID }), ctx);
    expect(res.status).toBe(400);
  });

  it("400 when either source layer is empty", async () => {
    state.featureCollections[FROM_ID] = { type: "FeatureCollection", features: [] };
    const res = await routeMod.POST(req({ fromLayerId: FROM_ID, toLayerId: TO_ID }), ctx);
    expect(res.status).toBe(400);
  });

  it("200 + expected counts on the happy path", async () => {
    const res = await routeMod.POST(req({ fromLayerId: FROM_ID, toLayerId: TO_ID }), ctx);
    const body = (await res.json()) as {
      ok: boolean;
      layerId: string;
      counts: { added: number; removed: number; modified: number };
      narrative: string | null;
    };
    expect(res.status).toBe(200);
    expect(body.counts).toEqual({ added: 1, removed: 0, modified: 0 });
    expect(body.layerId).toBe("new-layer-id");
    expect(body.narrative).toBe("3 features added.");
    expect(state.layerUpdates).toHaveLength(1);
    expect(state.layerUpdates[0].id).toBe("new-layer-id");
    expect(
      (state.layerUpdates[0].payload.metadata as { change_detection: { narrative: string } })
        .change_detection.narrative,
    ).toBe("3 features added.");
  });

  it("403 when ingest_geojson reports permission denied", async () => {
    state.ingestResult = { data: null, error: { code: "42501", message: "Not authorized" } };
    const res = await routeMod.POST(req({ fromLayerId: FROM_ID, toLayerId: TO_ID }), ctx);
    expect(res.status).toBe(403);
  });

  it("200 with null layerId when nothing changed", async () => {
    state.featureCollections[TO_ID] = FROM_FC;
    const res = await routeMod.POST(req({ fromLayerId: FROM_ID, toLayerId: TO_ID }), ctx);
    const body = (await res.json()) as { ok: boolean; layerId: string | null; narrative: string | null };
    expect(res.status).toBe(200);
    expect(body.layerId).toBeNull();
    expect(body.narrative).toBeNull();
  });
});
