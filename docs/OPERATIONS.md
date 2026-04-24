# OpenGeo — Operations Runbook

## Environments

| Env | Purpose | Where |
|---|---|---|
| `local` | Dev against Docker Compose Postgres + Martin + TiTiler + pg_featureserv | `docker compose up -d` + `pnpm dev` |
| `supabase-dev` | Dev against live Supabase project `mqpkycymijjnhesrmmsr`, branch `dev` | `pnpm db:migrate:remote` against `SUPABASE_DB_URL` |
| `preview` | Vercel preview per PR | Auto-deployed by Vercel on push |
| `production` | Vercel production + Supabase prod | `vercel --prod` or Vercel Git promotion |

## First-time setup

```bash
# 1. Install deps.
pnpm install

# 2. Copy env template; ask Nathaniel for real values or pull from Vercel once linked.
cp .env.example .env.local

# 3. Start local stack.
docker compose up -d

# 4. Apply migrations to local DB.
pnpm db:migrate:local

# 5. (Optional) Apply migrations to the live Supabase project.
# Requires SUPABASE_DB_URL set in .env.local.
pnpm db:migrate:remote

# 6. Check environment readiness.
pnpm env:doctor -- --scope=core
# or through the OpenGeo CLI:
pnpm geo doctor --scope=core

# 7. Run the app.
pnpm dev
```

## Vercel linking

Project is linked as of 2026-04-19. `.vercel/project.json` holds `projectId=prj_HzXY4pff59nAgTBOxHF1pyAVZQU9`, `orgId=team_NhbhSJLav3R9laaC7I4vEPrO`. Fresh-clone hydration:

```bash
vercel login                              # interactive (OAuth browser flow)
vercel link --yes --project opengeo       # re-creates .vercel/project.json
vercel env pull .env.local --yes          # hydrates .env.local from Vercel
```

Re-run `vercel env pull` whenever secrets change in the Vercel dashboard. Re-linking note: Vercel's monorepo autodetect scans `services/` during `vercel link` *before* applying `.vercelignore`, so the FastAPI extractor under `services/extractor/` trips the monorepo wizard. Workaround: temporarily rename `services/` → `services.hidden/` for the duration of `vercel link`, then rename back. Python extractor deploys to Modal per ADR-002, not Vercel.

## Deploys

### Env target convention

Set every required var on **both** `preview` and `production` Vercel targets. Vercel's first deploy for a newly linked project auto-promotes to the production alias (`opengeo.vercel.app`) regardless of source branch — a preview-only env set causes runtime `undefined` env reads → HTTP 500 on the public URL.

Three tiers of env vars, set via `vercel env add <KEY> production preview` or the REST API:

**Tier 1 — required for any deploy (preview + production):**
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- `ANTHROPIC_MODEL` (default: `claude-opus-4-7`)
- `OPENGEO_EXTRACTOR=mock`
- All `FEATURE_*` flags (default all to `false` on first deploy — flip on as providers are wired)

**Tier 2 — required for AI features (`FEATURE_AI_NL_SQL`, `FEATURE_AI_STYLE_GEN`):**
- `ANTHROPIC_API_KEY`

**Tier 3 — required for drone pipeline (`FEATURE_DRONE_PIPELINE=true`):**
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_BASE_URL`
- `ODM_API_URL`, `ODM_API_TOKEN`
- `OPENGEO_EXTRACTOR=http`, `OPENGEO_EXTRACTOR_URL`, `OPENGEO_EXTRACTOR_TOKEN` (set after `modal deploy`)

**PMTiles publishing:**
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_BASE_URL`
- `PMTILES_GENERATOR_URL`, `PMTILES_GENERATOR_TOKEN` for production/preview if Tippecanoe runs outside Vercel. Leave `PMTILES_GENERATOR_URL` empty only when the Next.js runtime has a working `TIPPECANOE_BIN`.

Before promoting a preview or production deploy, run the local env audit against
the target surface:

```bash
pnpm env:doctor -- --target=preview --scope=core,pmtiles
pnpm env:doctor -- --target=production --scope=all
# Equivalent CLI form:
pnpm geo doctor --target=preview --scope=core,pmtiles
```

The doctor prints variable names only. It does not print secret values. Use
`--json` when piping the result into another script.

For a hosted production smoke after deploys or bridge recovery, run:

```bash
pnpm hosted:smoke -- --json
```

The hosted smoke creates a temporary Supabase auth user/project, uploads small
GeoJSON and shapefile fixtures, publishes PMTiles, exercises AI query/style,
public share revoke, and flight diff, then cleans up the temporary Supabase,
auth, and R2 objects. It reads secrets from `.env.local` but only prints step
status, timings, and non-secret identifiers.

CI also has a push-to-`main` Vercel env inventory gate. Because Vercel does not
return encrypted/sensitive values through `env pull`, the gate checks required
Production and Preview key presence through the Vercel API without printing or
duplicating provider secrets.

### Supabase Auth redirect URLs

Every Vercel deploy URL that will host magic-link sign-in needs its `/auth/callback` whitelisted. Supabase → Authentication → URL Configuration → Redirect URLs:
- `https://opengeo.vercel.app/auth/callback` (production alias)
- `https://*-natford.vercel.app/auth/callback` (wildcard for preview URLs)
- `http://localhost:3000/auth/callback` (local dev)

Missing entries surface as "invalid redirect URL" on magic-link click. The `uri_allow_list` value on the Supabase project is a comma-separated string (not a JSON array) — use the dashboard or Management API `PATCH /v1/projects/{ref}/config/auth`.

`site_url` must also point at the hosted origin (`https://opengeo.vercel.app`) — otherwise magic-link emails embed `http://localhost:3000` as the `redirect_to` and sign-in round-trips fail in any environment except local dev.

### PostgREST schema exposure

The app reads/writes the `opengeo` schema via `supabase.schema("opengeo")`, not `public`. PostgREST only exposes schemas listed in `db_schema`. On any fresh Supabase project, patch:

```bash
curl -X PATCH "https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF}/postgrest" \
  -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"db_schema":"public,graphql_public,opengeo","db_extra_search_path":"public, extensions, opengeo"}'
```

Missing this surfaces as `"Invalid schema: opengeo"` from PostgREST on `/projects` and every `opengeo.*` route.

### Preview vs production

- **Preview:** every PR (and every push to a non-`main` branch) auto-deploys via Vercel's GitHub integration. URL posted in the deployment summary.
- **Production:** push to `main`, or `vercel --prod` from the linked repo. The first deploy for any newly linked project auto-promotes regardless of target flag — plan for that.

## Supabase linking

```bash
supabase login
supabase link --project-ref mqpkycymijjnhesrmmsr
```

The Supabase MCP endpoint is already documented in `CLAUDE.md` if you want Claude / Codex to query it directly.

## Deploys

- **Preview:** every PR triggers a Vercel preview. Link posted in PR body.
- **Production:** promote a green preview via the Vercel dashboard, or `vercel --prod` from the linked repo. Never push directly to `main` without a PR.
- **Rollbacks:** `vercel rollback <deployment-url>` or promote the prior production deployment from the dashboard.

## Migrations

- Write migrations under `supabase/migrations/` using timestamped filenames (e.g. `20260416120000_init.sql`).
- Forward-only. Never edit a migration after it's merged. Fix with a new migration.
- Every migration is testable against a fresh local container (`pnpm db:reset:local`).
- Migrations that require data backfill run in two steps: the schema change, then a separate backfill script under `scripts/migrations-data/`.

## Secrets

- Local: `.env.local` (gitignored).
- Vercel: set via `vercel env add <KEY>` or the dashboard.
- Rotate on a schedule: Supabase service role key annually, Anthropic API key annually, R2 keys when any team member leaves.

## Observability

- **Web app:** Vercel Observability (request logs, Core Web Vitals, function logs).
- **Postgres:** Supabase dashboard (queries, connections, slow queries).
- **Tiles:** Cloudflare Workers / R2 analytics for edge hits.
- **AI:** every LLM call appends to `ai_events` in Postgres — audit via SQL.

## Alerts (Phase 2 target)

- Supabase CPU > 70% for 5 min.
- 5xx error rate > 1% over 5 min on Vercel production.
- Daily AI spend > configurable cap — email + Slack.
- Martin tile latency p95 > 500 ms for 5 min.

## AI feature extractor (Python service at `services/extractor/`)

A separate FastAPI app that wraps `samgeo.LangSAM` (SAM + GroundingDINO). Invoked via HTTP by the Next.js `HttpExtractor` when `OPENGEO_EXTRACTOR=http`. Contract and internals documented in [`services/extractor/README.md`](../services/extractor/README.md); architecture rationale in [ADR-002](ADR/ADR-002-ai-feature-extractor-infra.md).

**Local dev (CPU):**

```bash
docker compose --profile extractor up -d extractor
# Then in .env.local:
#   OPENGEO_EXTRACTOR=http
#   OPENGEO_EXTRACTOR_URL=http://localhost:8100
#   OPENGEO_EXTRACTOR_TOKEN=
```

CPU inference is slow (3–10 min per tile). Use it to exercise the pipeline, not for real work.

**Smoke-test the extractor end-to-end:**

```bash
pnpm gauntlet --extractor=http     # real Python service at OPENGEO_EXTRACTOR_URL
pnpm gauntlet                      # default = mock extractor (fast; CI baseline)
```

## PMTiles generator service

`POST /api/pmtiles/publish` can run Tippecanoe in-process for local dev, but
production should set `PMTILES_GENERATOR_URL` and run the small container under
`services/pmtiles-generator/` instead. This avoids relying on a native
Tippecanoe binary inside Vercel serverless functions.

```bash
docker compose --profile pmtiles up -d pmtiles_generator

# Then in .env.local:
#   PMTILES_GENERATOR_URL=http://localhost:8110/generate
#   PMTILES_GENERATOR_TOKEN=

pnpm pmtiles:smoke
```

Production should set `PMTILES_GENERATOR_TOKEN` on both the generator service
and Vercel. The generator returns raw `application/vnd.pmtiles` bytes; the
Next.js route still owns R2 upload and project/layer registration.

Authenticated users can check server-side publishing readiness without starting
an export:

```bash
curl -i https://<app-host>/api/pmtiles/publish
```

The response reports missing variable names such as `R2_ACCOUNT_ID` or
`PMTILES_GENERATOR_URL`; it never includes secret values.

Local env checks use the same prerequisite model:

```bash
pnpm env:doctor -- --target=preview --scope=pmtiles
```

The container image is built by `.github/workflows/pmtiles-generator-image.yml`.
Pull requests build the image without publishing it. Pushes to `main` and
manual workflow runs publish GHCR tags under:

```text
ghcr.io/nfredmond/opengeo-pmtiles-generator
```

Use the immutable `sha-<commit>` tag for production. After deploying the
container, set the Vercel environment variables:

```bash
vercel env add PMTILES_GENERATOR_URL production
vercel env add PMTILES_GENERATOR_TOKEN production
vercel env add PMTILES_GENERATOR_URL preview
vercel env add PMTILES_GENERATOR_TOKEN preview
```

For the Phase 2 release-hardening path, deploy the published image to Fly.io
with the checked-in config:

```bash
fly apps create opengeo-pmtiles-generator-natford
fly secrets set PMTILES_GENERATOR_TOKEN="<shared bearer token>" \
  --app opengeo-pmtiles-generator-natford
fly deploy --config services/pmtiles-generator/fly.toml
curl -fsS https://opengeo-pmtiles-generator-natford.fly.dev/health
```

`services/pmtiles-generator/fly.toml` pins
`ghcr.io/nfredmond/opengeo-pmtiles-generator:sha-b61ee31`, listens on port
`8110`, and defaults to Fly region `sjc`. Change `primary_region` before
deployment if the hosted Supabase project is in a better-matched region.

### No-cost PMTiles bridge

When Fly.io is blocked by billing, production can temporarily use a local
Docker generator exposed through a Cloudflare quick tunnel. This is suitable
for demos and smoke tests, not durable production hosting.

```bash
pnpm pmtiles:bridge start
pnpm pmtiles:smoke
pnpm pmtiles:bridge status
```

`start` creates two Docker containers with `restart=unless-stopped`:

- `opengeo-pmtiles-generator-local` on `127.0.0.1:8110`
- `opengeo-pmtiles-tunnel` using `cloudflare/cloudflared:latest`

The current tunnel base URL is written to:

```text
~/.cache/opengeo/pmtiles/tunnel-url.txt
```

If the quick tunnel URL changes, update Vercel and redeploy:

```bash
pnpm pmtiles:bridge repair --update-vercel
vercel deploy --prod -y
```

`status` checks both the local generator `/health` and the public quick tunnel
`/health`; a running Docker container alone is not enough. `start` and
`repair` recreate the tunnel container automatically when the logged
trycloudflare hostname is stale or no longer resolves. Add `--force-recreate`
to replace the tunnel even if the current public health check passes.

The bridge script reads `PMTILES_GENERATOR_TOKEN` from `.env.local` and writes
only to `~/.cache/opengeo/pmtiles/generator.env` with mode `0600`. It does not
print token values. Stop the demo bridge with:

```bash
pnpm pmtiles:bridge stop
```

Cloudflare R2 must be configured before hosted publishing can pass readiness:

- Bucket: `opengeo-assets`
- Public base URL: set as `R2_PUBLIC_BASE_URL`
- API credentials: object write access for this bucket only
- CORS: allow `GET` and `HEAD` from the Vercel app origins and expose range
  response headers for browser tile reads

The `--extractor=http` step POSTs a real `/extract` request with a small public NAIP COG and asserts a non-empty `FeatureCollection` + populated `metrics.model`. Override the COG via `OPENGEO_GAUNTLET_COG_URL`. Expect minutes, not seconds, against the CPU docker extractor.

**Production (Modal):**

```bash
cd services/extractor
modal setup                                     # once per dev machine
modal secret create opengeo-extractor \
  OPENGEO_EXTRACTOR_TOKEN=<token>               # once per environment
modal deploy modal_app.py                       # deploys the GPU function
```

Modal emits a URL. Set it as `OPENGEO_EXTRACTOR_URL` in Vercel, along with `OPENGEO_EXTRACTOR=http` and `OPENGEO_EXTRACTOR_TOKEN=<same token>`. The token is validated by the Python app's bearer middleware.

**Token rotation:** generate a new token (`openssl rand -hex 32`), update the Modal secret and the Vercel env var in lockstep, redeploy both. Old deploys keep working until rotated out.

**Weights:** SAM ViT-H (~2.5GB) and GroundingDINO (~700MB) are hosted on R2 — one-shot bootstrap via `python services/extractor/scripts/sync_weights.py` (requires R2 creds in env). Subsequent Modal image builds pull from R2.

## Known one-time hazards

- The direct Postgres connection string bypasses the Supabase connection pooler. Use it only for migrations and CLI — request-path queries should go through PgBouncer (`?pgbouncer=true&connection_limit=1` in the connection string).
- Supabase project region (check in dashboard) determines where Martin should run. Martin on Fly.io should be co-located with the Supabase region to keep tile latency low.
- Re-applying migrations against a live project is not idempotent unless every migration uses `CREATE ... IF NOT EXISTS`. Always test against a local container first.
- **Schema-prefix every Supabase CRUD call.** `opengeo` tables (`ai_events`, `layers`, `datasets`, `projects`, `project_members`, `project_share_tokens`, etc.) are exposed via PostgREST's `db_schemas=public,graphql_public,opengeo` setting. A schema-less `supabase.from("table")` routes to `public` by default — on hosted Supabase that table doesn't exist and the write silently 404s. `logAiEvent` hit this exact bug pre-2026-04-22 (see commit `8aa2847` on `main`), which left `/review`'s audit log empty even though the app appeared to work. Regression guard in `tests/unit/ai-logger.test.ts` fails if any code path calls `.from()` on the service client without first selecting a schema. Always call `.schema("opengeo")` before `.from(...)` on an opengeo-schema table.

## If production is on fire

1. Check Vercel deployments: is the latest one broken? Roll back.
2. Check Supabase dashboard: DB up? Connections saturated?
3. Check `ai_events` for anomalous LLM activity — a stuck loop can burn a daily budget.
4. Post-mortem within 48h for any customer-visible incident. Template in `docs/POSTMORTEM_TEMPLATE.md` (to be written on first incident).
