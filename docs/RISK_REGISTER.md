# OpenGeo — Risk Register

Active as of 2026-04-16. Review monthly; delta any status change.

| # | Risk | Likelihood | Impact | Mitigation | Status |
|---|---|---|---|---|---|
| R1 | Scope creep toward full ArcGIS parity | High | Fatal | Ruthless `docs/ROADMAP.md` adherence. Declines in writing ("refer to Esri") documented. | Open — monitor weekly. |
| R2 | Placemark trap: generalism fails to monetize | Medium | Fatal | Stay wedged in drone-to-insight for urban planning; decline general-purpose requests. | Open. |
| R3 | AI features are demos, not products | High | High | End-to-end reliability tests; AI output audit log (`ai_events`); domain-specific prompt engineering; human-review gate on every client deliverable. | Open. |
| R4 | Esri ships comparable AI first | Medium | High | 2–3 year window. Invest in DX (CLI, git-friendly defs, typed SDK) — Esri's structural weakness. | Open. |
| R5 | Fork tax from upstream divergence | High | High | Upstream-first policy (`docs/ARCHITECTURE.md`). Log every private patch in `docs/UPSTREAM_DEVIATIONS.md`. | Open. |
| R6 | Data license chain compromised (OSM, OpenAddresses, etc.) | Medium | High | Track per-dataset provenance, source URL, timestamp, checksum, license, attribution obligations. Quarterly audit. | Open. |
| R7 | Supabase vendor risk | Low | High | Keep migrations portable to vanilla Postgres + PostGIS. Enterprise self-host path proves portability. | Open. |
| R8 | Claude API pricing or availability change | Medium | Medium | Abstract model behind a provider interface; plan for AI Gateway failover to OpenAI / Gemini. | Open. |
| R9 | GPU burst provider lock-in (Modal / Lambda / RunPod) | Low | Medium | Standardize on Docker images; any burst provider that runs Docker works. | Open. |
| R10 | Credentials leaked via git history | Low | High | `.env.local` gitignored; `private/` gitignored; precommit hook scans for secrets (planned). | Mitigated for initial scaffold (this commit) — monitor. |
| R11 | Drone imagery privacy / trespass concerns | Medium | Medium | Product requires explicit project-level acknowledgment of capture authority; imagery defaults to private; surface Part 107 / FAA / landowner guidance in upload UX. | Open. |
| R12 | RLS misconfiguration leaks cross-tenant data | Medium | Fatal | RLS-specific tests for every table; red-team query before each release; audit quarterly. | Open. |
| R13 | AI hallucinates SQL that modifies data | High | High | NL→SQL always executes under a read-only role; statement parser rejects non-SELECT; whitelist of PostGIS functions. | Open. |
| R14 | Single-founder bus factor | High (over multi-year horizon) | Fatal | Docs + ADRs + runbook maintained. Open-source core compounds external contribution surface. | Open. |

## New risk procedure

Add to the table, then open a GitHub issue labelled `risk:<severity>`. Review at month-end.
