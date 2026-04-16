# Building an AI-native open-source challenger to ArcGIS Online

*Integrated strategic report — v2, incorporating findings from the parallel OpenAI research.*

**The bottom line:** a solo founder can't replicate ArcGIS Online's full surface area — and shouldn't try. The open-source geospatial world has spent 15+ years pursuing that parity goal through projects like GeoNode, MapStore, and geOrchestra, and none has closed the gap. That's not a failure of those projects; it's evidence that "open-source ArcGIS Online" is the wrong target. The window that has genuinely opened is different: mature components (PostGIS, MapLibre, Martin, OpenDroneMap), cloud-native formats (PMTiles, COG, GeoParquet), and AI breakthroughs (SAM, geospatial foundation models, LLM-to-SQL) now make it possible to build something meaningfully better for a specific wedge of the market. The most promising path for Nat is an **AI-native drone-to-insight pipeline** with a modern developer experience, expanding outward from that kernel. Felt, CARTO, and Esri are all shipping AI features, but none of them touch drone/aerial workflows. That's the gap.

This report covers the full landscape, identifies what's buildable and what's a trap, sizes the "parity play" honestly so the wedge choice is informed, and ends with a concrete build plan.

---

## The integrated OSS GIS portals you should know exist — and why they don't close the gap

It's easy to assume there must be "an open-source ArcGIS Online" and you just haven't found it yet. There isn't. But the class of projects that tries to be one is worth naming explicitly, because several are mature, actively maintained in 2026, and represent the ceiling of what the integrated-portal approach has achieved:

| Project | License | Current status | What it does best | Where it falls short |
|---|---|---|---|---|
| **GeoNode** | GPLv3+ | v5.0.2 (Mar 2026), ~1.7k stars | Closest open-source analog to an ArcGIS Online portal: datasets, metadata, maps, per-dataset sharing & permissions | Thin hosted-data lifecycle, no real SaaS tenancy, analysis via underlying tooling rather than native workbench |
| **MapStore** | BSD-style | v2026.01.00 (Apr 2026), ~632 stars | Polished modern viewer, dashboards, geostories, 3D-capable web UX — by GeoSolutions | Usually paired with GeoServer; org governance thinner than ArcGIS Online |
| **geOrchestra** | GPLv3, PSC-governed | v25.0.2 (Feb 2026), ~145 stars | Enterprise SDI spine: federated catalog, GeoServer-centered publication, strong identity patterns | Weaker product/UX surface; not SaaS-oriented |
| **Lizmap** | MPL 2.0 | v3.9.7 (Mar 2026), ~322 stars | QGIS-project publishing with forms, editing, filtering, printing, dataviz | Tied to QGIS authoring; thinner org/admin/SaaS primitives |
| **QWC2** | BSD-2 | v2026.0.12-lts (Apr 2026), ~354 stars | Modular React/OpenLayers client atop QGIS Server; qwc-services adds auth and editing | More toolkit than turnkey SaaS |
| **Mapbender** | Open-source | v4.2.5 (Mar 2026), ~102 stars | Mature classical web mapping framework with OGC integration | Framework, not a modern hosted product |
| **GISquick** | GPL-2.0 | Last release Sep 2019, ~100 stars | Conceptually relevant | Maturity cadence makes it a risky foundation in 2026 |
| **OpenGeo / Boundless stack** | Mixed | Archived | Historically influential reference architecture | Best treated as a pattern, not a platform |
| **CartoDB open-source** | BSD-3 | Officially deprecated | Historically strong for upload/SQL/styling | No longer a live target |

**Why this matters for the solo-founder decision:** these projects collectively represent something like 15–20 person-years of accumulated effort by well-resourced European research consortia, public-sector SDI teams, and commercial OSS firms (GeoSolutions, 3Liz, Sourcepole, CAMPTOCAMP). None has closed the gap to ArcGIS Online. The missing capability in every case is the same: a **unified control plane** — item model, groups, sharing, privileges, credits, developer access, and admin UX all presented as one coherent product surface. ArcGIS Online's moat isn't the rendering engine or the analysis engine. It's the tight integration of identity, sharing, item lifecycle, location services, and mobile/offline into one experience.

The practical read: **if 20 years of OSS effort hasn't produced a parity clone, a solo founder absolutely should not attempt one.** But the same observation that closes off "clone ArcGIS" opens up "build something different that's better at a specific thing."

---

## The component stack is genuinely ready — where OSS is strong, partial, and absent

Where ArcGIS Online falls on a capability axis, the OSS ecosystem falls on a **component** axis. The individual pieces are production-grade. The assembly work is what's missing.

**Where OSS is strong (near feature parity with ArcGIS Online):**

The tile serving ecosystem is the most mature category. **Martin** (Rust, from the MapLibre project) is the fastest open-source vector tile server, consistently outperforming alternatives in benchmarks. Combined with **PMTiles** — single-file tile archives served via HTTP range requests from object storage with zero server infrastructure — you can match ArcGIS Online's tile hosting at a fraction of the cost. **TiTiler** handles raster tiles from Cloud-Optimized GeoTIFFs. **GeoWebCache** integrated with **GeoServer** handles WMTS/TMS/WMS-C tile caching. **MapProxy** is excellent when fronting multiple legacy services or doing reprojection/proxying. Together, this stack covers vector, raster, static, and OGC-standards tile serving with production-grade performance.

Field data collection is another area of strength. **ODK/KoBoToolbox** provides XLSForm-based surveys with skip logic, repeat groups, offline sync, geopoint/geotrace/geoshape capture, and barcode scanning — covering roughly **90% of Survey123's functionality**. Esri's own Survey123 uses the XLSForm standard ODK pioneered. **QField** and **Mergin Maps** provide QGIS-on-mobile equivalents to Field Maps, with offline editing and cloud sync.

Geocoding and routing are solved. **Nominatim** (forward/reverse from OSM, documented at tens of millions of queries daily on one server), **Pelias** (multi-source: OSM, OpenAddresses, Who's on First, Geonames — best for product-quality search if ops budget is available), **Valhalla** (multi-modal routing with isochrones, matrix, map matching, TSP, truck routing), and **OSRM** (fastest routing engine, used by Mapbox) are all self-hostable and production-grade. Fleet routing/VRP supplements with **VROOM** or Google OR-Tools. Core routing and geocoding match ArcGIS for most use cases; the operational cost is data freshness and tuning, not software licensing.

OGC publication has strong choices. **GeoServer** (~4.3k stars) is the best open-source interoperability server for WMS/WFS/WCS, OGC API modules, WPS, vector tiles, security, and extensions. **MapServer** (~1.2k stars, v8.4 active) is fast C-based serving with OGC API Features and MVT. **QGIS Server** (GPL-2.0+) publishes WMS/WFS/WCS and preserves QGIS cartography — strong when your authoring center of gravity is QGIS.

Drone and imagery processing is Nat's home turf and an OSS strength. **OpenDroneMap/WebODM** produces orthorectified mosaics, DSMs/DTMs, 3D textured meshes, point clouds, and GeoTIFFs from drone imagery with quality competitive with ArcGIS Drone2Map. The **STAC + COG** ecosystem provides modern imagery cataloging and serving. For 3D, **CesiumJS** supports both OGC 3D Tiles and I3S layers natively, covering the core of ArcGIS Scene Viewer's rendering capabilities.

**Where OSS has partial coverage (functional but significant gaps):**

The web map viewer space has **MapLibre GL JS** (v5.23.0 Apr 2026, ~10.4k stars) as an excellent rendering engine — data-driven styling, 3D terrain, globe view, clustering, WebGL2 performance — but no turnkey *authoring experience*. **OpenLayers** (v10.9.0 Apr 2026, ~12.4k stars) is the standards-heavy alternative — broader format/projection/OGC support, less product-modern than MapLibre. **Leaflet** (~44.9k stars but last release from 2023) remains useful for simple mobile-friendly maps but is no longer the best default for a feature-rich competitor. ArcGIS Online's Map Viewer offers "smart mapping" (statistical analysis suggesting classification breaks, color ramps, and renderer types automatically), a popup builder UI, and Arcade expressions. MapLibre renders beautifully; the map *creation* UX would need to be built from scratch.

Dashboards exist in fragments. **Grafana** supports PostGIS and has map panels but lacks interactive spatial filtering. **Apache Superset** has deck.gl-based map visualizations. **MapStore** has connected map + chart widgets. But no open-source tool replicates ArcGIS Dashboards' no-code builder where a non-developer can wire up selectors, maps, charts, and gauges with cross-widget filtering.

Geoprocessing is strong for vectors (PostGIS spatial functions, **Turf.js** for client-side, ~50+ operations) but weaker for raster analysis as cloud services. **Actinia** (REST API for GRASS GIS) is the closest to cloud-hosted geoprocessing but immature. **pgRouting** (v4.0.1 Jan 2026, ~1.4k stars) covers shortest-path and network analysis inside PostgreSQL/PostGIS. Critically, ArcGIS's demographic enrichment data (income, population, consumer spending by area) is proprietary and has no open equivalent — this is a **data moat**, not an engineering problem.

**Where OSS has essentially no equivalent (requires building from scratch):**

Four capability areas have no meaningful open-source coverage:

- **StoryMaps** — ArcGIS StoryMaps is a rich WYSIWYG narrative authoring platform with scroll-driven map transitions, sidecar layouts, guided tours, and embedded media. **StoryMapJS** (Knight Lab) is a toy by comparison — a slide-based "location slideshow" with no themes, no sidecar, no inline maps. Building a real equivalent is essentially building a CMS with deep cartographic integration: **6–12 FTE-months solo**.

- **Experience Builder** — A map-centric low-code application builder with 30+ widgets, drag-and-drop layouts, inter-widget communication (triggers/actions), responsive design, and a custom widget SDK. No open-source project approaches this. Generic low-code platforms (Budibase, Appsmith) lack any geospatial widgets. This is the **hardest single gap to close: 12–18+ FTE-months solo**, and arguably a trap for a solo founder.

- **The sharing and permissions model** — ArcGIS Online's multi-tenant organization model with named users, user types, item-level sharing (private/org/group/public), groups with shared update capability, and granular role-based access is foundational infrastructure that every other component depends on. No OSS GIS platform has this. **4–8 FTE-months to build the core**, with ongoing complexity as every feature must respect the model.

- **Living Atlas** — A curated catalog of 10,000+ ready-to-use layers including basemaps, demographics, environmental data, real-time traffic, and satellite imagery. This isn't primarily an engineering problem — it's a **content curation and data licensing problem**. Open data exists (OSM, Overture Maps, NASA/ESA imagery, Natural Earth) but is scattered, unstyled, and requires processing. Proprietary demographic data would require commercial licensing agreements.

---

## Honest effort estimate: what parity would actually cost

Before sizing the wedge, it's useful to size the alternative — "build something that credibly competes with ArcGIS Online across the board." This is the sanity check that keeps scope discipline honest.

A reasonable subsystem-level estimate for a greenfield parity-seeking platform (assuming reuse of mature upstream components, not building engines from scratch):

| Subsystem | FTE-months |
|---|---:|
| Item model, catalog, metadata, search UX | 5–8 |
| Organizations, groups, sharing, roles, audit | 8–12 |
| Upload, publish, ETL, dependency management | 6–10 |
| Web map viewer, saved maps, embedding, app shell | 10–16 |
| Styling and symbology editor | 6–10 |
| Vector/raster delivery integration | 4–7 |
| Geoprocessing job framework and common tools | 10–16 |
| Geocoding and routing integration | 4–8 |
| Mobile/offline/PWA packaging | 6–10 |
| Admin, quota, metering, billing hooks | 6–10 |
| DevOps, security hardening, performance, observability | 12–18 |
| QA, accessibility, docs, release engineering | 8–12 |
| **Total for strong first release** | **85–137** |

The realistic reading is:
- **MVP with strong map publishing but weaker enterprise controls:** 45–70 FTE-months
- **Enterprise-capable first release:** 85–130 FTE-months
- **"Better than ArcGIS Online" on UX, standards, and performance with enterprise quality:** 120–180 FTE-months

A solo founder working intensely ships roughly **10–14 FTE-months per year** (AI coding assistants help, but they don't change the ceiling on design decisions, debugging, customer conversations, and operations). Which means:
- Parity MVP: **4–6 years solo**
- Enterprise-capable: **7–11 years solo**
- Genuinely better than ArcGIS Online across the board: **10–15 years solo**

These are not business-viable timeframes. The argument is not that the work is impossible — it's that the parity framing produces a roadmap no solo founder can execute inside the window of market relevance. **The wedge strategy works because it drops the denominator: instead of chasing 85–130 FTE-months of surface area, you pick a 4–6 FTE-month slice where focus and domain expertise let you ship something the big players can't or won't.** That's the entire point of the drone-to-insight positioning.

A secondary consequence: **infrastructure costs scale with ambition too.** A parity platform at scale runs:

| Size | Assumptions | Self-managed | Managed cloud |
|---|---|---:|---:|
| Small | 5k MAU, <1 TB data | $150–800/mo | $800–3,000/mo |
| Medium | 50k MAU, 5–10 TB | $1,000–4,000/mo | $4,000–15,000/mo |
| Large | 500k+ MAU, tens of TB | $8,000–25,000+/mo | $20,000–100,000+/mo |

The wedge, by contrast, starts at ~$40/month and scales linearly with paying customers. That ratio — bounded downside, real unit economics — is what makes it a solo-founder-viable business.

---

## The commercial competitors prove the market is real but treacherous

The modern GIS challenger space has produced clear lessons about what works and what doesn't. One cautionary tale stands above the rest for Nat's situation.

**Placemark is the most important case study.** Tom MacWright — early Mapbox engineer, respected in the geo community — built Placemark as a solo founder: a web-based geospatial data editor, essentially "better geojson.io." He shut it down in November 2023 and open-sourced the codebase in January 2024. His postmortem: *"The high end is captured by Esri... the low end is captured by free tools."* He was caught in the middle with insufficient willingness-to-pay. His key lesson: *"If I were to do it again, I'd do something in a niche, targeting one specific kind of customer."* General-purpose geospatial tools are extremely hard to monetize as a solo founder.

**Felt** ($19.5M raised, led by Bain Capital Ventures and Footwork) is the most successful modern challenger. Founded in 2021 by Sam Hashemi (prev CEO of Remix, acquired for $100M) and Can Duruk (early Uber engineer), Felt positions itself as "Figma for maps" — beautiful UX, drag-and-drop data upload, real-time collaboration, SOC 2 compliance. Their AI features (natural language → SQL across PostGIS/Snowflake/BigQuery, automated data wrangling) are the most polished in the market. **Over 50% of their customer base is in energy and climate**, which reveals an important truth: winning in geo means winning in a vertical, not competing on breadth. They charge ~$200/month for teams.

**CARTO** ($92M raised, $28.9M revenue in 2024, nearly tripling since 2021) pivoted from consumer mapping to enterprise cloud-native spatial analytics. Their differentiator is running natively on customers' data warehouses (BigQuery, Snowflake, Databricks) — no data movement. In 2025, they launched "Agentic GIS" with AI Agents that chain spatial operations via natural language, plus an MCP server that exposes 200+ spatial workflows as tools for Claude and other LLM agents. CARTO targets large enterprises: Mastercard, Vodafone, T-Mobile.

**Mapbox** ($507M+ raised, $1.3B valuation, ~915 employees) is infrastructure, not a platform competitor. They provide the building blocks (GL JS, Navigation SDK, Search API, Studio) for developers embedding maps in apps. Their switch of Mapbox GL JS to a proprietary license in 2020 triggered the **MapLibre fork** — now the community standard. Mapbox is pivoting heavily toward automotive (Toyota 2026 RAV4 partnership).

**Bunting Labs** is the most relevant small-team precedent. A **2-person YC team** (S22), they've built an AI Vectorizer QGIS plugin (80,000+ downloads) that digitizes raster maps/PDFs to vector 4x faster than manual, plus **Mundi.ai** — an open-source (AGPL) AI-native web GIS where users collaborate with an AI agent to edit maps via natural language. Mundi connects to PostGIS and treats it as the execution engine. Small scale but interesting product surface area proving that a tiny team can ship meaningful AI-geo tools.

**Esri's real moat is not technology — it's ecosystem.** Government monopoly (most US federal, state, and local agencies are locked in), workforce moat (every GIS degree teaches ArcGIS, 300K+ trained professionals), data moat (Living Atlas), platform breadth (100+ products), services ecosystem (thousands of certified partners), and regulatory capture (government RFPs often specify Esri compatibility). They're also actively modernizing: AI assistants for Arcade expressions, code generation, survey design, and metadata; integration with Overture Maps; pay-as-you-go Location Platform pricing. Estimated **$2B+ annual revenue**, privately held since 1969.

**The strategic takeaway:** No one has successfully out-Esri'd Esri. Every winner found a niche. Felt = energy/climate collaboration. CARTO = enterprise analytics on data warehouses. Mapbox = developer infrastructure. The white space is at the intersection of AI, specific vertical workflows, and developer experience — not in building "ArcGIS but open source."

---

## AI-native features that matter versus AI features that are just demos

The GeoAI landscape has accelerated dramatically. Multiple competitors are shipping real AI features, but significant opportunities remain, especially at the intersection of drone/aerial workflows and AI. Here's what's real, what's hype, and what's genuinely novel.

**Natural language → spatial SQL is already shipping but still has room.** Felt's "AI Data Engineer" translates natural language into SQL across PostGIS, Snowflake, BigQuery, and Databricks using Claude. CARTO's AI Agents reached GA in late 2025, supporting conversational queries that generate layers, filter by spatial masks, and navigate maps. Academically, **Aino World** fine-tuned Mistral-7B specifically for text-to-spatial SQL and claims 90%+ accuracy, while general LLMs achieve under 60% on spatial SQL benchmarks. The GeoSQL-Eval benchmark (September 2025, 14,178 instances, 340 PostGIS functions) shows this is a hard problem — spatial SQL complexity (SRIDs, topological relationships, coordinate systems) makes it much harder than regular text-to-SQL. A solo founder can build a basic version in **4–6 weeks** using Claude API + PostGIS + schema context injection, but competing with Felt's polish would take longer.

**AI-assisted map styling is an underserved gap.** MapLibre's style spec is well-structured JSON — ideal for LLM generation. An LLM can generate valid style JSON from descriptions like "dark theme transit map with blue transit lines and muted land colors." Mapbox released "Agent Skills" (15+ prompts teaching AI coding assistants cartographic best practices), and an AIAMAS QGIS plugin uses LLMs for semantic style matching, but **no major product ships LLM-generated map styling as a core feature**. This is a quick win: high novelty, moderate value, **2–3 weeks** to build a basic version.

**Feature extraction from imagery is the highest-value AI capability for Nat's positioning.** The open-source toolkit is powerful: **segment-geospatial** (applying Meta's SAM to geospatial data with text prompts via Grounding DINO), **TorchGeo** (PyTorch library with data loaders for all major geospatial embedding models), **SAMPolyBuild** (91.2% of predictions match hand-digitized quality). Foundation models are maturing rapidly:

- **Prithvi-EO-2.0** (NASA/IBM): 600M parameters, trained on 4.2M global samples, open-source on HuggingFace, outperforms 6 other geospatial foundation models
- **Clay Foundation Model v1** (Development Seed): Open Apache license, generates 768-dimensional embeddings from multi-source imagery (including drone imagery at any resolution), pre-computed embeddings available — the most flexible for a startup
- **TerraMind** (IBM/ESA): 9-modality "any-to-any" model with 500 billion tokens — the most ambitious but less practical for a solo founder

**The killer insight: no product connects drone imagery AI with modern web GIS.** DroneDeploy dominates drone inspection workflows but has no web GIS platform. Felt and CARTO have AI but ignore drone/aerial workflows entirely. Esri has Drone2Map but it's a desktop product with limited AI. The intersection — upload drone imagery → AI extracts features (buildings, roads, damage, vegetation) → results appear as editable vector layers on a web map → natural language querying — is the whitespace.

**Semantic search over spatial data via pgvector + PostGIS is novel and high-value.** Combining pgvector (vector similarity search in PostgreSQL) with PostGIS spatial queries in a single database enables searching for "find datasets about bike infrastructure in Sacramento" or even searching satellite/drone imagery by visual similarity ("find areas that look like damaged roofs"). Clay model embeddings can be stored in pgvector for image-to-image search. Few products do this well — **3–5 weeks** to build a basic version.

**Agentic geoprocessing is the frontier.** CARTO's MCP server (open-source TypeScript) exposes 200+ spatial operations as tools for AI agents. Academic prototypes like LLM-Geo (Penn State) achieve ~80% success rate on autonomous spatial analysis tasks. The vision: "Analyze flood risk for this development site" → agent fetches DEM, runs hydrology analysis, checks FEMA data, generates report. This is complex (8–12 weeks for basic version) but represents where the field is heading — the "five levels of autonomous GIS" framework (Li & Ning) classifies current systems at Level 2–3 out of 5.

---

## A technical architecture that a solo founder can actually run

The architecture below is designed around three constraints: Nat's existing skills (Next.js, Supabase, PostGIS, MapLibre, CesiumJS, OpenDroneMap), minimal operational cost (~$40/month to start), and maximum leverage of existing open-source components.

**The guiding principle — separate the product plane from the GIS engine plane.** This is the single most important architectural insight from studying how existing integrated OSS portals succeed and fail. GeoNode, MapStore, and geOrchestra all show symptoms of tight coupling between product shell and GIS engines: changes to one ripple into the other, upstream patches accumulate into an expensive "fork tax," and the engines' GPL obligations entangle the product layer. The fix is service orientation: product shell talks to GeoServer, QGIS Server, Martin, Valhalla, and Pelias **over HTTP/message boundaries**, never through library embedding. This keeps proprietary value in workflow, UX, and operations (which are your competitive moat anyway), keeps GPL-family components at arm's length (simplifying commercial licensing), and lets you swap engines as the ecosystem evolves without rewriting the product. Apply this rule from day one; retrofitting it is painful.

**Data layer: PostgreSQL is the gravity well.** Supabase provides PostGIS + pgvector + Auth + Realtime + Storage + auto-generated REST/GraphQL APIs + Row Level Security in a single managed service ($25/month Pro tier). This is the foundation. PostGIS handles transactional spatial workloads (user data, edits, real-time queries) well into hundreds of millions of rows. For analytical batch workloads and format conversion, **DuckDB spatial** complements PostGIS — scanning GeoParquet directly from S3/R2 with columnar performance, no ETL needed. Crunchy Data's "Bridge for Analytics" now integrates DuckDB directly into PostgreSQL. **Cloudflare R2** (zero egress fees) stores COGs, PMTiles, point clouds, and drone imagery at minimal cost.

**Tile and feature serving: Martin + PMTiles + TiTiler.** Martin (Rust, from MapLibre project) serves dynamic vector tiles from PostGIS — the fastest option in benchmarks. PMTiles on R2 serve static basemaps and pre-processed datasets with zero server infrastructure. TiTiler handles dynamic raster tile serving from COGs when needed. pg_featureserv auto-generates OGC API Features endpoints from PostGIS tables. This stack covers vector + raster + OGC compliance with minimal moving parts.

**API layer: Supabase auto-APIs + tRPC.** Supabase's PostgREST pattern gives instant, filterable REST APIs from the database schema — zero custom code for CRUD operations. pg_graphql adds GraphQL. For custom business logic (tile generation, analysis jobs, AI queries), **tRPC** provides end-to-end TypeScript type safety with Next.js App Router. Edge Functions handle webhooks and async processing.

**Auth and multi-tenancy: Supabase Auth + Row Level Security (with Keycloak as the enterprise path).** Supabase Auth handles email/password, OAuth, magic links, and MFA for the main product. RLS policies in PostgreSQL provide multi-tenant isolation at the database level. For enterprise/self-hosted deployments requiring full CIAM, SAML, fine-grained RBAC, and federated identity, **Keycloak** is the standards-heavy alternative — it's what geOrchestra and most serious European SDIs use, and what a self-hosted enterprise edition should plug into. The data model: organizations → members (with roles) → projects → layers, maps, styles, datasets. API keys for developer access stored in a dedicated table, validated via Edge Function middleware.

**Frontend: Next.js + MapLibre + CesiumJS + shadcn/ui.** Next.js App Router as the main framework. MapLibre GL JS for 2D maps. CesiumJS for 3D globe/terrain (deck.gl as an alternative for data visualization overlays). shadcn/ui + Radix + Tailwind for the UI component layer. Monaco Editor for spatial SQL queries and style expressions. Modular architecture: map viewer, dashboard builder, and data explorer as separate route groups sharing a common auth/data layer.

**Mobile: PWA first, React Native later.** A Progressive Web App gets 80% of mobile functionality (camera, GPS, offline caching via service workers) with zero App Store friction. Full offline editing with conflict resolution (Field Maps equivalent) is a V2+ feature — it's a genuine distributed systems challenge. React Native + MapLibre Native + Expo is the path for a native app when needed.

**Deployment: ~$40/month total.**

| Service | Cost | Role |
|---------|------|------|
| Supabase Pro | $25/mo | Database, auth, storage, APIs |
| Vercel | $0 (free tier) | Next.js hosting, preview deployments |
| Cloudflare R2 + Workers | ~$5/mo | Object storage, PMTiles serving |
| Martin on Fly.io | ~$5–10/mo | Dynamic vector tile serving |

Self-hosting via Docker Compose for the full stack (Supabase's official compose file + Martin + TiTiler + optional Keycloak) enables both local development and enterprise self-hosted deployments. **SST** (Serverless Stack, TypeScript-native) is the best IaC fit for this stack.

---

## What would make the developer experience feel 10x better than ArcGIS

ArcGIS Online's developer experience suffers from complex per-user pricing, slow UI, no CLI, no local development story, XML-heavy configuration, and API design patterns from the 2000s. A modern platform can differentiate dramatically on DX by borrowing patterns from Supabase, Vercel, Stripe, and Linear. Below are the most important differentiators, in priority order:

**A standards-first API surface.** OGC APIs (Features, Tiles, Processes), vector tiles, PMTiles, and open auth patterns by default — with GeoServices REST compatibility layers where migration matters. This borrows the posture that GeoServer, QGIS Server, OpenLayers, and MapLibre already point toward naturally.

**Instant API from PostGIS schema.** Add a table with a geometry column → it's immediately available as a REST API, vector tiles (via Martin), and OGC API Features endpoint. Zero configuration. This is the Supabase pattern applied to geospatial: the database *is* the API. ArcGIS requires publishing a feature service, configuring capabilities, setting up REST endpoints — multiple manual steps.

**A CLI that developers actually want to use.** `geo init` scaffolds a project. `geo dev` starts PostGIS + Martin + the full platform locally via Docker with hot reload — edit a map style file, see changes live in the browser. `geo deploy` pushes to production. `geo layers list`, `geo style push style.json`, `geo query "SELECT * FROM parcels WHERE ST_DWithin(geom, ST_Point(-122.4, 37.7)::geography, 500)"`. Colored output, progress bars, `--json` flag for scripting. The Vercel CLI + Supabase CLI pattern applied to geospatial — and it simply doesn't exist in the GIS world.

**Git-friendly map definitions.** Map styles (MapLibre JSON), layer configurations, dashboard definitions, and database migrations stored as code files in Git repositories. `geo push` syncs to cloud. Version-control maps. Diff styles. Code review map changes. Preview deployments for every PR — a shareable URL showing "here's what the map looks like with this data update." This is how software teams already work; GIS has never offered it.

**Faster distribution by default.** PMTiles and Martin-served MVT over raster-heavy defaults, aggressive edge caching via Cloudflare Workers. Users should feel the speed difference immediately compared to ArcGIS's tile layers.

**Reproducible analysis.** Every analysis step exportable as SQL, JSON job spec, or notebook-compatible workflow. This is where open source can genuinely exceed ArcGIS Online, which is strong on UX but weaker on provenance and automation. A dashboard should be able to say "this chart came from this query run against this data version at this timestamp," and that lineage should be copy-pasteable.

**Transparent pricing without credit surprises.** Simple plans tied to storage, requests, and premium services — no opaque "service credits" that users can't predict or reason about. This alone is a meaningful buying signal for government and small-firm budgets.

**An interactive spatial query playground.** Browser-based SQL editor with instant map visualization. Write `SELECT * FROM buildings WHERE ST_DWithin(geom, ST_Point(-122.4, 37.7)::geography, 500)` and see results rendered on a map in real time. Stripe's API explorer is the model: interactive, educational, with live test mode. Monaco Editor (same engine as VS Code) provides syntax highlighting and autocompletion for PostGIS functions.

**Type-safe TypeScript SDKs** auto-generated from the database schema. `const { data } = await geo.layers.parcels.query({ bbox: [...], properties: ['owner', 'area'] })` — fully typed, with IntelliSense. Table stakes for modern developer tools but revolutionary in GIS, where most SDKs still use untyped REST calls returning arbitrary JSON.

**First-class modern formats.** PMTiles, COG, STAC, GeoParquet, FlatGeobuf, MVT, 3D Tiles, COPC, Zarr all importable, exportable, and servable without format conversion friction. OGC API compliance (Features, Tiles, Processes) matters for government and enterprise contracts but pragmatic modern formats (GeoParquet, PMTiles, COG) matter more for developer adoption.

---

## The realistic build plan: a drone-to-insight wedge product

The minimum viable product that leverages Nat's unique strengths (urban planning domain expertise, FAA Part 107, OpenDroneMap experience, existing NatFord Aerial Intelligence Platform) while occupying defensible whitespace should be an **AI-native drone data platform with web GIS capabilities** — not a general-purpose ArcGIS replacement.

**Phase 1: AI-powered drone-to-map pipeline (Months 1–4)**

Build the core loop: upload drone imagery → process with OpenDroneMap → AI extracts features (buildings, roads, vegetation, damage) → results appear as editable vector layers on a MapLibre web map → natural language querying of the data.

Concrete engineering tasks and time estimates:

- Wire up Supabase (PostGIS + pgvector + Auth) + Martin + MapLibre GL JS as the base stack. Basic map viewer with layer management and data upload (Shapefile, GeoJSON, GeoPackage → PostGIS). **3–4 weeks.**
- Integrate OpenDroneMap processing pipeline: upload drone photos → queue ODM job → output orthomosaic (COG), DSM, point cloud → store in R2 → serve via TiTiler. This extends Nat's existing WebODM work. **3–4 weeks.**
- AI feature extraction: integrate segment-geospatial (SAM) to extract building footprints, roads, vegetation from orthomosaics. User selects area on map → AI segments → results saved as PostGIS layers. **4–6 weeks.**
- Natural language → spatial SQL: Claude API + PostGIS schema context → execute queries → render on map. "Show me all buildings larger than 200 sq meters within 100m of the main road." **3–4 weeks.**
- AI data cleaning and schema inference: auto-detect CRS, geocode addresses, infer column types from uploaded files. **2–3 weeks.**
- AI map styling: generate MapLibre style JSON from natural language descriptions. **2 weeks.**

Phase 1 deliverable: a web app where you upload drone imagery, get AI-extracted features as map layers, and query everything via natural language. Total: **~4 months** of focused solo development.

**Phase 2: Platform capabilities (Months 5–9)**

- Sharing and permissions: organization → members → projects → layers with RLS policies. API key management. Public share links for maps. **4–6 weeks.**
- CLI tool: `geo dev`, `geo deploy`, `geo layers`, `geo query`. Local dev with Docker. **3–4 weeks.**
- Dashboard builder: configurable map + chart widgets with cross-filtering. Start simple — map, bar chart, indicator, date selector. **4–6 weeks.**
- Change detection between drone flights: upload two orthomosaics → AI identifies differences → highlight on map. High-value for construction monitoring, environmental assessment, infrastructure inspection. **3–4 weeks.**
- Semantic search: embed dataset descriptions and imagery tiles in pgvector. "Find areas similar to this damaged roof section." **2–3 weeks.**
- PMTiles support for static dataset hosting. Style editor (fork Maputnik or build with Monaco). **2–3 weeks.**

**Phase 3: Expansion toward platform (Months 10–18)**

- 3D scene viewer with CesiumJS: display drone-generated 3D meshes, point clouds, terrain. **3–4 weeks.**
- Agentic geoprocessing: LLM agent chains PostGIS operations, fetches external data (FEMA flood zones, census data), generates analysis reports. **6–8 weeks.**
- STAC catalog for imagery management: organize drone flights, satellite imagery, temporal queries. **3–4 weeks.**
- StoryMaps-lite: simplified scroll-driven narrative maps for project reports (urban planning use case). **4–6 weeks.**
- Mobile PWA: camera capture, GPS, offline tile caching, basic data collection forms. **4–6 weeks.**
- OGC API compliance (Features, Tiles) for government contracts. **2–3 weeks.**

**What to leverage, fork, or build from scratch:**

| Category | Approach | Project |
|----------|----------|---------|
| Spatial database | Use as-is | PostGIS (via Supabase) |
| Vector tile serving | Use as-is | Martin |
| Raster tile serving | Use as-is | TiTiler |
| 2D map rendering | Use as-is | MapLibre GL JS |
| 3D rendering | Use as-is | CesiumJS |
| Photogrammetry | Use as-is (API integration) | OpenDroneMap |
| Feature extraction | Integrate library | segment-geospatial + SAM |
| Embeddings | Integrate model | Clay Foundation Model |
| Auth/DB/APIs | Use managed service | Supabase |
| Enterprise auth (later) | Use as-is | Keycloak |
| Feature serving | Use as-is | pg_featureserv |
| Style editor | Fork and customize | Maputnik |
| Map authoring UI | **Build from scratch** | Custom (React + MapLibre) |
| Dashboard builder | **Build from scratch** | Custom (React + Vega-Lite) |
| CLI tool | **Build from scratch** | Custom (Node.js) |
| Sharing/permissions model | **Build from scratch** | Custom (Supabase RLS) |
| NL→SQL pipeline | **Build from scratch** | Custom (Claude API + PostGIS) |

**The hardest engineering problems (honest assessment):**

The offline sync with conflict resolution required for a Field Maps equivalent is a genuine distributed systems challenge — bidirectional sync, conflict detection, attachment handling. Defer this to Phase 3+. Dashboard cross-filtering — wiring selectors, maps, and charts so filtering one element updates all others — requires careful state management and a widget communication protocol. AI feature extraction at scale — processing thousands of drone images through SAM models — requires GPU compute (Lambda Cloud, Modal, or RunPod for burst processing at ~$0.50–2/hour).

---

## Business model: AGPL core, hosted platform, freemium pricing

**Licensing: AGPL v3 for the open-source core + commercial license for enterprise.** AGPL is the sweet spot for a solo founder — it's genuine open source (unlike BSL) but requires anyone running it as a SaaS to release their modifications, which deters cloud providers from competing with a hosted version. Redis tried SSPL, got backlash, and returned to AGPL in 2025, validating this approach. Grafana Labs has built a billion-dollar business on AGPL. Bunting Labs chose AGPL for Mundi.ai. MIT (like Supabase) offers maximum adoption but provides zero protection without $500M+ in funding and first-mover advantage.

**The component license picture is a design constraint, not an obstacle.** Many of the best GIS servers (GeoServer, QGIS Server, PostGIS) are GPL-family. The service-oriented architecture recommended above means your product shell talks to these engines over HTTP boundaries, not through library embedding — which means their GPL obligations don't propagate into your product layer. This is genuinely the right pattern regardless of licensing, and it happens to be what keeps commercial adoption clean.

**Commercial posture: don't hide core platform features behind a closed fork.** The healthiest model is a genuinely open core plus hosted service, SLAs, migration tooling, enterprise connectors, support contracts, and premium data packs. Users who want to self-host should get the real product. Users who want managed operation should pay for it. Plausible Analytics, PostHog, and Grafana Labs all use this model successfully. The temptation to close-source the good features will be strong during lean months; resist it, because the trust you build with an honest open core is the moat.

**Governance and community: plan for it from day one.** The successful long-lived OSS geospatial projects (GeoServer community-driven, geOrchestra PSC-governed) have explicit governance documents. For Nat's project: a **public RFC process** for major changes, public release notes, reference **Helm charts** for self-hosting, a **public demo environment** always running the latest version, and — once there's a community worth governing — a technical steering committee with neutral foundation alignment. This also signals seriousness to enterprise buyers evaluating self-hostable options.

**Upstream-first policy to avoid the fork tax.** GeoServer, QGIS Server, MapLibre, Pelias, Valhalla, OpenDroneMap all move. Every private patch you carry is a tax that compounds. The rule: patch upstream wherever possible, keep local extensions narrow, document every deviation, and benchmark every replacement with public evidence. This discipline is what separates a sustainable OSS business from one that drowns in its own fork.

**Trademark and branding caution.** Don't use ArcGIS trademarks in marketing. Don't imply official compatibility beyond what you actually implement. Don't position as a verbatim ArcGIS replacement — position as a standards-first alternative with import/migration tooling for people leaving ArcGIS. If you integrate with Esri services or SDKs anywhere (even for migration), Esri's terms and attribution rules apply; read them carefully.

**Data licensing is where most open-source geo products quietly break.** OpenStreetMap data is ODbL-licensed — attribution is mandatory and share-alike obligations apply to modified databases that are distributed. If a customer ingests your OSM-derived layers into their internal PostGIS and redistributes, you need to understand the chain. OpenAddresses is BSD-licensed at the code level, but **the processed address corpus is not globally relicensed** — individual sources retain their own licenses, so compliance happens source by source. Natural Earth and NASA/ESA imagery are mostly permissive but check each dataset. If you offer a Living Atlas equivalent, this becomes a real ongoing operational burden, not a one-time legal review. Commercial data (demographics, traffic, POIs, imagery) requires licensing contracts and is the single biggest structural cost difference between an OSS portal and ArcGIS Online — Esri's Living Atlas is as much a data licensing moat as an engineering one.

**Pricing: fill the gap between free tools and $700/year ArcGIS.**

| Tier | Price | Target | Includes |
|------|-------|--------|----------|
| **Free** | $0 | Solo developers, students | 1 project, 500MB PostGIS, 1GB storage, 50K map views/mo |
| **Pro** | $29/mo | Freelancers, consultants | 5 projects, 8GB PostGIS, 10GB storage, 500K map views/mo, CLI, API keys |
| **Team** | $149/mo | Small firms, agencies | Unlimited projects, 50GB PostGIS, 100GB storage, 5M map views/mo, 10 seats |
| **Enterprise** | Custom | Government, large orgs | SSO (Keycloak), SLA, self-hosted, unlimited, priority support |

Usage-based add-ons for AI features (embeddings generation, LLM queries, GPU-intensive feature extraction) and drone processing (ODM compute time) align costs with value delivered.

**Revenue trajectory (realistic, bootstrapped):**

Year 1: **$0–5K MRR** ($0–60K ARR). Focus on developer community, content marketing (blog posts about PostGIS + AI, drone data workflows), open-source contributions. Target 50–100 free users, 5–10 paying customers — primarily urban planning and environmental consultants who need drone data + web maps.

Year 2: **$5–20K MRR** ($60–240K ARR). Expand to adjacent verticals: construction monitoring, renewable energy site assessment, infrastructure inspection. First team/enterprise deals. Product-market fit validated.

Year 3: **$20–50K MRR** ($240–600K ARR). Consider raising a seed round (or continue bootstrapping). The GIS analytics market is $15B+ and growing at ~13% CAGR — even capturing 0.001% is a real business.

---

## The honest failure modes and why this could still work

**Failure mode 1: The Placemark trap.** General-purpose geospatial tools struggle to monetize because free tools (QGIS, Leaflet) capture the low end and Esri captures the high end. Mitigation: don't build general-purpose. Build for the **drone data → analysis → decision** workflow specifically, then expand. Nat's domain expertise in urban planning and transportation is the moat that Placemark lacked — Tom MacWright was a developer building tools for developers, not a domain expert building tools for their own profession.

**Failure mode 2: Scope creep toward "full ArcGIS."** The 85–130 FTE-month estimate above is exactly how this failure looks from the outside — a solo founder starts with a focused wedge, adds Experience Builder because one customer asked, adds StoryMaps because it would be cool, adds a Living Atlas because the data exists, and three years later is 15% of the way to parity with no product-market fit in any direction. Mitigation: ruthlessly prioritize the drone-to-insight pipeline. Say no to everything that isn't on the critical path to "upload drone data, get AI-extracted insights, share results." If a customer asks for StoryMaps, suggest they export to a static site generator. If a customer asks for full ArcGIS parity, politely decline and refer them to Esri.

**Failure mode 3: AI features that are demos, not products.** A ChatGPT wrapper that generates PostGIS SQL is a weekend project, not a product. The difference is reliability (handling edge cases, CRS issues, ambiguous queries), integration (results rendered on the map, saved as layers, shareable), and domain specificity (understanding drone data schemas, urban planning terminology). Mitigation: optimize for **one workflow end-to-end** rather than broad AI capabilities.

**Failure mode 4: Esri ships it first.** Esri is adding AI assistants across products — Arcade, Business Analyst, Survey123, Pro. But Esri moves slowly on UX, their developer experience remains poor, and their architecture is fundamentally not AI-native (AI is bolted onto a 30-year-old platform). The window is real but finite — probably **2–3 years** before Esri's AI features become "good enough" to remove the differentiation.

**Failure mode 5: Fork tax from diverging upstreams.** Over two years, accumulating private patches to MapLibre, Martin, or OpenDroneMap to work around edge cases adds up to a maintenance burden that consumes the entire engineering budget. Mitigation: the upstream-first policy above, rigorously applied. When in doubt, contribute the patch upstream and wait for the release rather than carrying the fork.

**Why this could work despite everything:** The GIS industry is undergoing a generational shift. Cloud-native formats (PMTiles, COG, GeoParquet) are replacing proprietary formats. MapLibre has replaced Mapbox GL JS as the community standard. AI is creating a genuine paradigm shift in how spatial data is processed and queried. The Overture Maps Foundation (Amazon, Meta, Microsoft, TomTom) is creating open, standardized map data that reduces dependency on any single provider. And the Part 108 NPRM (August 2025) is creating a standardized framework for BVLOS drone operations — expanding the addressable market for drone data platforms significantly.

Nat's unique positioning — urban planning domain expertise + drone operations license + existing aerial intelligence platform + modern web development skills — is rare. Most GIS developers don't fly drones. Most drone operators don't build web platforms. Most web developers don't understand spatial data. The intersection of all four is the wedge.

---

## Conclusion: build the thing only you can build

The strategic recommendation is clear: **don't build "open-source ArcGIS Online."** Twenty years of evidence from GeoNode, MapStore, geOrchestra, and others shows that the parity path requires 85–130 FTE-months minimum and still produces something that loses on product polish. Build instead an AI-native drone data intelligence platform with modern DX, positioned at the intersection of Nat's expertise — urban planning, drone operations, and web development. Start with the drone-to-insight pipeline (upload → process → AI extract → query → share), differentiate on developer experience (CLI, git-friendly, instant API, TypeScript SDK) and AI-native features (natural language querying, automated feature extraction, semantic search), and expand outward as the product finds traction.

The stack is PostGIS + Martin + MapLibre + CesiumJS + OpenDroneMap + Supabase + Claude API + segment-geospatial + Clay embeddings, deployed on Supabase + Vercel + Cloudflare R2 for ~$40/month, with Keycloak available for the enterprise self-host path. License it AGPL. Price it at $29–149/month. Target urban planners, environmental consultants, and infrastructure inspectors who need to go from drone flight to actionable spatial intelligence without touching ArcGIS.

The architectural discipline that makes this sustainable: keep the product plane and GIS engine plane separate (everything over HTTP, nothing library-embedded), stay upstream-first on every dependency, treat governance and licensing as day-one design decisions, and respect the data licensing chain on every dataset you touch. These are not bureaucratic overhead — they're the difference between a business that compounds and one that drowns in its own technical debt after two years.

The gap between "Esri's 100-product enterprise platform" and "a focused AI-native tool that does one workflow exceptionally well" is not a weakness — it's the entire strategy. Felt proved that beautiful UX + vertical focus + AI can win customers from Esri. Bunting Labs proved that a 2-person team can ship meaningful AI-geo tools. Placemark proved that generalism without domain focus fails. The path is narrow but real: build the thing that only someone with Nat's specific combination of skills and domain knowledge can build, and make it so good at that one thing that the market comes to you.
