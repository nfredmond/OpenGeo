# OpenGeo — Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: SemVer once we ship a public release; `0.0.x` during scaffolding.

## [Unreleased]

### Added
- Project launched 2026-04-16.
- `CLAUDE.md` — operating guide for Claude Code in this repo.
- `PROJECT_CHARTER.md` — problem, users, success criteria, budget, covenant gates.
- `docs/ROADMAP.md` — phased plan derived from research.md.
- `docs/ARCHITECTURE.md` — component map, plane boundaries, data schema.
- `docs/ADR/ADR-001-initial-architecture.md` — initial tech stack decision.
- `docs/TEST_STRATEGY.md`, `docs/OPERATIONS.md`, `docs/RISK_REGISTER.md`.
- `CONTRIBUTING.md`, `LICENSE` (AGPL-3.0-or-later).
- Next.js 16 App Router skeleton with TypeScript, Tailwind, shadcn/ui, MapLibre.
- Supabase migrations for PostGIS + pgvector + orgs/projects/layers/drone schema + RLS.
- `docker-compose.yml` for local Postgres + Martin + TiTiler + pg_featureserv.
- `vercel.ts` TypeScript Vercel project config.
- `geo` CLI scaffold with `init`, `dev`, `deploy`, `layers`, `query`, `style` stubs.
- `.gitignore`, `.env.example` with full stack surface area.
- Secret hygiene: Supabase credentials moved out of git-tracked markdown into `.env.local` + `private/`.
- NL→SQL: rationale surfaced in the UI and auto-persisted via `ingest_geojson`.
- AI map styling: natural-language → MapLibre style patch, preview-first, per-geometry allow-list.
- Phase 1 exit gauntlet: `pnpm gauntlet` exercises NL→SQL + NL→style end-to-end.
- AI audit log on `/review`: read-only history of the last 50 AI prompts (nl_sql + nl_style) with rationale and patch hints.
- `/api/ai-events` endpoint with kind filter and `?offset=` pagination; `/review` AI-log tab gets a "Load more" button.
- Local-gauntlet plumbing: custom Postgres image with pgvector; `auth.uid()` stub reading `request.jwt.claim.sub`; tsx `--conditions=react-server` so `server-only` resolves to its empty stub.
- `docs/ADR/ADR-002-ai-feature-extractor-infra.md` — Modal-for-GPU decision, accepted with recorded answers on all four open questions.
- `services/extractor/` — Python FastAPI + samgeo LangSAM service, ready for `modal deploy` (Modal account setup stays with Nathaniel). Includes `Dockerfile.cpu` for local dev, Modal wrapper, R2 weight-sync script, and route/schema tests.
- `HttpExtractor` on the Next.js side. `getExtractor()` dispatches on `OPENGEO_EXTRACTOR={mock,http}`.
- Public GitHub repo: <https://github.com/nfredmond/OpenGeo> (AGPL-v3).
- GitHub Actions CI (lint + typecheck + test) and Dependabot grouped by stack area.
- `tests/unit/http-extractor.test.ts` — CI coverage for the Next.js → Python extractor HTTP contract (POST /extract, bearer auth, error surfacing, custom model label). First unit coverage of the product ↔ engine boundary.
- `pnpm gauntlet --extractor=mock|http` flag. The default stays `mock` so CI stays fast; `http` hits the running Python extractor and asserts a non-empty `FeatureCollection` + populated `metrics.model` against a small public NAIP COG (overridable via `OPENGEO_GAUNTLET_COG_URL`). Satisfies ADR-002 §8.
- Root `README.md` rewrite: covenant statement, explicit "what it isn't" section (not an ArcGIS clone — references research.md Failure Mode #2), "who this is for" framing (NorCal RTPAs, tribes, small cities), docs index, CI badge, `pnpm db:seed:local` in the quickstart.
- Shapefile ingest. `POST /api/datasets/upload` now accepts `multipart/form-data` with a `.zip` containing a `.shp`/`.dbf` triad (+ optional `.shx`/`.prj`/`.cpg`); existing GeoJSON JSON body still works unchanged. `lib/ingest/decode-shapefile.ts` (pure JS via `shapefile` + `jszip`) and `lib/ingest/reproject.ts` (proj4 reprojection to EPSG:4326) handle the transform; the upload route hands the reprojected FeatureCollection to the existing `ingest_geojson` RPC. GeoPackage deferred to Phase 2 — `@ngageoint/geopackage` depends on `better-sqlite3` which is fragile on Vercel serverless.
- AI data-cleaning pass on ingest. `lib/ai/data-cleaning.ts` runs two deterministic classifiers: (1) CRS auto-detect from `.prj` WKT via proj4 (falls back to a lat/lng coord-bounds heuristic when the sidecar is missing); (2) column-type inference over up to 200 features classifying each field as `int | float | date | string | category`. Both decisions append to `ai_events` under new kinds `crs_detect` and `column_type_infer`, visible on `/review`.
- `tests/unit/data-cleaning.test.ts` (13 cases) + `tests/unit/decode-shapefile.test.ts` (4 cases including a shp-write roundtrip).
- `docs/PHASE1_RUNBOOK.md` — end-to-end walkthrough a planner can execute from a fresh clone. Covers sign-in → project → GeoJSON + shapefile upload → ODM → mock-extractor → review → NL→SQL → NL→style → audit log. Explicitly tags each step as `zero external setup` vs. `requires Nathaniel's external account` (Modal, NodeODM, real imagery, Anthropic key, Vercel link) so a reviewer knows what can be walked without provisioning anything.
- Shapefile uploads now work through the map UI. `components/map/upload-panel.tsx` accepts `.zip` files, dispatches to the upload route as `multipart/form-data`, and refetches the finished layer so it renders immediately — previously the client rejected shapefiles with "Shapefile + GeoPackage ship in Phase 1" even though the server route handled them.
- `/review` AI audit log now surfaces the two new ingest-time kinds. `AiEventKind` was widened to include `crs_detect` and `column_type_infer`; filter chips and the card renderer know how to show each kind (EPSG + source for CRS; first six `field: type` pairs for columns). Ingest kinds don't carry a user prompt, so the card falls back to `response_summary`.
