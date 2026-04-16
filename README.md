# OpenGeo

**AI-native drone-to-insight geospatial platform.** Upload drone imagery → process with OpenDroneMap → AI extracts features (buildings, roads, vegetation, damage) → results appear as editable vector layers on a web map → natural-language spatial querying.

Positioned at the intersection of urban planning, Part 107 drone operations, and modern web GIS. Explicitly *not* an open-source clone of ArcGIS Online — see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`Dev planning documents/research.md`](Dev%20planning%20documents/research.md) for the strategic rationale.

## Status

**Phase 1 / scaffolding.** Project launched 2026-04-16. The current milestone is the drone-to-insight MVP loop described in the research doc.

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
| AI | Anthropic Claude (Opus 4.7) via the AI SDK; segment-geospatial for feature extraction |
| Drone pipeline | OpenDroneMap / NodeODM (Phase 1+) |
| Deploy | Vercel (web) + Supabase + Cloudflare R2 + Fly.io (Martin) |
| License | AGPL v3 (core) |

## Quickstart (local)

```bash
# 1. Copy env template and fill in secrets (ask Nathaniel if you don't have them).
cp .env.example .env.local

# 2. Start local Postgres+PostGIS, Martin, TiTiler, pg_featureserv.
docker compose up -d

# 3. Install deps and run migrations against the local DB.
pnpm install
pnpm db:migrate:local

# 4. Start Next.js.
pnpm dev
# → http://localhost:3000
```

Against the live Supabase project, replace step 3 with `pnpm db:migrate:remote` (requires `SUPABASE_DB_URL` and direct network access).

## Project structure

```
.
├── app/                     # Next.js App Router — routes, layouts, server components
├── components/              # React components (UI shell, map, upload, editor)
├── lib/                     # Server/client utilities (supabase, ai, db, maplibre helpers)
├── supabase/
│   ├── migrations/          # SQL migrations run against Postgres
│   └── config.toml          # Supabase CLI config
├── cli/                     # `geo` CLI scaffold (Phase 2 deliverable)
├── docs/                    # Architecture, roadmap, ADRs, operations, risk register
├── docker/                  # Local dev service configs (Martin, TiTiler, pg_featureserv)
├── public/                  # Static assets served by Next.js
├── Dev planning documents/  # Strategic research that informs the build
├── docker-compose.yml       # Local dev stack
├── vercel.ts                # TypeScript Vercel project config
└── CLAUDE.md                # Operating guide for Claude Code
```

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). OpenGeo is AGPLv3 — any hosted/forked version must publish modifications under the same license.

## License

[AGPL-3.0-or-later](LICENSE). Copyright © 2026 Nathaniel Ford Redmond / Nat Ford Planning.
