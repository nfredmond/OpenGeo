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
