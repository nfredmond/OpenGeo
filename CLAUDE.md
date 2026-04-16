# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status: pre-code planning phase

As of 2026-04-16, this repo contains no source code yet — only planning documents and Supabase provisioning info. Do not assume any framework, directory layout, or tooling exists. Before suggesting commands or scaffolding, confirm with Nathaniel which phase of the build plan (see `Dev planning documents/research.md`) the current task belongs to.

- `Dev planning documents/research.md` — the strategic thesis, competitive analysis, architecture, and phased build plan. Treat this as the source of truth for *what* OpenGeo is and *why* each decision was made.
- `OpenGeo supabase info.md` — contains a **live database password, direct Postgres connection string, and publishable key** for the provisioned Supabase project `mqpkycymijjnhesrmmsr`. These are real credentials checked into the working directory in plaintext. Never paste them into outputs, never commit them to a public remote, and move them into an untracked `.env`/secret store as part of any project scaffolding. Flag this to Nathaniel the first time it comes up.

## What OpenGeo is (and isn't)

**Is:** an AI-native, drone-to-insight geospatial platform — a wedge product at the intersection of urban planning, Part 107 drone operations, and modern web GIS. Positioned as *not* a clone of ArcGIS Online.

**Isn't:** a general-purpose open-source ArcGIS replacement. The research doc establishes that the parity path costs 85–130 FTE-months and has failed repeatedly (GeoNode, MapStore, geOrchestra, Placemark). Scope creep toward "full ArcGIS" is explicitly called out as Failure Mode #2. Push back if a request drifts that direction without a clear reason.

**Core loop (Phase 1 MVP):** upload drone imagery → OpenDroneMap processing → AI feature extraction (SAM / segment-geospatial) → results as editable vector layers on a MapLibre map → natural-language → spatial-SQL querying.

## Target stack (decided, not yet implemented)

When scaffolding, align with the decisions already made in `research.md`:

- **Data plane:** PostGIS + pgvector via Supabase (Pro tier). DuckDB spatial for analytical/columnar workloads against GeoParquet in object storage.
- **Object storage:** Cloudflare R2 (COGs, PMTiles, point clouds, drone imagery).
- **Tile/feature serving:** Martin (Rust) for dynamic vector tiles from PostGIS; PMTiles on R2 for static basemaps; TiTiler for raster/COG; pg_featureserv for OGC API Features.
- **Frontend:** Next.js App Router + MapLibre GL JS (2D) + CesiumJS (3D) + shadcn/ui + Tailwind + Monaco (SQL/style editor).
- **Auth/multi-tenancy:** Supabase Auth + Row Level Security for the hosted product; Keycloak as the enterprise/self-host path (do not wire Keycloak into Phase 1).
- **Type-safe API layer:** Supabase auto-APIs (PostgREST / pg_graphql) + tRPC for custom business logic.
- **AI:** Claude API for NL→SQL, map styling, agentic geoprocessing; segment-geospatial + SAM for feature extraction; Clay Foundation Model embeddings in pgvector for semantic search.
- **Deploy target:** Vercel (Next.js) + Supabase + Cloudflare R2 + Martin on Fly.io. Budget: ~$40/mo to start.
- **License:** AGPL v3 for the open-source core; commercial license for enterprise.

Default to these choices unless explicitly asked to reconsider. If a task implies a different tool (e.g. Mapbox GL JS), flag the deviation rather than silently switching.

## Non-negotiable architecture principles

These come from `research.md` and should shape every code-level decision:

1. **Separate the product plane from the GIS engine plane.** Product shell talks to GeoServer, QGIS Server, Martin, Valhalla, Pelias over HTTP — never library-embedded. This keeps GPL obligations at arm's length and lets engines be swapped. Retrofitting this is painful; enforce it from day one.
2. **Upstream-first on every dependency.** Every private patch to MapLibre / Martin / OpenDroneMap / etc. is a compounding fork tax. Contribute upstream, keep local extensions narrow, document deviations.
3. **Standards-first APIs.** OGC API Features/Tiles/Processes, PMTiles, COG, STAC, GeoParquet by default. GeoServices REST only as a migration-compat layer where it matters.
4. **Git-friendly map definitions.** Map styles (MapLibre JSON), layer configs, dashboard definitions, DB migrations should live as code in the repo and sync via a CLI — this is part of the DX differentiation, not a nice-to-have.
5. **Instant API from schema.** Adding a table with a geometry column should make it available as REST + vector tiles + OGC API Features with zero manual publish step. The Supabase pattern applied to geospatial.
6. **Data-license hygiene.** OSM (ODbL), OpenAddresses (per-source licenses), Natural Earth, NASA/ESA imagery — each has distinct attribution and share-alike obligations. Track provenance, source URLs, timestamps, checksums, and licensing per dataset. This is ongoing operational work, not a one-time legal review.

## Nat Ford Planning context that applies here

OpenGeo is a Nat Ford Planning product. Follow the parent `/home/narford/CLAUDE.md` covenant:

- Truthful, cited, low-fluff output. Label assumptions and limitations.
- Plain-English, client-ready voice. Northern California / Grass Valley / Nevada County / rural RTPAs / tribes / small cities are central reference points — avoid generic big-city SaaS framing when local context matters.
- Responsible AI disclosure: AI-accelerated features (NL→SQL, feature extraction, style generation) should expose provenance so a planner can audit what the model decided.
- Protect disadvantaged and tribal communities in product decisions — don't ship features that shift burden onto them for convenience or optics.

When Nathaniel asks to "start the project" or "scaffold OpenGeo," this qualifies as a **Project Launch** under the parent SOP. Create the charter and doc skeleton (`PROJECT_CHARTER.md`, `docs/ROADMAP.md`, `docs/ARCHITECTURE.md`, `docs/ADR/ADR-001-initial-architecture.md`, `docs/TEST_STRATEGY.md`, `docs/OPERATIONS.md`, `docs/RISK_REGISTER.md`, `docs/CHANGELOG.md`) before writing application code.

## Supabase project reference

- Project ref: `mqpkycymijjnhesrmmsr`
- Project URL: `https://mqpkycymijjnhesrmmsr.supabase.co`
- CLI setup (run from a shell Nathaniel controls, not from tool calls that capture secrets): `supabase login` → `supabase init` → `supabase link --project-ref mqpkycymijjnhesrmmsr`
- Remote MCP endpoint (for Codex/Claude integrations): `https://mcp.supabase.com/mcp?project_ref=mqpkycymijjnhesrmmsr&features=docs,account,database,debugging,development,functions,branching,storage`

Before running migrations, enabling extensions (PostGIS, pgvector), or issuing destructive SQL against this project, confirm with Nathaniel — this is the live project, not a throwaway dev DB.

## What NOT to do here

- Don't scaffold Next.js / Supabase / Martin tooling without being asked — the repo is still at the planning stage.
- Don't commit or echo the Supabase password, connection string, or publishable key found in `OpenGeo supabase info.md`.
- Don't position OpenGeo as a full ArcGIS replacement in any generated copy, README, or marketing material. It's a drone-to-insight wedge.
- Don't pull in Mapbox GL JS, proprietary basemap SDKs, or GPL-embedded libraries in the product shell — MapLibre + HTTP-bounded engines only.
- Don't add StoryMaps, Experience Builder, or Living Atlas clones to the roadmap without an explicit conversation — these are the three largest scope traps identified in the research doc.
