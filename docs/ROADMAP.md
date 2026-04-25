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
- [x] CI pipeline (typecheck, lint, unit tests, migration drift check). *(GitHub Actions — `.github/workflows/ci.yml` — plus Dependabot grouped by stack area.)*
- [x] Vercel preview deployment shipped 2026-04-19 (`opengeo.vercel.app`, project `prj_HzXY4pff59nAgTBOxHF1pyAVZQU9`). Public demo / custom domain deferred to Phase 3 — `.vercel.app` URL is fine for sharing with clients and collaborators until there's a commercial commitment worth a domain.

## Phase 1 — Drone-to-insight MVP (months 1–4)

**Target:** week 16 (2026-08-06). **Shipped 2026-04-18** (well ahead of target — see `docs/PHASE1_RUNBOOK.md` for the end-to-end walkthrough).

- [x] Basic map viewer with layer management and GeoJSON/Shapefile/GeoPackage upload into PostGIS. *(GeoJSON + Shapefile shipped via `POST /api/datasets/upload` + `lib/ingest/decode-shapefile.ts` + `lib/ingest/reproject.ts`. GeoPackage deferred to Phase 2 — `@ngageoint/geopackage` depends on `better-sqlite3`, fragile on Vercel serverless.)*
- [x] OpenDroneMap integration: upload drone photos → queue ODM job → output orthomosaic (COG), DSM, point cloud → R2 storage → TiTiler serving. *(`/api/flights/[id]/odm`, `/api/flights/[id]/orthomosaics`, `/api/orthomosaics/[id]/refresh`.)*
- [x] AI feature extraction via segment-geospatial / SAM: user selects area → AI segments buildings, roads, vegetation → saved as PostGIS layers. *(`services/extractor/` Python FastAPI + samgeo LangSAM, `HttpExtractor` on the Next.js side, dispatched via `OPENGEO_EXTRACTOR={mock,http}`. See `docs/ADR/ADR-002-ai-feature-extractor-infra.md`.)*
- [x] Natural language → PostGIS SQL (Claude API + schema injection), results rendered on map. *(`/api/ai/query`, rationale surfaced in UI, audit trail on `/review`.)*
- [x] AI data cleaning: CRS auto-detect, column-type inference. *(`lib/ai/data-cleaning.ts`; decisions logged under `ai_events` kinds `crs_detect` + `column_type_infer`. Address geocoding pushed to Phase 2+.)*
- [x] AI map styling: natural-language → MapLibre style JSON. *(`/api/layers/[id]/ai-style`, preview-first, per-geometry allow-list.)*

**Exit criteria:** A signed-in user flies a site, uploads imagery, receives AI-extracted vector layers, and asks "show me all buildings larger than 200 sqm within 100m of the main road" — and sees the correct result rendered on the map. *(Met 2026-04-18 via `pnpm gauntlet` covering NL→SQL + NL→style end-to-end. Walked against hosted Supabase 2026-04-19.)*

## Phase 2 — Platform capabilities (months 5–9)

**Target:** week 36 (2026-12-24).

- [x] Sharing & permissions model: org → members → projects → layers with RLS. *(`20260417120100_project_membership.sql` — `project_members`, `project_invitations`, `has_project_access()` helper; widens every RLS SELECT from org-scope to project-scope-or-org-scope.)*
- [x] Public share links — per-project, hashed-at-rest tokens with expiry + revocation. *(`20260417120200_share_tokens.sql`, `/api/share/[token]/*`, `/p/[token]`.)* API keys + preview URLs per project still deferred — scope narrowed to what a client share actually needs.
- [x] Change detection between drone flights — **feature-level (vector-on-vector)**. *(`lib/change-detection/feature-diff.ts`, `POST /api/flights/diff`, Compare-layers panel with AI narration persisted on `layers.metadata`.)* Pixel-level raster diff deferred to Phase 2.5 (needs GDAL/Python services/\* deployment).
- [ ] `geo` CLI: init/dev/deploy/layers/query/style, Docker-backed local dev, git-friendly map definitions. *(`geo doctor` now wraps deploy readiness checks; map-definition workflows remain.)*
- [x] Public PMTiles dashboard MVP: one project PMTiles map layer plus one feature-count metric through the existing public share path. *(`20260425120000_project_dashboards.sql`, `/api/projects/[slug]/dashboard`, `/api/share/[token]/dashboard`, `/p/[token]`.)* Full dashboard builder with chart widgets and cross-filtering remains deferred.
- [ ] Dashboard builder: map + chart widgets with cross-filtering (Vega-Lite).
- [ ] Semantic search over imagery tiles and dataset descriptions via pgvector + Clay embeddings.
- [x] PMTiles hosting for static dataset publishing. *(`POST /api/pmtiles` registers hosted archives; `POST /api/pmtiles/publish` exports PostGIS layers through Tippecanoe, uploads to R2, and rehydrates via MapLibre `pmtiles://` sources. Vercel-safe generation can run through `services/pmtiles-generator`; Maputnik-style editing remains separate.)*

**Exit criteria:** A consultant can onboard a client, share a project with three collaborators, publish a public PMTiles dashboard, and diff two flights of the same site. *(Onboard + share + vector diff shipped 2026-04-18; PMTiles publishing path and the narrow public dashboard MVP are now in place; the full dashboard builder remains.)*

### Operational / security hardening (shipped in-stream)

- [x] Hosted-vs-local parity fix on `resolve_share_token` — pgcrypto lives in `extensions` schema on hosted Supabase, not `public`. Migration `20260419100000_resolve_share_token_extensions_search_path.sql` (commit `dd52f11`).
- [x] `function_search_path_mutable` sweep — every SECURITY DEFINER/INVOKER helper the Supabase advisor flagged now has an explicit `set search_path = public, opengeo` clause. Migration `20260419200000_function_search_path_hardening.sql`. 15 advisor warnings cleared.
- [x] Phase 2 runbook addendum (`P2.1–P2.4`) appended to `docs/PHASE1_RUNBOOK.md` covering invite-by-email, share link mint + incognito verification, flight diff with AI narration, and revoke-with-404 verification.

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
