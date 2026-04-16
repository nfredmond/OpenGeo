# OpenGeo — Roadmap

Derived from the phased plan in `Dev planning documents/research.md`. Dates are indicative; milestones are the commitment.

## Phase 0 — Scaffolding (current)

**Target:** week of 2026-04-16.

- [x] Project charter, roadmap, architecture, ADR-001, risk register.
- [x] `.env.local` + `.gitignore` hygiene; secrets out of git.
- [x] Next.js 16 + TypeScript + Tailwind + shadcn/ui skeleton.
- [x] Supabase migrations: PostGIS + pgvector + org/project/layer schema + RLS.
- [x] Docker Compose: local Postgres+PostGIS, Martin, TiTiler, pg_featureserv.
- [x] `vercel.ts` config stub.
- [x] `geo` CLI stub.
- [ ] CI pipeline (typecheck, lint, unit tests, migration drift check) — *deferred to Phase 1 kickoff.*
- [ ] Public demo deployment — *deferred; first ship to Vercel preview only.*

## Phase 1 — Drone-to-insight MVP (months 1–4)

**Target:** week 16 (2026-08-06).

- [ ] Basic map viewer with layer management and GeoJSON/Shapefile/GeoPackage upload into PostGIS.
- [ ] OpenDroneMap integration: upload drone photos → queue ODM job → output orthomosaic (COG), DSM, point cloud → R2 storage → TiTiler serving.
- [ ] AI feature extraction via segment-geospatial / SAM: user selects area → AI segments buildings, roads, vegetation → saved as PostGIS layers.
- [ ] Natural language → PostGIS SQL (Claude API + schema injection), results rendered on map.
- [ ] AI data cleaning: CRS auto-detect, address geocoding, column-type inference.
- [ ] AI map styling: natural-language → MapLibre style JSON.

**Exit criteria:** A signed-in user flies a site, uploads imagery, receives AI-extracted vector layers, and asks "show me all buildings larger than 200 sqm within 100m of the main road" — and sees the correct result rendered on the map.

## Phase 2 — Platform capabilities (months 5–9)

**Target:** week 36 (2026-12-24).

- [ ] Sharing & permissions model: org → members → projects → layers with RLS.
- [ ] API keys, public share links, preview URLs per project.
- [ ] `geo` CLI: init/dev/deploy/layers/query/style, Docker-backed local dev, git-friendly map definitions.
- [ ] Dashboard builder: map + chart widgets with cross-filtering (Vega-Lite).
- [ ] Change detection between drone flights (orthomosaic diff + highlighted features).
- [ ] Semantic search over imagery tiles and dataset descriptions via pgvector + Clay embeddings.
- [ ] PMTiles hosting for static dataset publishing; fork of Maputnik for style editing.

**Exit criteria:** A consultant can onboard a client, share a project with three collaborators, publish a public PMTiles dashboard, and diff two flights of the same site.

## Phase 3 — Expansion toward platform (months 10–18)

**Target:** week 72 (2027-09-01).

- [ ] 3D scene viewer (CesiumJS): drone-derived 3D meshes, point clouds, terrain.
- [ ] Agentic geoprocessing: LLM agent chains PostGIS operations + external data (FEMA, census) into analysis reports.
- [ ] STAC catalog for imagery management; temporal queries across flights and satellite sources.
- [ ] StoryMaps-lite: scroll-driven narrative maps for project reports.
- [ ] Mobile PWA: camera capture, GPS, offline tile cache, simple field forms.
- [ ] OGC API compliance (Features, Tiles) for government contracts.

**Exit criteria:** First paying government or utility customer running OpenGeo against their own infrastructure; public governance docs (RFC process, release cadence, PSC).

## Explicitly out of scope

Per the "scope creep toward full ArcGIS" risk, the following are **not** on the roadmap and will be declined unless a specific customer commitment shifts the calculus:

- ArcGIS Experience Builder clone (12–18+ FTE-months, no viable solo path).
- StoryMaps-full (6–12 FTE-months; Phase 3 delivers a deliberately simpler scroll-narrative).
- Living Atlas content licensing / curation.
- Proprietary demographic enrichment data.
- Full Field Maps offline sync with conflict resolution (Phase 3+ if ever).
- Generic low-code app builder.

If a prospective customer blocks on any of these, refer them to Esri or a partner.
