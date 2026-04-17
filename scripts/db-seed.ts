#!/usr/bin/env tsx
/**
 * Seeds the local dev database with a demo org, user, project, uploaded
 * layers, a finished drone flight, and a few extractions in different QA
 * states. Safe to re-run — every insert is idempotent on a natural key.
 *
 * Usage:
 *   pnpm db:seed:local
 *
 * Requires LOCAL_DB_URL in .env.local (pointing at the docker-compose
 * Postgres). Does not touch remote Supabase.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";

const url = process.env.LOCAL_DB_URL;
if (!url) {
  console.error("Missing LOCAL_DB_URL in environment.");
  process.exit(1);
}

const DEMO = {
  orgSlug: "demo",
  orgName: "Nat Ford Planning (demo)",
  userEmail: "demo@opengeo.local",
  projectSlug: "grass-valley-demo",
  projectName: "Grass Valley demo",
  center: [-121.0611, 39.2191] as const, // Grass Valley, CA
};

const client = new Client({ connectionString: url });

async function main() {
  await client.connect();
  console.log("Connected to local Postgres.");

  const userId = await ensureUser(DEMO.userEmail);
  console.log(`user ${DEMO.userEmail} → ${userId}`);

  const orgId = await ensureOrg(DEMO.orgSlug, DEMO.orgName);
  console.log(`org ${DEMO.orgSlug} → ${orgId}`);

  await ensureMembership(orgId, userId, "owner");
  console.log(`membership ${DEMO.userEmail} is owner of ${DEMO.orgSlug}`);

  const projectId = await ensureProject(orgId, DEMO.projectSlug, DEMO.projectName);
  console.log(`project ${DEMO.projectSlug} → ${projectId}`);

  // A real uploaded-looking vector layer (small demo building footprints).
  const buildingsLayerId = await ensureLayerFromFeatures({
    projectId,
    datasetName: "Downtown buildings (seed)",
    layerName: "Downtown buildings",
    geometryKind: "polygon",
    features: syntheticPolygons("building", 8, 0.002),
  });
  console.log(`layer buildings → ${buildingsLayerId}`);

  const parcelsLayerId = await ensureLayerFromFeatures({
    projectId,
    datasetName: "Parcels sample (seed)",
    layerName: "Parcels sample",
    geometryKind: "polygon",
    features: syntheticPolygons("parcel", 5, 0.003, 0.0015),
  });
  console.log(`layer parcels → ${parcelsLayerId}`);

  // A completed drone flight + ready ortho so the map workspace has a raster
  // to render and the extraction flow has something to point at.
  const flightId = await ensureFlight(projectId, "2026-03-15T10:30:00Z", "Empire Mine overflight");
  console.log(`flight → ${flightId}`);

  const orthoId = await ensureOrtho(flightId, "https://example.invalid/demo-ortho.tif");
  console.log(`orthomosaic → ${orthoId}`);

  // Three extraction rows in different QA states so /review is not empty.
  // Each gets its own output layer with synthetic polygons.
  for (const spec of [
    { prompt: "all buildings in frame", qa: "pending", kind: "building" },
    { prompt: "mature trees", qa: "human_reviewed", kind: "tree" },
    { prompt: "parked vehicles", qa: "rejected", kind: "vehicle" },
  ] as const) {
    const layerId = await ensureLayerFromFeatures({
      projectId,
      datasetName: `AI: ${spec.prompt}`,
      layerName: `AI: ${spec.prompt}`,
      geometryKind: "polygon",
      features: syntheticPolygons(spec.kind, 6, 0.0015, 0.0008),
    });
    await ensureExtraction({
      orthoId,
      prompt: spec.prompt,
      qaStatus: spec.qa,
      outputLayerId: layerId,
      createdBy: userId,
    });
    console.log(`extraction "${spec.prompt}" (${spec.qa}) → layer ${layerId}`);
  }

  console.log("Seed complete.");
}

// ---- helpers ----------------------------------------------------------------

async function ensureUser(email: string): Promise<string> {
  const existing = await client.query<{ id: string }>(
    "select id from auth.users where email = $1",
    [email],
  );
  if (existing.rows[0]) return existing.rows[0].id;

  const { rows } = await client.query<{ id: string }>(
    `insert into auth.users (id, email)
     values (gen_random_uuid(), $1)
     returning id`,
    [email],
  );
  return rows[0].id;
}

async function ensureOrg(slug: string, name: string): Promise<string> {
  const existing = await client.query<{ id: string }>(
    "select id from opengeo.orgs where slug = $1",
    [slug],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const { rows } = await client.query<{ id: string }>(
    `insert into opengeo.orgs (slug, name, plan) values ($1, $2, 'pro') returning id`,
    [slug, name],
  );
  return rows[0].id;
}

async function ensureMembership(orgId: string, userId: string, role: string) {
  await client.query(
    `insert into opengeo.members (org_id, user_id, role)
     values ($1, $2, $3)
     on conflict (org_id, user_id) do update set role = excluded.role`,
    [orgId, userId, role],
  );
}

async function ensureProject(orgId: string, slug: string, name: string): Promise<string> {
  const existing = await client.query<{ id: string }>(
    "select id from opengeo.projects where org_id = $1 and slug = $2",
    [orgId, slug],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const { rows } = await client.query<{ id: string }>(
    `insert into opengeo.projects (org_id, slug, name, visibility) values ($1, $2, $3, 'org') returning id`,
    [orgId, slug, name],
  );
  return rows[0].id;
}

async function ensureLayerFromFeatures(input: {
  projectId: string;
  datasetName: string;
  layerName: string;
  geometryKind: "point" | "linestring" | "polygon";
  features: GeoJSON.Feature[];
}): Promise<string> {
  // Idempotency anchor: (project_id, dataset.name, layer.name). If the layer
  // already exists, we assume its features were seeded on a prior run.
  const existing = await client.query<{ layer_id: string }>(
    `select l.id as layer_id
       from opengeo.layers l
       join opengeo.datasets d on d.id = l.dataset_id
      where d.project_id = $1 and d.name = $2 and l.name = $3`,
    [input.projectId, input.datasetName, input.layerName],
  );
  if (existing.rows[0]) return existing.rows[0].layer_id;

  const datasetRes = await client.query<{ id: string }>(
    `insert into opengeo.datasets (project_id, name, kind, crs, license, attribution)
     values ($1, $2, 'geojson', 4326, 'seed-demo', 'OpenGeo demo seed')
     returning id`,
    [input.projectId, input.datasetName],
  );
  const datasetId = datasetRes.rows[0].id;

  const layerRes = await client.query<{ id: string }>(
    `insert into opengeo.layers (dataset_id, name, geometry_kind, feature_count)
     values ($1, $2, $3::opengeo.geometry_kind, $4)
     returning id`,
    [datasetId, input.layerName, input.geometryKind, input.features.length],
  );
  const layerId = layerRes.rows[0].id;

  for (const f of input.features) {
    await client.query(
      `insert into opengeo.features (layer_id, geom, properties)
       values ($1, st_setsrid(st_geomfromgeojson($2), 4326), $3)`,
      [layerId, JSON.stringify(f.geometry), JSON.stringify(f.properties ?? {})],
    );
  }

  return layerId;
}

async function ensureFlight(projectId: string, flownAt: string, note: string): Promise<string> {
  const existing = await client.query<{ id: string }>(
    `select id from opengeo.drone_flights
      where project_id = $1 and flown_at = $2::timestamptz`,
    [projectId, flownAt],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const { rows } = await client.query<{ id: string }>(
    `insert into opengeo.drone_flights (project_id, flown_at, pilot, aircraft, metadata)
     values ($1, $2::timestamptz, 'Demo pilot', 'DJI Mavic 3 (demo)', jsonb_build_object('displayName', $3::text))
     returning id`,
    [projectId, flownAt, note],
  );
  return rows[0].id;
}

async function ensureOrtho(flightId: string, cogUrl: string): Promise<string> {
  const existing = await client.query<{ id: string }>(
    "select id from opengeo.orthomosaics where flight_id = $1 and cog_url = $2",
    [flightId, cogUrl],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const { rows } = await client.query<{ id: string }>(
    `insert into opengeo.orthomosaics (flight_id, status, cog_url, resolution_cm)
     values ($1, 'ready', $2, 3.0)
     returning id`,
    [flightId, cogUrl],
  );
  return rows[0].id;
}

async function ensureExtraction(input: {
  orthoId: string;
  prompt: string;
  qaStatus: "pending" | "ai_ok" | "human_reviewed" | "rejected";
  outputLayerId: string;
  createdBy: string;
}) {
  const existing = await client.query(
    "select id from opengeo.extractions where orthomosaic_id = $1 and prompt = $2",
    [input.orthoId, input.prompt],
  );
  if (existing.rows[0]) return;
  await client.query(
    `insert into opengeo.extractions
       (orthomosaic_id, model, prompt, output_layer_id, qa_status, metrics, created_by)
     values ($1, 'opengeo-mock-extractor-v1', $2, $3, $4::opengeo.extraction_qa,
             jsonb_build_object('featureCount', 6, 'latencyMs', 42), $5)`,
    [input.orthoId, input.prompt, input.outputLayerId, input.qaStatus, input.createdBy],
  );
}

// ---- synthetic geometry -----------------------------------------------------

function syntheticPolygons(
  kind: string,
  count: number,
  spanLng: number,
  spanLat: number = spanLng,
): GeoJSON.Feature[] {
  const [cx, cy] = DEMO.center;
  const out: GeoJSON.Feature[] = [];
  for (let i = 0; i < count; i += 1) {
    const r = pseudoRandom(`${kind}:${i}`);
    const ox = cx + spanLng * (r(0) * 2 - 1) * 4;
    const oy = cy + spanLat * (r(1) * 2 - 1) * 4;
    const wx = spanLng * (0.3 + r(2) * 0.7);
    const wy = spanLat * (0.3 + r(3) * 0.7);
    const ring: [number, number][] = [
      [ox - wx, oy - wy],
      [ox + wx, oy - wy],
      [ox + wx, oy + wy],
      [ox - wx, oy + wy],
      [ox - wx, oy - wy],
    ];
    out.push({
      type: "Feature",
      id: randomUUID(),
      geometry: { type: "Polygon", coordinates: [ring] },
      properties: { kind, index: i, label: `${kind} #${i + 1}` },
    });
  }
  return out;
}

function pseudoRandom(seed: string): (k: number) => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (k: number) => {
    const v = Math.imul(h ^ (k + 0x9e3779b9), 2654435761);
    return (v >>> 0) / 0xffffffff;
  };
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await client.end();
    } catch {}
  });
