import { NextResponse } from "next/server";
import { z } from "zod";
import { withRoute } from "@/lib/observability/with-route";
import { parsePmtilesLayerMetadata, type PmtilesLayerMetadata } from "@/lib/pmtiles";
import { supabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/),
});

const DashboardBody = z.object({
  name: z.string().trim().min(1).max(120),
  layerId: z.string().uuid(),
  isPublished: z.boolean().default(true),
});

type ProjectLookup = { id: string; slug: string };
type MemberRole = "viewer" | "admin";

type DatasetRow = {
  id: string;
  kind: string | null;
  source_uri: string | null;
};

type LayerRow = {
  id: string;
  dataset_id: string;
  name: string;
  geometry_kind: string;
  feature_count: number | string | null;
  style: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  updated_at: string;
};

type DashboardRow = {
  id: string;
  project_id: string;
  name: string;
  layer_id: string;
  metric_kind: "feature_count";
  is_published: boolean;
  updated_at: string;
};

type DashboardLayer = {
  id: string;
  name: string;
  geometryKind: string;
  featureCount: number;
  style: Record<string, unknown> | null;
  pmtiles: PmtilesLayerMetadata;
};

class AmbiguousProjectError extends Error {}

export const GET = withRoute<{ slug: string }>(
  "projects.dashboard.get",
  async (req, ctx) => {
    const resolved = await resolveRequestProject(req, ctx);
    if ("response" in resolved) return resolved.response;

    const { supabase, project } = resolved;
    if (!(await hasProjectAccess(supabase, project.id, "viewer"))) {
      return NextResponse.json({ ok: false, error: "Forbidden." }, { status: 403 });
    }

    const payload = await loadDashboardPayload(supabase, project.id);
    if ("response" in payload) return payload.response;

    return NextResponse.json({ ok: true, ...payload });
  },
);

export const PUT = withRoute<{ slug: string }>(
  "projects.dashboard.save",
  async (req, ctx) => {
    const resolved = await resolveRequestProject(req, ctx);
    if ("response" in resolved) return resolved.response;

    const { supabase, project, userId } = resolved;
    if (!(await hasProjectAccess(supabase, project.id, "admin"))) {
      return NextResponse.json({ ok: false, error: "Forbidden." }, { status: 403 });
    }

    const parsed = DashboardBody.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "Invalid request body.", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const layers = await loadProjectPmtilesLayers(supabase, project.id);
    if ("response" in layers) return layers.response;

    const selected = layers.pmtilesLayers.find((layer) => layer.id === parsed.data.layerId);
    if (!selected) {
      return NextResponse.json(
        { ok: false, error: "Dashboard layer must be a PMTiles layer in this project." },
        { status: 400 },
      );
    }

    const { data: row, error } = await supabase
      .schema("opengeo")
      .from("project_dashboards")
      .upsert(
        {
          project_id: project.id,
          name: parsed.data.name,
          layer_id: selected.id,
          metric_kind: "feature_count",
          is_published: parsed.data.isPublished,
          created_by: userId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "project_id" },
      )
      .select("id, project_id, name, layer_id, metric_kind, is_published, updated_at")
      .single();

    if (error) {
      const status = error.code === "42501" ? 403 : 400;
      return NextResponse.json({ ok: false, error: error.message }, { status });
    }

    return NextResponse.json({
      ok: true,
      dashboard: buildDashboard(row as DashboardRow, selected),
      pmtilesLayers: layers.pmtilesLayers,
    });
  },
);

async function resolveRequestProject(
  req: Request,
  ctx: { params: Promise<{ slug: string }> },
): Promise<
  | {
      supabase: Awaited<ReturnType<typeof supabaseServer>>;
      project: ProjectLookup;
      userId: string;
    }
  | { response: NextResponse }
> {
  const rawParams = await ctx.params;
  const parsedParams = ParamsSchema.safeParse(rawParams);
  if (!parsedParams.success) {
    return { response: NextResponse.json({ ok: false, error: "Invalid project slug." }, { status: 400 }) };
  }

  const supabase = await supabaseServer();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    return { response: NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 }) };
  }

  const projectId = new URL(req.url).searchParams.get("projectId");
  if (projectId && !z.string().uuid().safeParse(projectId).success) {
    return { response: NextResponse.json({ ok: false, error: "Invalid project id." }, { status: 400 }) };
  }

  let project: ProjectLookup | null;
  try {
    project = await resolveProject(supabase, parsedParams.data.slug, projectId);
  } catch (e) {
    if (e instanceof AmbiguousProjectError) {
      return { response: NextResponse.json({ ok: false, error: e.message }, { status: 409 }) };
    }
    throw e;
  }
  if (!project) {
    return { response: NextResponse.json({ ok: false, error: "Project not found." }, { status: 404 }) };
  }

  return { supabase, project, userId: userData.user.id };
}

async function resolveProject(
  supabase: Awaited<ReturnType<typeof supabaseServer>>,
  slug: string,
  projectId?: string | null,
): Promise<ProjectLookup | null> {
  let query = supabase.schema("opengeo").from("projects").select("id, slug");
  if (projectId) {
    query = query.eq("id", projectId).eq("slug", slug);
    const { data, error } = await query.maybeSingle();
    if (error) throw new Error(error.message);
    return (data as ProjectLookup | null) ?? null;
  }

  const { data, error } = await query.eq("slug", slug).limit(2);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as ProjectLookup[];
  if (rows.length > 1) {
    throw new AmbiguousProjectError(
      "Project slug is ambiguous. Open the project from the Projects list.",
    );
  }
  return rows[0] ?? null;
}

async function hasProjectAccess(
  supabase: Awaited<ReturnType<typeof supabaseServer>>,
  projectId: string,
  role: MemberRole,
): Promise<boolean> {
  const { data, error } = await supabase
    .schema("opengeo")
    .rpc("has_project_access", { target_project: projectId, min_role: role });
  if (error) throw new Error(error.message);
  return data === true;
}

async function loadDashboardPayload(
  supabase: Awaited<ReturnType<typeof supabaseServer>>,
  projectId: string,
): Promise<
  | {
      dashboard: ReturnType<typeof buildDashboard> | null;
      pmtilesLayers: DashboardLayer[];
    }
  | { response: NextResponse }
> {
  const layers = await loadProjectPmtilesLayers(supabase, projectId);
  if ("response" in layers) return layers;

  const { data: row, error } = await supabase
    .schema("opengeo")
    .from("project_dashboards")
    .select("id, project_id, name, layer_id, metric_kind, is_published, updated_at")
    .eq("project_id", projectId)
    .maybeSingle();

  if (error) {
    return { response: NextResponse.json({ ok: false, error: error.message }, { status: 500 }) };
  }

  const dashboardRow = row as DashboardRow | null;
  const selected = dashboardRow
    ? layers.pmtilesLayers.find((layer) => layer.id === dashboardRow.layer_id)
    : null;

  return {
    dashboard: dashboardRow && selected ? buildDashboard(dashboardRow, selected) : null,
    pmtilesLayers: layers.pmtilesLayers,
  };
}

async function loadProjectPmtilesLayers(
  supabase: Awaited<ReturnType<typeof supabaseServer>>,
  projectId: string,
): Promise<{ pmtilesLayers: DashboardLayer[] } | { response: NextResponse }> {
  const { data: datasets, error: dsErr } = await supabase
    .schema("opengeo")
    .from("datasets")
    .select("id, kind, source_uri")
    .eq("project_id", projectId);

  if (dsErr) {
    return { response: NextResponse.json({ ok: false, error: dsErr.message }, { status: 500 }) };
  }

  const datasetRows = (datasets ?? []) as DatasetRow[];
  const datasetById = new Map(datasetRows.map((dataset) => [dataset.id, dataset]));
  const datasetIds = datasetRows.map((dataset) => dataset.id);
  if (datasetIds.length === 0) return { pmtilesLayers: [] };

  const { data: layerRows, error: layerErr } = await supabase
    .schema("opengeo")
    .from("layers")
    .select("id, dataset_id, name, geometry_kind, feature_count, style, metadata, updated_at")
    .in("dataset_id", datasetIds)
    .order("updated_at", { ascending: false });

  if (layerErr) {
    return { response: NextResponse.json({ ok: false, error: layerErr.message }, { status: 500 }) };
  }

  const pmtilesLayers: DashboardLayer[] = [];
  for (const layer of (layerRows ?? []) as LayerRow[]) {
    const dataset = datasetById.get(layer.dataset_id);
    if (dataset?.kind !== "pmtiles") continue;
    const pmtiles = parsePmtilesLayerMetadata(layer.metadata, dataset.source_uri);
    if (!pmtiles) continue;
    pmtilesLayers.push({
      id: layer.id,
      name: layer.name,
      geometryKind: layer.geometry_kind,
      featureCount: Number(layer.feature_count ?? 0),
      style: layer.style,
      pmtiles,
    });
  }

  return { pmtilesLayers };
}

function buildDashboard(row: DashboardRow, layer: DashboardLayer) {
  return {
    id: row.id,
    name: row.name,
    isPublished: row.is_published,
    layerId: layer.id,
    layerName: layer.name,
    updatedAt: row.updated_at,
    metric: {
      kind: row.metric_kind,
      label: "Features",
      value: layer.featureCount,
    },
    layer,
  };
}
