# ADR-001 — Initial architecture: Supabase + MapLibre + Martin + Next.js, HTTP-bounded engines

- **Status:** Accepted
- **Date:** 2026-04-16
- **Owner:** Nathaniel Ford Redmond

## Context

OpenGeo is being built solo. The research doc (`Dev planning documents/research.md`) surveys 20 years of attempts to build open-source ArcGIS Online and concludes:

- A parity clone is a 85–130 FTE-month effort — not viable solo.
- Every prior integrated portal (GeoNode, MapStore, geOrchestra, Lizmap, GISquick) suffers from tight coupling between product shell and GIS engines, which produces a fork tax that consumes the maintenance budget.
- The commercial winners (Felt, CARTO, Mapbox) each picked a vertical wedge. Generalists (Placemark) failed.
- A solo founder's window is an AI-native drone-to-insight wedge, not a platform clone.

## Decision

1. **Data plane:** Postgres 15 + PostGIS + pgvector, managed by Supabase. All tenant data lives here.
2. **Product plane:** Next.js 16 App Router on Vercel. tRPC for internal typed RPC. Supabase SSR client for auth / RLS-aware queries.
3. **GIS engine plane:** Martin (vector tiles), TiTiler (raster tiles), pg_featureserv (OGC API Features). Each runs as a separate HTTP service. Product plane talks to them over HTTP only — **no library embedding**.
4. **Frontend rendering:** MapLibre GL JS for 2D, CesiumJS for 3D (deferred to Phase 2). shadcn/ui + Tailwind + Radix for UI.
5. **AI:** Anthropic Claude (Opus 4.7 default) via the AI SDK. Feature extraction via segment-geospatial on GPU-burst compute.
6. **Object storage:** Cloudflare R2 for COGs, PMTiles, point clouds, raw drone image uploads. Egress cost is the decisive factor vs. S3.
7. **Auth:** Supabase Auth for hosted product. Keycloak for enterprise self-host. Both back an org-scoped RLS model in Postgres.
8. **License:** AGPL-3.0-or-later for the OSS core. Commercial license for enterprise / self-hosted-with-modifications.

## Alternatives considered

| Option | Why rejected |
|---|---|
| Mapbox GL JS instead of MapLibre | Mapbox forked to a proprietary license in 2020. MapLibre is the community fork and the direction the ecosystem is moving. |
| GeoServer as primary tile server | Embeds JVM dependency, older tech posture, stronger use cases are in WMS/WFS for legacy SDI — we can add it later as a GIS-engine-plane service if a customer requires it. |
| Vercel Postgres + separate Supabase Auth | Vercel Postgres has been discontinued. Supabase bundles PostGIS + pgvector + Auth + Storage + RLS in one managed service. |
| Mongo / DynamoDB / Firestore | PostGIS + pgvector is the only serious choice for geospatial + vector search in one DB. |
| Mapbox-hosted tile serving | Operational convenience, but lock-in and cost ruin the $40/mo infra target. |
| Fork ArcGIS-style GeoServices REST as primary API | Builds against a legacy spec. OGC APIs (Features, Tiles, Processes) are the standards-first direction. We can add a GeoServices compat layer later for migration. |
| Monolith (no Martin / TiTiler / pg_featureserv) | Would force us to reimplement vector tile serving, COG tile serving, and OGC Features — years of work. Embedding them as libraries creates the GPL entanglement and fork-tax problems the research doc explicitly warns about. |
| SvelteKit / Nuxt / Astro for the frontend | All deployable on Vercel, but Next.js App Router has the most mature AI SDK / Server Component / streaming story in early 2026, and the ecosystem delta is meaningful for a solo founder. |
| Mercenary stack (one Docker container per engine on a single VPS) | Fine for later. Starting with Vercel + Supabase + R2 + Fly.io keeps ops surface area tiny and lets features ship faster. We can migrate pieces to dedicated infra once unit economics demand it. |

## Consequences

### Positive
- Product-plane/engine-plane separation keeps AGPL-boundary clear and lets engines be swapped.
- Single DB (Postgres) eliminates sync complexity between tenant data and vector embeddings.
- All infra is either managed (Supabase, Vercel, R2) or runs one binary (Martin, TiTiler) — a solo founder can operate it.
- MapLibre + PMTiles + Martin is the fastest modern stack; tile serving cost is marginal.
- AGPL-core + commercial-enterprise matches the Grafana Labs / Plausible pattern that has produced sustainable OSS businesses.

### Negative
- Locked into Supabase's operational constraints (connection limits, RLS performance tuning, region choice). Mitigation: use pgBouncer via Supabase's built-in pooling; keep SQL-heavy work in Edge Functions or background jobs, not in request hot path.
- Multiple HTTP hops (browser → Next.js → Martin → Postgres) add latency. Mitigation: aggressive Cloudflare edge caching on tiles; Martin co-located with the Postgres region.
- Vercel / Supabase / Cloudflare are a three-vendor supply chain. Any one going down affects uptime. Mitigation: document degraded-mode behaviour; enterprise self-host path uses Docker Compose on customer infra.
- GPU compute for SAM / Clay is not on Vercel. Mitigation: Modal or Lambda labs as burst providers; feature flag behind `FEATURE_AI_FEATURE_EXTRACTION`.

## Revisit triggers

Re-open this ADR if any of these occur:

- Supabase's PostGIS support regresses or pricing makes the $40/mo floor non-viable.
- A customer requires OGC WFS/WMS as primary and pg_featureserv / Martin cannot bridge.
- An AGPL-incompatible dependency becomes essential to the product (rare, but possible for e.g. proprietary routing data).
- Vercel pulls back support for one of the Next.js features this architecture relies on (streaming, Server Actions, Route Handlers).
