import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock Next.js server-only APIs that the route pulls through supabaseServer.
vi.mock("next/headers", () => ({
  cookies: () => ({
    getAll: () => [],
    set: () => {},
  }),
}));

vi.mock("@/lib/env", () => ({
  env: () => ({
    NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-stub",
    SUPABASE_SERVICE_ROLE_KEY: "service-stub",
  }),
  flag: {},
}));

type TokenState = {
  // Maps full token string → { projectId, scopes } OR undefined if invalid.
  resolvedProject: Record<string, { projectId: string; scopes: string[] } | undefined>;
  // Admin-side data the routes walk to produce their response.
  project: { id: string; slug: string; name: string; org_id: string; visibility: string };
  org: { id: string; slug: string; name: string };
  datasets: Array<{ id: string; project_id: string }>;
  layers: Array<{
    id: string;
    dataset_id: string;
    name: string;
    geometry_kind: string;
    feature_count: number;
    style: Record<string, unknown> | null;
    updated_at: string;
  }>;
  flights: Array<{ id: string; project_id: string }>;
  orthomosaics: Array<{
    id: string;
    flight_id: string;
    status: string;
    cog_url: string | null;
    created_at: string;
  }>;
  shareTokenRow: { expires_at: string | null; scopes: string[] } | null;
  featureCollectionById: Record<string, GeoJSON.FeatureCollection>;
};

const state: TokenState = {
  resolvedProject: {},
  project: { id: "p1", slug: "alpha", name: "Alpha", org_id: "o1", visibility: "private" },
  org: { id: "o1", slug: "alpha-org", name: "Alpha Org" },
  datasets: [{ id: "d1", project_id: "p1" }],
  layers: [
    {
      id: "l1",
      dataset_id: "d1",
      name: "Parcels",
      geometry_kind: "polygon",
      feature_count: 3,
      style: null,
      updated_at: "2026-04-17T00:00:00Z",
    },
  ],
  flights: [{ id: "f1", project_id: "p1" }],
  orthomosaics: [
    {
      id: "o1",
      flight_id: "f1",
      status: "ready",
      cog_url: "https://example.com/ortho.tif",
      created_at: "2026-04-17T00:00:00Z",
    },
  ],
  shareTokenRow: {
    expires_at: null,
    scopes: ["read:layers", "read:orthomosaics"],
  },
  featureCollectionById: {
    l1: { type: "FeatureCollection", features: [] },
  },
};

function resetState() {
  state.resolvedProject = {};
  state.shareTokenRow = { expires_at: null, scopes: ["read:layers", "read:orthomosaics"] };
}

vi.mock("@/lib/supabase/service", () => ({
  supabaseService: () => ({
    schema: (_schemaName: string) => ({
      from: (table: string) => buildFromMock(table),
      rpc: async (fn: string, args: Record<string, unknown>) => {
        if (fn === "resolve_share_token") {
          const match = state.resolvedProject[args.p_token as string];
          return { data: match ? match.projectId : null, error: null };
        }
        throw new Error(`unexpected rpc ${fn}`);
      },
    }),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === "layer_as_geojson") {
        const fc = state.featureCollectionById[args.p_layer_id as string];
        return { data: fc ?? { type: "FeatureCollection", features: [] }, error: null };
      }
      throw new Error(`unexpected rpc ${fn}`);
    },
  }),
}));

function buildFromMock(table: string) {
  const chain = {
    _filters: [] as Array<{ col: string; val: unknown }>,
    _is: [] as Array<{ col: string; val: unknown }>,
    select(_cols: string) {
      return chain;
    },
    eq(col: string, val: unknown) {
      chain._filters.push({ col, val });
      return chain;
    },
    in(_col: string, _vals: unknown[]) {
      return chain;
    },
    is(col: string, val: unknown) {
      chain._is.push({ col, val });
      return chain;
    },
    order(_col: string, _opts?: unknown) {
      return chain;
    },
    limit(_n: number) {
      return chain;
    },
    async maybeSingle() {
      if (table === "projects") {
        return { data: state.project, error: null };
      }
      if (table === "orgs") {
        return { data: state.org, error: null };
      }
      if (table === "project_share_tokens") {
        return { data: state.shareTokenRow, error: null };
      }
      return { data: null, error: null };
    },
    async single() {
      if (table === "projects") return { data: state.project, error: null };
      return { data: null, error: null };
    },
    then(resolve: (v: { data: unknown[]; error: null }) => void) {
      if (table === "datasets") {
        resolve({ data: state.datasets, error: null });
        return;
      }
      if (table === "layers") {
        resolve({ data: state.layers, error: null });
        return;
      }
      if (table === "drone_flights") {
        resolve({ data: state.flights, error: null });
        return;
      }
      if (table === "orthomosaics") {
        resolve({ data: state.orthomosaics, error: null });
        return;
      }
      resolve({ data: [], error: null });
    },
  };
  return chain;
}

const projectRouteMod = await import("@/app/api/share/[token]/project/route");
const layersRouteMod = await import("@/app/api/share/[token]/layers/route");
const orthoRouteMod = await import("@/app/api/share/[token]/orthomosaics/route");

describe("GET /api/share/[token]/*", () => {
  beforeEach(resetState);
  afterEach(resetState);

  function ctx(token: string) {
    return { params: Promise.resolve({ token }) };
  }

  function req(token: string) {
    return new Request(`http://localhost/api/share/${token}/project`);
  }

  it("project: 404 when the token does not resolve", async () => {
    const res = await projectRouteMod.GET(req("garbage-token-xx"), ctx("garbage-token-xx"));
    expect(res.status).toBe(404);
  });

  it("project: 404 when the token is too short", async () => {
    const res = await projectRouteMod.GET(req("short"), ctx("short"));
    expect(res.status).toBe(404);
  });

  it("project: returns metadata when the token resolves", async () => {
    state.resolvedProject["good-token.abcdefgh"] = {
      projectId: "p1",
      scopes: ["read:layers", "read:orthomosaics"],
    };
    const res = await projectRouteMod.GET(
      req("good-token.abcdefgh"),
      ctx("good-token.abcdefgh"),
    );
    const body = (await res.json()) as {
      ok: boolean;
      project: { id: string; slug: string; name: string };
      org: { slug: string; name: string } | null;
      scopes: string[];
    };
    expect(res.status).toBe(200);
    expect(body.project.slug).toBe("alpha");
    expect(body.org?.name).toBe("Alpha Org");
    expect(body.scopes).toContain("read:layers");
  });

  it("layers: 404 when the token is unknown", async () => {
    const res = await layersRouteMod.GET(req("nope-token.xx"), ctx("nope-token.xx"));
    expect(res.status).toBe(404);
  });

  it("layers: 404 when the token lacks read:layers scope", async () => {
    state.resolvedProject["limited-token.xx"] = {
      projectId: "p1",
      scopes: ["read:orthomosaics"],
    };
    state.shareTokenRow = { expires_at: null, scopes: ["read:orthomosaics"] };
    const res = await layersRouteMod.GET(req("limited-token.xx"), ctx("limited-token.xx"));
    expect(res.status).toBe(404);
  });

  it("layers: returns layers + feature collections for a valid token", async () => {
    state.resolvedProject["good-token.abcdefgh"] = {
      projectId: "p1",
      scopes: ["read:layers", "read:orthomosaics"],
    };
    const res = await layersRouteMod.GET(
      req("good-token.abcdefgh"),
      ctx("good-token.abcdefgh"),
    );
    const body = (await res.json()) as {
      ok: boolean;
      layers: Array<{
        id: string;
        name: string;
        featureCollection: GeoJSON.FeatureCollection;
      }>;
    };
    expect(res.status).toBe(200);
    expect(body.layers).toHaveLength(1);
    expect(body.layers[0].name).toBe("Parcels");
    expect(body.layers[0].featureCollection.type).toBe("FeatureCollection");
  });

  it("orthomosaics: 404 when the token lacks read:orthomosaics scope", async () => {
    state.resolvedProject["limited-token.xx"] = {
      projectId: "p1",
      scopes: ["read:layers"],
    };
    state.shareTokenRow = { expires_at: null, scopes: ["read:layers"] };
    const res = await orthoRouteMod.GET(req("limited-token.xx"), ctx("limited-token.xx"));
    expect(res.status).toBe(404);
  });

  it("orthomosaics: returns ready COG URLs for a valid token", async () => {
    state.resolvedProject["good-token.abcdefgh"] = {
      projectId: "p1",
      scopes: ["read:layers", "read:orthomosaics"],
    };
    const res = await orthoRouteMod.GET(
      req("good-token.abcdefgh"),
      ctx("good-token.abcdefgh"),
    );
    const body = (await res.json()) as {
      ok: boolean;
      orthomosaics: Array<{ id: string; cogUrl: string | null }>;
    };
    expect(res.status).toBe(200);
    expect(body.orthomosaics).toHaveLength(1);
    expect(body.orthomosaics[0].cogUrl).toBe("https://example.com/ortho.tif");
  });
});
