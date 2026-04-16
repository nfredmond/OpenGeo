import "server-only";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText, Output } from "ai";
import { z } from "zod";
import { env } from "@/lib/env";

const NlSqlSchema = z.object({
  label: z
    .string()
    .max(80)
    .describe("A short human-readable name for the resulting layer."),
  sql: z
    .string()
    .describe(
      "A single PostgreSQL SELECT statement that returns geom (geometry, EPSG:4326) plus optional properties. No INSERT/UPDATE/DELETE/DDL. Do not use semicolons other than the terminator.",
    ),
  rationale: z.string().max(500).describe("Why this query answers the prompt."),
});

export type NlSqlResult = z.infer<typeof NlSqlSchema>;

const SYSTEM = `You translate natural-language spatial questions into a single PostgreSQL SELECT statement against the OpenGeo schema.

Rules:
- Output one SELECT statement. Never INSERT, UPDATE, DELETE, ALTER, CREATE, DROP, TRUNCATE, GRANT, REVOKE, COPY, or VACUUM.
- The statement must return a column named 'geom' (geometry in EPSG:4326). Wrap non-4326 results with ST_Transform(..., 4326).
- Prefer tables in the opengeo schema: opengeo.features, opengeo.layers, opengeo.datasets, opengeo.projects, opengeo.drone_flights, opengeo.orthomosaics.
- When referencing feature attributes, query opengeo.features.properties with ->> or jsonb operators.
- Use ST_DWithin with ::geography for true-distance filters; cast to geography only when needed.
- Limit the result to 10000 rows with LIMIT 10000 unless the question implies a smaller cap.
- If the question cannot be answered with the known schema, return a SELECT that produces zero rows and explain in the rationale.

Schema (abbreviated):
opengeo.features(id uuid, layer_id uuid, geom geometry(Geometry,4326), properties jsonb)
opengeo.layers(id uuid, dataset_id uuid, name text, geometry_kind text, style jsonb, feature_count bigint)
opengeo.datasets(id uuid, project_id uuid, name text, kind text, crs int, bbox geometry, metadata jsonb)
opengeo.projects(id uuid, org_id uuid, name text, site_geom geometry)
opengeo.drone_flights(id uuid, project_id uuid, flown_at timestamptz, site_geom geometry)
opengeo.orthomosaics(id uuid, flight_id uuid, status text, cog_url text, bbox geometry)
`;

export async function nlToSql(prompt: string): Promise<NlSqlResult> {
  const model = anthropic(env().ANTHROPIC_MODEL);
  const { output } = await generateText({
    model,
    output: Output.object({ schema: NlSqlSchema }),
    system: SYSTEM,
    prompt: `User question: ${prompt}\n\nReturn a JSON object matching the provided schema.`,
    temperature: 0,
  });
  return output;
}

// A cheap structural gate before handing the SQL to Postgres.
const FORBIDDEN = [
  /\b(insert|update|delete|alter|create|drop|truncate|grant|revoke|copy|vacuum|call|do|analyze)\b/i,
  /;\s*\S/, // no stacked statements
  /--/, // no inline comments that could hide intent
  /\/\*/, // no block comments either
];

export function validateSql(sql: string): { ok: true } | { ok: false; reason: string } {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  if (!/^\s*(with\b|select\b)/i.test(trimmed)) {
    return { ok: false, reason: "Only SELECT (optionally with CTE) is permitted." };
  }
  for (const pattern of FORBIDDEN) {
    if (pattern.test(trimmed)) {
      return { ok: false, reason: `Rejected pattern: ${pattern}` };
    }
  }
  if (!/\bgeom\b/i.test(trimmed)) {
    return { ok: false, reason: "Query must return a 'geom' column." };
  }
  return { ok: true };
}
