import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  cookies: () => ({ getAll: () => [], set: () => {} }),
}));

vi.mock("@/lib/env", () => ({
  env: () => ({
    NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-stub",
  }),
  flag: {},
}));

const projectId = "11111111-1111-4111-8111-111111111111";
const pmtilesLayerId = "22222222-2222-4222-8222-222222222222";
const vectorLayerId = "33333333-3333-4333-8333-333333333333";

type ProjectDashboardRow = {
  id: string;
  project_id: string;
  name: string;
  layer_id: string;
  metric_kind: "feature_count";
  is_published: boolean;
  schema_version?: number;
  widgets?: unknown;
  updated_at: string;
};

type State = {
  user: { id: string } | null;
  canView: boolean;
  canAdmin: boolean;
  project: { id: string; slug: string };
  datasets: Array<{ id: string; project_id: string; kind: string; source_uri: string | null }>;
  layers: Array<{
    id: string;
    dataset_id: string;
    name: string;
    geometry_kind: string;
    feature_count: number;
    style: Record<string, unknown> | null;
    metadata: Record<string, unknown> | null;
    updated_at: string;
  }>;
  dashboard: ProjectDashboardRow | null;
};

const state: State = {
  user: { id: "u1" },
  canView: true,
  canAdmin: true,
  project: { id: projectId, slug: "alpha" },
  datasets: [],
  layers: [],
  dashboard: null,
};

function resetState() {
  state.user = { id: "u1" };
  state.canView = true;
  state.canAdmin = true;
  state.project = { id: projectId, slug: "alpha" };
  state.datasets = [
    {
      id: "d-pmtiles",
      project_id: projectId,
      kind: "pmtiles",
      source_uri: "https://cdn.example.com/parcels.pmtiles",
    },
    {
      id: "d-vector",
      project_id: projectId,
      kind: "geojson",
      source_uri: null,
    },
  ];
  state.layers = [
    {
      id: pmtilesLayerId,
      dataset_id: "d-pmtiles",
      name: "Hosted parcels",
      geometry_kind: "polygon",
      feature_count: 42,
      style: null,
      metadata: {
        pmtiles: {
          url: "https://cdn.example.com/parcels.pmtiles",
          sourceLayer: "parcels",
          bbox: [-122, 38, -121, 39],
        },
      },
      updated_at: "2026-04-24T00:00:00Z",
    },
    {
      id: vectorLayerId,
      dataset_id: "d-vector",
      name: "Editable parcels",
      geometry_kind: "polygon",
      feature_count: 7,
      style: null,
      metadata: null,
      updated_at: "2026-04-23T00:00:00Z",
    },
  ];
  state.dashboard = null;
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
        if (fn === "has_project_access") {
          return {
            data: args.min_role === "admin" ? state.canAdmin : state.canView,
            error: null,
          };
        }
        throw new Error(`unexpected rpc ${fn}`);
      },
    }),
  }),
}));

function buildFromMock(table: string) {
  const chain = {
    _filters: [] as Array<{ col: string; val: unknown }>,
    _in: null as { col: string; vals: unknown[] } | null,
    _row: null as Record<string, unknown> | null,
    select(_cols: string) {
      return chain;
    },
    eq(col: string, val: unknown) {
      chain._filters.push({ col, val });
      return chain;
    },
    in(col: string, vals: unknown[]) {
      chain._in = { col, vals };
      return chain;
    },
    order(_col: string, _opts?: unknown) {
      return chain;
    },
    limit(_n: number) {
      return chain;
    },
    upsert(row: Record<string, unknown>) {
      chain._row = row;
      state.dashboard = {
        id: state.dashboard?.id ?? "dash1",
        project_id: row.project_id as string,
        name: row.name as string,
        layer_id: row.layer_id as string,
        metric_kind: "feature_count",
        is_published: row.is_published as boolean,
        schema_version: row.schema_version as number,
        widgets: row.widgets,
        updated_at: row.updated_at as string,
      };
      return chain;
    },
    async maybeSingle() {
      if (table === "projects") {
        return matchesFilters(state.project, chain._filters)
          ? { data: state.project, error: null }
          : { data: null, error: null };
      }
      if (table === "project_dashboards") {
        return state.dashboard && matchesFilters(state.dashboard, chain._filters)
          ? { data: state.dashboard, error: null }
          : { data: null, error: null };
      }
      return { data: null, error: null };
    },
    async single() {
      if (table === "project_dashboards") return { data: state.dashboard, error: null };
      return { data: null, error: null };
    },
    then(resolve: (v: { data: unknown[]; error: null }) => void) {
      if (table === "projects") {
        resolve({
          data: matchesFilters(state.project, chain._filters) ? [state.project] : [],
          error: null,
        });
        return;
      }
      if (table === "datasets") {
        resolve({ data: state.datasets.filter((row) => matchesFilters(row, chain._filters)), error: null });
        return;
      }
      if (table === "layers") {
        const rows = state.layers.filter((row) => {
          if (!matchesFilters(row, chain._filters)) return false;
          if (!chain._in) return true;
          return chain._in.vals.includes((row as Record<string, unknown>)[chain._in.col]);
        });
        resolve({ data: rows, error: null });
        return;
      }
      resolve({ data: [], error: null });
    },
  };
  return chain;
}

function matchesFilters(row: object, filters: Array<{ col: string; val: unknown }>) {
  const record = row as Record<string, unknown>;
  return filters.every(({ col, val }) => record[col] === val);
}

const routeMod = await import("@/app/api/projects/[slug]/dashboard/route");

function req(method = "GET", body?: unknown) {
  return new Request(`http://localhost/api/projects/alpha/dashboard?projectId=${projectId}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const ctx = { params: Promise.resolve({ slug: "alpha" }) };

describe("project dashboard route", () => {
  beforeEach(resetState);

  it("401 when unauthenticated", async () => {
    state.user = null;
    const res = await routeMod.GET(req(), ctx);
    expect(res.status).toBe(401);
  });

  it("GET returns the current dashboard and only PMTiles layer choices", async () => {
    state.dashboard = {
      id: "dash1",
      project_id: projectId,
      name: "Parcel dashboard",
      layer_id: pmtilesLayerId,
      metric_kind: "feature_count",
      is_published: true,
      updated_at: "2026-04-24T00:00:00Z",
    };

    const res = await routeMod.GET(req(), ctx);
    const body = (await res.json()) as {
      ok: boolean;
      dashboard: {
        name: string;
        metric: { value: number };
        widgets: unknown[];
      };
      pmtilesLayers: Array<{ id: string; name: string }>;
    };

    expect(res.status).toBe(200);
    expect(body.dashboard.name).toBe("Parcel dashboard");
    expect(body.dashboard.metric.value).toBe(42);
    expect(body.dashboard.widgets).toMatchObject([
      { id: "map", type: "pmtiles_map", layerId: pmtilesLayerId },
      { id: "feature-count", type: "feature_count_chart", layerId: pmtilesLayerId },
    ]);
    expect(body.pmtilesLayers.map((layer) => ({ id: layer.id, name: layer.name }))).toEqual([
      { id: pmtilesLayerId, name: "Hosted parcels" },
    ]);
  });

  it("PUT saves the dashboard for a PMTiles layer", async () => {
    const res = await routeMod.PUT(
      req("PUT", {
        name: "Published parcels",
        layerId: pmtilesLayerId,
        isPublished: true,
        widgets: [
          {
            id: "map",
            type: "pmtiles_map",
            title: "Map",
            layerId: pmtilesLayerId,
          },
          {
            id: "feature-count",
            type: "feature_count_chart",
            title: "Features",
            layerId: pmtilesLayerId,
            display: "bar",
          },
        ],
      }),
      ctx,
    );
    const body = (await res.json()) as {
      ok: boolean;
      dashboard: {
        layerId: string;
        metric: { value: number };
        widgets: Array<{ id: string; display?: string }>;
      };
    };

    expect(res.status).toBe(200);
    expect(body.dashboard.layerId).toBe(pmtilesLayerId);
    expect(body.dashboard.metric.value).toBe(42);
    expect(body.dashboard.widgets[1]).toMatchObject({ id: "feature-count", display: "bar" });
    expect(state.dashboard).toMatchObject({
      project_id: projectId,
      layer_id: pmtilesLayerId,
      name: "Published parcels",
      is_published: true,
      schema_version: 1,
    });
  });

  it("PUT rejects non-PMTiles layers", async () => {
    const res = await routeMod.PUT(
      req("PUT", {
        name: "Bad dashboard",
        layerId: vectorLayerId,
        isPublished: true,
      }),
      ctx,
    );

    expect(res.status).toBe(400);
  });

  it("PUT rejects chart widgets outside the project PMTiles set", async () => {
    const res = await routeMod.PUT(
      req("PUT", {
        name: "Bad dashboard",
        layerId: pmtilesLayerId,
        isPublished: true,
        widgets: [
          {
            id: "map",
            type: "pmtiles_map",
            title: "Map",
            layerId: pmtilesLayerId,
          },
          {
            id: "bad-chart",
            type: "feature_count_chart",
            title: "Other features",
            layerId: vectorLayerId,
            display: "stat",
          },
        ],
      }),
      ctx,
    );

    expect(res.status).toBe(400);
  });

  it("PUT requires project admin access", async () => {
    state.canAdmin = false;
    const res = await routeMod.PUT(
      req("PUT", {
        name: "Published parcels",
        layerId: pmtilesLayerId,
        isPublished: true,
      }),
      ctx,
    );

    expect(res.status).toBe(403);
  });
});
