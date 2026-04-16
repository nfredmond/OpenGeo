# OpenGeo — Project Charter

| Field | Value |
|---|---|
| Project name | OpenGeo |
| Owner | Nathaniel Ford Redmond (Nat Ford Planning) |
| Launched | 2026-04-16 |
| Status | Phase 1 (scaffolding → MVP) |
| License | AGPL-3.0-or-later (core), commercial license (enterprise) |
| Budget posture | Solo-bootstrapped; ~$40/mo infra target until paying customers |

## Problem statement

The open-source geospatial world has spent 15+ years trying to clone ArcGIS Online (GeoNode, MapStore, geOrchestra, Lizmap, QWC2). None has closed the gap. The missing capability is a unified control plane — item model, sharing, identity, item lifecycle, mobile/offline — presented as one coherent product.

Meanwhile, four forces have opened a genuinely new window:

1. Cloud-native formats (PMTiles, COG, GeoParquet) make modern tile/feature serving cheap and serverless-friendly.
2. Mature components (PostGIS, MapLibre, Martin, OpenDroneMap) are production-grade and freely composable.
3. AI foundation models (SAM, Prithvi, Clay, Claude) make spatial feature extraction and natural-language querying viable.
4. The drone/aerial workflow is the only major category where *no* web-GIS competitor (Felt, CARTO, Mapbox) is shipping.

Esri has Drone2Map, but it's desktop, old, and not AI-native. Felt and CARTO have excellent AI but ignore drones. DroneDeploy dominates drone inspection but has no web GIS. That intersection is the wedge.

## Intended users / clients

**Primary (Phase 1–2):**
- Urban planning and transportation consultancies that collect drone data (Nat Ford Planning's peer set)
- Northern California / Grass Valley / Nevada County / rural RTPAs / small cities / tribes — the same markets Nat Ford Planning serves today
- Environmental consultants doing site assessment, vegetation monitoring, post-fire recovery
- Construction monitoring and infrastructure inspection firms

**Secondary (Phase 3+):**
- Government agencies needing OGC-compliant data delivery
- Developers building map-heavy apps who want a Supabase-shaped geo backend

**Explicit non-users:** large enterprises already bought into ArcGIS Enterprise; users looking for a full ArcGIS Online replacement. The research doc is unambiguous that competing on breadth is a 10-year trap.

## Success criteria

Near-term (MVP, 4 months from scaffolding):
- A signed-in user can upload drone imagery, receive an orthomosaic + AI-extracted vector layers, and ask natural-language questions about the result.
- End-to-end demo runnable on local Docker Compose with the production Supabase backend.
- Core infrastructure cost under $40/month at ≤10 test users.

12-month:
- 50–100 free users; 5–10 paying ($29/mo Pro or $149/mo Team).
- MRR $0–5K; first paid team/enterprise pilot conversation underway.
- Community OSS repo with documented governance, release cadence, public demo instance.

24-month:
- MRR $5–20K.
- Two adjacent verticals active beyond urban planning (e.g. construction monitoring, renewable energy siting).
- Product-market fit validated — churn <5%/mo, organic referrals from existing customers.

## Time horizon

- Phase 1 (drone-to-insight MVP): months 1–4
- Phase 2 (platform capabilities — sharing, CLI, dashboards, change detection, PMTiles hosting): months 5–9
- Phase 3 (3D, agentic geoprocessing, STAC, StoryMaps-lite, mobile PWA, OGC compliance): months 10–18

## Revenue model

Freemium SaaS + open-core OSS + services.

| Tier | Price | Target | Includes |
|---|---|---|---|
| Free | $0 | Students, tinkerers | 1 project, 500 MB PostGIS, 1 GB storage, 50K map views/mo |
| Pro | $29/mo | Freelancers, consultants | 5 projects, 8 GB / 10 GB / 500K, CLI, API keys |
| Team | $149/mo | Small firms, agencies | Unlimited projects, 50 GB / 100 GB / 5M, 10 seats |
| Enterprise | Custom | Agencies, utilities, tribes | SSO (Keycloak), SLA, self-hosted, priority support |

Usage-based add-ons for AI (LLM tokens, embedding generation, GPU feature extraction) and drone processing (ODM compute time).

## Risk register

Top risks (expanded in [`docs/RISK_REGISTER.md`](docs/RISK_REGISTER.md)):

1. **Scope creep toward "full ArcGIS"** — the path that has killed every previous attempt.
2. **The Placemark trap** — Tom MacWright's post-mortem: general-purpose geo tools can't monetize between free and Esri.
3. **AI demos that don't become products** — reliability, integration, and domain specificity separate the two.
4. **Esri ships comparable AI first** — 2–3 year window before differentiation erodes.
5. **Fork tax on upstream components** — every private patch to MapLibre / Martin / ODM compounds.
6. **Data-license chain** — OSM/ODbL, OpenAddresses per-source, commercial demographic data each have distinct obligations.

## Covenant gates (per Nat Ford Planning Operating Covenant)

- **Truthfulness**: methods, assumptions, and limitations surfaced in every client-facing output. AI disclosure on every AI-generated feature.
- **Fair exchange**: pricing sustainable and transparent; no opaque "service credits".
- **Protect vulnerable communities**: decisions around map defaults, enrichment data, and pricing must not shift burden onto disadvantaged or tribal users.
- **Responsible AI**: AI accelerates drafting/cleanup/QA; client-critical conclusions require qualified human review before delivery. Every AI-generated layer, query, or style is logged with the prompt, model, and version.
- **Accountability**: release notes public, RFCs for major changes, provenance tracked per dataset.

## Definition of done (per milestone)

- Code and docs merged.
- Tests or checks run for the touched surface area.
- Operations notes updated (runbook, dashboards, alerts).
- Risk register updated when the change affects one of the listed risks.
- User-facing behaviour validated in a browser (or with explicit reason why not).
