import "server-only";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText, Output } from "ai";
import { z } from "zod";
import { env } from "@/lib/env";

export { validateSql } from "./sql-guard";

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

Working with features.properties (jsonb):
- Property keys are dataset-defined and NOT standardized. Different uploads expose different keys; AI-extracted layers commonly include 'class' (e.g. "building", "road"), 'score', and a bbox-derived 'area_sqm'. Uploaded datasets often expose 'name', 'id', or client-specific keys.
- Realistic extraction examples:
  - filter by type:        WHERE properties->>'class' = 'building'
  - filter by name:        WHERE properties->>'name' ILIKE '%main%'
  - numeric comparison:    WHERE (properties->>'area_sqm')::numeric > 200
  - boolean comparison:    WHERE (properties->>'active')::boolean IS true
- When you are uncertain a key exists on the layer, prefer an existence filter first: WHERE properties ? 'area_sqm'. This lets the query stay valid on layers that happen to not carry the key.
- All jsonb scalars arrive as text. Cast numeric and boolean properties explicitly: (properties->>'foo')::numeric, (properties->>'flag')::boolean. Forgetting the cast produces lexicographic comparisons ('200' < '50') rather than numeric.

Spatial filters and ST_DWithin:
- For true-distance filtering use ST_DWithin with ::geography on BOTH geometries. Distance is in meters when both sides are geography.
- Exemplar — features within 100m of a reference feature:
    SELECT f.geom, f.properties
    FROM opengeo.features f, opengeo.features ref
    WHERE ref.id = '<ref-uuid>'
      AND ST_DWithin(f.geom::geography, ref.geom::geography, 100)
    LIMIT 10000
- Cast to ::geography ONLY for distance filters. Casting to geography in ST_Intersects or other non-distance predicates makes the query index-hostile and can miss the GiST index on geom.
- For bbox / overlap / containment filters stay in geometry space: ST_Intersects(a.geom, b.geom), ST_Contains(a.geom, b.geom), a.geom && b.geom.
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

