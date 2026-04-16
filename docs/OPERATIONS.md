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

# 6. Run the app.
pnpm dev
```

## Vercel linking (once ready)

Nathaniel runs this interactively — do not auto-run from an agent session:

```bash
vercel login                              # interactive
vercel link --yes --project opengeo       # creates .vercel/project.json
vercel env pull .env.local --yes          # hydrates .env.local from Vercel
```

After the first link, re-run `vercel env pull` whenever secrets change in the Vercel dashboard.

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

## Known one-time hazards

- The direct Postgres connection string bypasses the Supabase connection pooler. Use it only for migrations and CLI — request-path queries should go through PgBouncer (`?pgbouncer=true&connection_limit=1` in the connection string).
- Supabase project region (check in dashboard) determines where Martin should run. Martin on Fly.io should be co-located with the Supabase region to keep tile latency low.
- Re-applying migrations against a live project is not idempotent unless every migration uses `CREATE ... IF NOT EXISTS`. Always test against a local container first.

## If production is on fire

1. Check Vercel deployments: is the latest one broken? Roll back.
2. Check Supabase dashboard: DB up? Connections saturated?
3. Check `ai_events` for anomalous LLM activity — a stuck loop can burn a daily budget.
4. Post-mortem within 48h for any customer-visible incident. Template in `docs/POSTMORTEM_TEMPLATE.md` (to be written on first incident).
