# OpenGeo

[![CI](https://github.com/nfredmond/OpenGeo/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/nfredmond/OpenGeo/actions/workflows/ci.yml)

**AI-native drone-to-insight geospatial platform.** Upload drone imagery → process with OpenDroneMap → AI extracts features (buildings, roads, vegetation, damage) → results appear as editable vector layers on a web map → ask questions in plain English and see answers rendered spatially.

A [Nat Ford Planning](https://natford.com) product. AGPLv3 core, commercial license available.

## Who this is for

Northern California RTPAs, small cities, counties, tribes, and under-resourced local agencies — planners who fly a drone on Tuesday and owe a defensible map to a board on Thursday. The product voice is plain-English and client-ready, not generic big-city SaaS. Disadvantaged and tribal communities are first-class reference points for design decisions, not afterthoughts.

## What it is

The core loop (Phase 1 MVP):

1. A signed-in user creates a project.
2. They upload drone imagery or an existing orthomosaic (COG).
3. OpenDroneMap processes the imagery into an orthomosaic + DSM + point cloud.
4. An AI feature extractor (SAM + GroundingDINO via [`services/extractor/`](services/extractor/README.md)) produces vector layers from a natural-language prompt.
5. They ask a spatial question in English; NL→SQL renders the answer on the map with full rationale.
6. They tune the map styling in English; the patch is preview-first with geometry-aware guardrails.
7. Every AI decision is auditable on `/review`.

## What it isn't

**Not an open-source clone of ArcGIS Online.** The parity path is 85–130 FTE-months and has failed repeatedly ([GeoNode](https://geonode.org), [MapStore](https://mapstore.geosolutionsgroup.com), geOrchestra, Placemark). Scope creep toward "full ArcGIS" — StoryMaps, Experience Builder, Living Atlas clones — is explicitly called out as Failure Mode #2 in [`Dev planning documents/research.md`](Dev%20planning%20documents/research.md). OpenGeo is a wedge at drone-to-insight; it stays that way on purpose.

Not a big-city enterprise platform. Not a Mapbox reseller. Not a replacement for QGIS desktop. Not a geoprocessing engine — it talks to engines (GeoServer, Martin, TiTiler, OpenDroneMap, samgeo) over HTTP and swaps them freely.

## Status

**Phase 1 / scaffolding — not production-ready.** Project launched 2026-04-16. See [`docs/ROADMAP.md`](docs/ROADMAP.md) for the full plan and [`docs/CHANGELOG.md`](docs/CHANGELOG.md) for what has actually shipped.

## Stack

| Layer | Choice |
|---|---|
| Frontend | Next.js 16 App Router, React 19, Tailwind, shadcn/ui |
| 2D map | MapLibre GL JS + PMTiles |
| 3D scene | CesiumJS (Phase 2+) |
| API | tRPC + Next.js Route Handlers |
| Auth / DB | Supabase (PostGIS + pgvector + Auth + RLS) |
| Tile serving | Martin (vector) + TiTiler (raster) + pg_featureserv (OGC API Features) |
| Object storage | Cloudflare R2 |
| AI | Anthropic Claude (Opus 4.7) via the AI SDK; samgeo LangSAM for feature extraction |
| Drone pipeline | OpenDroneMap / NodeODM |
| Deploy | Vercel (web) + Supabase + Cloudflare R2 + Fly.io (Martin) + Modal (GPU extractor) |
| License | AGPL v3 (core), commercial available |

## Quickstart (local)

```bash
# 1. Copy env template and fill in secrets (ask Nathaniel if you don't have them).
cp .env.example .env.local

# 2. Start local Postgres+PostGIS, Martin, TiTiler, pg_featureserv.
docker compose up -d

# 3. Install deps, run migrations, seed a demo project.
pnpm install
pnpm db:migrate:local
pnpm db:seed:local

# 4. Start Next.js.
pnpm dev
# → http://localhost:3000
```

Against the live Supabase project, replace step 3 with `pnpm db:migrate:remote` (requires `SUPABASE_DB_URL` and direct network access). Full runbook in [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

The AI feature extractor runs in its own Python service — CPU-only locally via `docker compose --profile extractor up -d extractor`, GPU in production via [Modal](services/extractor/README.md). Without it, `OPENGEO_EXTRACTOR=mock` returns synthetic polygons so the rest of the loop works.

## Docs

- [`PROJECT_CHARTER.md`](PROJECT_CHARTER.md) — problem, users, success criteria, budget, covenant gates.
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — phased plan derived from the research doc.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — component map, plane boundaries, data schema.
- [`docs/ADR/`](docs/ADR/) — architecture decisions (initial stack, extractor infra).
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md) — environments, deploys, migrations, observability, known hazards.
- [`docs/TEST_STRATEGY.md`](docs/TEST_STRATEGY.md) — how correctness is verified.
- [`docs/RISK_REGISTER.md`](docs/RISK_REGISTER.md) — open risks + mitigations.
- [`docs/CHANGELOG.md`](docs/CHANGELOG.md) — what has shipped.
- [`Dev planning documents/research.md`](Dev%20planning%20documents/research.md) — strategic thesis, competitive analysis, why OpenGeo isn't ArcGIS.

## Project structure

```
.
├── app/                     # Next.js App Router — routes, layouts, server components
├── components/              # React components (UI shell, map, upload, editor)
├── lib/                     # Server/client utilities (supabase, ai, db, maplibre helpers)
├── services/extractor/      # Python FastAPI + samgeo LangSAM (deployed to Modal)
├── supabase/
│   ├── migrations/          # SQL migrations run against Postgres
│   └── config.toml          # Supabase CLI config
├── cli/                     # `geo` CLI scaffold (Phase 2 deliverable)
├── docs/                    # Architecture, roadmap, ADRs, operations, risk register
├── docker/                  # Local dev service configs (Postgres image, etc.)
├── public/                  # Static assets served by Next.js
├── Dev planning documents/  # Strategic research that informs the build
├── docker-compose.yml       # Local dev stack
├── vercel.ts                # TypeScript Vercel project config
└── CLAUDE.md                # Operating guide for Claude Code
```

## Covenant

OpenGeo inherits the Nat Ford Planning operating covenant:

- **Truth without spin.** Assumptions, limitations, and AI rationale are surfaced in the UI, not buried. NL→SQL shows its query plan; style patches preview before they apply; every AI call is logged to `ai_events` and visible on `/review`.
- **Fair exchange.** Open core under AGPLv3. Hosted and enterprise tiers exist, but the wedge is reachable by a solo planner on a laptop — not gated behind an enterprise sales cycle.
- **Protect vulnerable communities.** Equity-sensitive data handling is a product feature, not a compliance checkbox. Don't ship something that shifts burden onto disadvantaged or tribal communities for convenience or optics.
- **Responsible AI.** AI accelerates drafting, extraction, and querying. Client-critical conclusions still require human review, and the audit trail makes that review possible.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). OpenGeo is AGPLv3 — any hosted or forked version must publish modifications under the same license. A commercial license is available for organizations that need to build proprietary extensions; contact Nathaniel.

## License

[AGPL-3.0-or-later](LICENSE). Copyright © 2026 Nathaniel Ford Redmond / Nat Ford Planning.
