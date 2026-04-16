# OpenGeo — Architecture

The north star: **product plane and GIS engine plane are separate.** Everything between them crosses an HTTP boundary. This keeps GPL-family components at arm's length, lets engines be swapped without rewriting the product, and avoids the tight-coupling failure pattern observed in GeoNode / MapStore / geOrchestra.

## Component map

```
┌──────────────────────────────────────────────────────────────────────┐
│                          Browser (MapLibre, React)                    │
└──────────────────┬───────────────────────────────────┬────────────────┘
                   │ HTTPS                              │ vector tiles (MVT)
                   ▼                                    ▼
┌──────────────────────────────────────┐   ┌─────────────────────────┐
│   Next.js (App Router, Vercel)       │   │   Martin (Fly.io)       │
│   - Server Components                │   │   Rust vector tile srv  │
│   - Route Handlers (REST)            │   │   Reads PostGIS         │
│   - tRPC (typed RPC)                 │   └──────────┬──────────────┘
│   - AI SDK (Claude)                  │              │
│   - Supabase SSR client              │              │
└──────┬───────────────────────────────┘              │
       │ SQL (pooled)                                  │ SQL
       ▼                                               ▼
┌──────────────────────────────────────────────────────────────────┐
│        Postgres 15 + PostGIS + pgvector (Supabase managed)        │
│  - orgs / members / projects / api_keys  (control plane)          │
│  - datasets / layers / features           (data plane)            │
│  - drone_flights / orthomosaics           (imagery metadata)      │
│  - embeddings                              (pgvector)             │
│  - RLS policies for multi-tenant isolation                        │
└──────────────────────────────────────────────────────────────────┘
       │                                               │
       │                                               │
┌──────▼────────────┐                      ┌──────────▼───────────┐
│  TiTiler          │                      │  pg_featureserv       │
│  COG raster tiles │                      │  OGC API Features     │
└──────┬────────────┘                      └───────────────────────┘
       │
┌──────▼────────────────────────────────────────────────────────────┐
│                       Cloudflare R2 (object storage)               │
│   - COGs (orthomosaics, DSMs)                                      │
│   - PMTiles (static basemaps, published datasets)                  │
│   - LAZ/COPC (point clouds)                                        │
│   - Raw drone image uploads                                        │
└───────────────────────────────────────────────────────────────────┘
       ▲
       │
┌──────┴────────────────────────────────────────────────────────────┐
│                    OpenDroneMap / NodeODM (Phase 1+)               │
│   Photogrammetry: imagery → orthomosaic, DSM, DTM, point cloud    │
└───────────────────────────────────────────────────────────────────┘
```

## Plane boundaries

### Product plane
Everything the user sees or a tenant owns: the Next.js app, React components, API routes, tRPC procedures, Supabase auth, RLS policies, AI orchestration, CLI, dashboards.

**Goal:** this is where the commercial value is — UX, workflow, AI features, multi-tenant controls. It is *our* code, licensed AGPLv3 (core) or commercial (enterprise edition).

### GIS engine plane
Off-the-shelf services that do one thing well: Martin (vector tiles), TiTiler (raster tiles), pg_featureserv (OGC API Features), Valhalla / Pelias (future: routing, geocoding), Keycloak (future: enterprise auth), OpenDroneMap (photogrammetry).

**Goal:** do not embed these as libraries. Do not fork them. Talk to them over HTTP. When an engine needs to change behaviour, upstream the patch or switch engines.

### AI plane
Anthropic Claude (NL→SQL, styling, agentic geoprocessing), segment-geospatial + SAM (feature extraction on GPU-burst compute — Lambda / Modal / RunPod), Clay Foundation Model (imagery embeddings into pgvector).

**Goal:** every AI action is logged (prompt, model, version, user, timestamp, result checksum). AI suggestions are reviewable and reversible. No AI output is treated as ground truth in a client deliverable without human QA.

## Data layer

**Postgres is the gravity well.** Core transactional data, vector geometries, pgvector embeddings, and multi-tenant isolation all live in one database.

Logical schema:

- `orgs(id, slug, name, plan, created_at)` — tenant root.
- `members(org_id, user_id, role)` — user ↔ org with role.
- `projects(id, org_id, slug, name, visibility)` — work unit.
- `api_keys(id, org_id, prefix, hashed_key, scopes, expires_at)`.
- `datasets(id, project_id, name, source_kind, source_uri, crs, bbox, metadata jsonb)` — logical handle for a dataset.
- `layers(id, dataset_id, name, geometry_type, table_name, style jsonb)` — rendered form.
- `features(layer_id, id, geom geometry, properties jsonb)` — actual geometries.
- `drone_flights(id, project_id, flown_at, site_geom, pilot, aircraft, metadata jsonb)`.
- `orthomosaics(id, flight_id, cog_url, dsm_url, pointcloud_url, resolution_cm)`.
- `extractions(id, orthomosaic_id, model, prompt, output_layer_id, qa_status)`.
- `embeddings(subject_kind, subject_id, model, vector vector(768))` — for semantic search.
- `ai_events(id, actor, kind, model, prompt, response_summary, created_at)` — audit log.

RLS policy baseline: a row is visible to user *u* iff *u* is a member of the row's `org_id`, subject to role. Public share links issue short-lived JWTs with a project-scoped claim.

## Tile / feature serving

- **Martin** reads from PostGIS and serves MVT on `/{table}/{z}/{x}/{y}` — the hot path for vector layers.
- **PMTiles** on R2 serve static pre-processed datasets directly via range requests — zero server infra.
- **TiTiler** handles dynamic raster tiles from COGs (drone orthomosaics, DSMs).
- **pg_featureserv** auto-generates OGC API Features endpoints from PostGIS tables — for government / enterprise integrations.

The Next.js app never embeds a tiling library. It proxies or redirects to these services.

## AI orchestration

Two classes of AI feature:

1. **Fast-path (Claude API direct)** — NL→SQL, style generation, data cleaning suggestions. Claude receives the relevant schema fragment + user prompt, returns SQL or JSON. We validate structurally (parse, whitelist functions, check RLS via a read-only role) before executing. Execute with a role that cannot write.
2. **Slow-path (GPU burst)** — SAM-based feature extraction, Clay embeddings, change detection. Queued jobs on Modal / Lambda / RunPod; results written back to PostGIS when done.

Model pin: `claude-opus-4-7` by default (configurable per feature via env). All AI events logged to `ai_events`.

## Auth

**Hosted product:** Supabase Auth with email/password, magic links, OAuth, optional MFA. RLS enforces org isolation at the DB.

**Enterprise / self-hosted:** Keycloak with SAML, OIDC, fine-grained RBAC. The product shell talks to either via a common session abstraction — the DB-level RLS model does not change.

## Deployment topology

| Service | Host | Cost (est.) |
|---|---|---|
| Next.js app | Vercel (Hobby until paid tier) | $0 |
| Postgres + Auth + Storage | Supabase Pro | $25/mo |
| Object storage | Cloudflare R2 | ~$5/mo |
| Vector tiles | Martin on Fly.io | ~$5–10/mo |
| Raster tiles | TiTiler on Fly.io or Vercel Functions | $0–5/mo |
| AI | Claude API + Modal GPU bursts | usage-based |

Total floor: ~$35–45/mo. AI and GPU usage scale linearly with paying customers.

## What we will *not* do

- Embed GPL-licensed servers as libraries in the Next.js process.
- Accept a dependency on Mapbox GL JS (licensing forked from the community standard).
- Store user-identifying drone footage unencrypted at rest in R2 — apply SSE-S3 and signed URLs.
- Offer a self-hosted "free tier" enterprise edition with disabled features — enterprise gets the real product, or they use AGPL community and self-support.

## Upstream dependency policy

Every upstream dependency we rely on (MapLibre, Martin, pg_featureserv, OpenDroneMap, TiTiler, shadcn/ui):

- We track upstream `CHANGELOG` or release feed.
- Local patches are contributed upstream first. A local-only patch is logged in `docs/UPSTREAM_DEVIATIONS.md` with reason, upstream issue link, and expected resolution.
- Breaking upstream changes are surfaced in an ADR before we upgrade.

The fork tax is the single most common cause of OSS projects collapsing after 18 months. This policy is the counter-discipline.
