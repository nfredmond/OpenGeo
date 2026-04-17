# ADR-002 — AI feature extractor infrastructure: Modal for GPU, HTTP behind the `Extractor` interface

- **Status:** Accepted (decisions on the four open questions recorded below; Modal account provisioning still on Nathaniel)
- **Date:** 2026-04-16
- **Owner:** Nathaniel Ford Redmond
- **Related:** ADR-001 (locks in "GPU compute for SAM / Clay is not on Vercel"), `lib/extraction/types.ts` (the `Extractor` interface this ADR commits to keeping)

## Context

Phase 1 ships with `MockExtractor` (`lib/extraction/mock-extractor.ts`) — deterministic synthetic polygons that exercise the end-to-end upload-ortho-extract-review flow without a model server. The pluggable `Extractor` interface (`lib/extraction/types.ts`) and `getExtractor()` factory (`lib/extraction/index.ts`) already abstract the implementation, so swapping in a real model is a drop-in rather than a rewrite.

What's not decided: **where the real SAM / segment-geospatial inference runs, and how the Next.js app calls it.**

Constraints:

- **Cost floor:** ADR-001 targets ~$40/mo operating cost through MVP. Anything always-on with a dedicated GPU breaks that.
- **Python-native toolchain:** `segment-geospatial` / `samgeo` is a Python library that wraps Meta's SAM with geospatial tilers. Rewriting in another language is out of scope; the inference side stays Python.
- **AGPL boundary:** ADR-001 forbids library-embedding GIS engines. The extractor runs behind an HTTP boundary for the same reason — it also happens to make swapping implementations trivial.
- **Solo operator:** whatever we pick has to be cheap to operate and cheap to debug. No Kubernetes, no custom autoscaling, no GPU driver management.
- **Low early volume:** realistic Phase 1 load is ~10–100 extractions/month across all orgs. Traffic may be bursty (a planner processes a whole project's worth of orthos in one sitting).

## Decision

**Run the real extractor as a Modal app.** The Next.js app invokes it over HTTP via a new `HttpExtractor` implementing the existing `Extractor` interface.

- **Production:** [Modal](https://modal.com/) GPU function — scale-to-zero, pay-per-second, Python-native. SAM inference on an A10G or L4 for ~$1.10/hr; a 20-second extraction is ~$0.006.
- **Development:** CPU-only Docker Compose service for local integration testing (optional — `MockExtractor` remains the zero-setup default). Same HTTP contract as Modal, so `OPENGEO_EXTRACTOR_URL` points either place.
- **Contract:** Python service exposes `POST /extract` accepting the JSON shape of `ExtractionInput` and returning the JSON shape of `ExtractionResult`. Bearer token in `Authorization` header. No streaming response in v1 — requests are short enough that a single-shot response keeps the client trivial.
- **Next.js side:** new `lib/extraction/http-extractor.ts` implementing `Extractor`. `getExtractor()` dispatches on `OPENGEO_EXTRACTOR` (`mock` | `http`). Env vars: `OPENGEO_EXTRACTOR_URL`, `OPENGEO_EXTRACTOR_TOKEN`.
- **Repo layout:** extractor Python lives in `services/extractor/` (new directory). Separate `pyproject.toml`, separate tests, separate README. Deployed independently via `modal deploy` from that directory.
- **AGPL status:** the extractor service is AGPL along with the rest of the OSS core. SAM weights themselves are Meta-licensed (research/commercial-permissible terms per their license); we ship them as downloadable artefacts, not bundled.

## Alternatives considered

| Option | Why rejected |
|---|---|
| **Replicate** | Managed SAM endpoints are simple, but lock us into their model catalogue. We want to evolve toward `samgeo` with its geospatial tilers, then Clay embeddings — that path requires our own code, not a hosted endpoint. Also higher per-call cost than Modal at our volumes. |
| **Fly.io GPU Machines** | Fly is already in the stack (Martin). However, Fly GPUs in early 2026 are A100/L40S only — overkill for SAM and 3–5× more per hour than Modal's A10G/L4 tier. Cold-start-to-inference latency on Fly Machines is also slower than Modal's warm pool. Revisit if Modal pricing shifts adversely or a customer needs on-prem. |
| **AWS Lambda with GPU / Lambda container images** | No native GPU on Lambda as of 2026-Q1. SageMaker serverless has cold starts measured in minutes for multi-GB models. Operational complexity is high for one function. |
| **Vercel Sandbox** | Newly GA Jan 2026, but purpose-built for sandboxed CPU code execution — not torch/CUDA workloads. Doesn't fit. |
| **Dedicated always-on GPU VPS (Lambda Labs, RunPod, Paperspace)** | Cheapest per inference at high volume, but a $200–$500/mo floor blows the cost target. Revisit when monthly extraction volume > ~5,000. |
| **CPU-only everywhere (Docker on Vercel Fluid or Fly)** | SAM on CPU takes 30s–5min per ortho tile depending on resolution. Unacceptable UX for the "ask the AI to find buildings" core loop. OK as a dev fallback, not production. |
| **Embedding a Python runtime in Next.js via `@pyodide` / WASM SAM port** | Browser SAM exists (ONNX quantized), but samgeo's geospatial tilers don't. Also kills the AGPL-boundary story by pulling model weights into the product plane. |
| **Streaming multipart tile inference (browser sends tiles, server batches)** | Possible optimization later. v1 takes the COG URL and handles tiling server-side — simpler contract, and fetch-from-R2 is cheaper than browser upload. |
| **Extractor as a library vendored into Next.js** | Violates ADR-001's product-plane/engine-plane separation. Also pulls a Python runtime into every Next.js container. |

## Consequences

### Positive

- **Same `Extractor` interface.** No API route changes. No UI changes. The switch is a factory flag.
- **Scale-to-zero.** Idle cost is $0; we only pay when a planner actually runs an extraction.
- **Python-native.** Stays on the `segment-geospatial` / `samgeo` / Meta SAM upgrade path without translation layers.
- **Cheap to debug.** Modal has tail-logs and a web inspector; local CPU dev worker can reproduce issues offline.
- **Clean swap path.** If a customer needs on-prem, replace Modal with a Fly GPU Machine running the same FastAPI app behind the same HTTP contract. Same `HttpExtractor` on the Next.js side.

### Negative

- **New vendor.** Adds Modal to the Vercel + Supabase + Cloudflare + Fly supply chain. Mitigation: the extractor is the only thing that calls Modal; an outage degrades the AI-extract feature but not the core platform.
- **Cold starts.** First invocation after idle is ~10–30s while the container spins and loads SAM weights. Mitigation: show a "spinning up model" state in the UI; keep the Modal function warm during business hours via a cheap keepalive cron if latency becomes a complaint.
- **Per-invocation cost scales with usage.** At 10,000 extractions/month we'd pay ~$60–$100/mo in Modal fees — the point at which a dedicated GPU becomes cheaper. Revisit then.
- **Weight provenance.** SAM weights are ~2.5 GB. We'll host them on R2 and download into the Modal image at build time, not commit-time. R2 egress cost is marginal; this is mostly a build-reproducibility concern.

## Scope of the implementing milestone (if accepted)

This ADR does **not** commit code yet — it commits a plan. If Nathaniel accepts, the follow-up milestone ships:

1. **`services/extractor/`** — new directory at repo root.
   - `pyproject.toml`, Python 3.12, `samgeo`, `fastapi`, `modal` as deps.
   - `app.py` — FastAPI app with one `/extract` route plus `/healthz`.
   - `modal_app.py` — `modal.App` wrapping `app.py` for `modal deploy`.
   - `Dockerfile.cpu` — local dev CPU image (same FastAPI app, no Modal).
   - `tests/` — unit tests on a tiny fixture COG. Not GPU-gated.
   - `README.md` — deploy + local dev instructions.
2. **`lib/extraction/http-extractor.ts`** (new) — implements `Extractor`, POSTs JSON, 60s timeout, wraps errors in `ExtractionError` so `withRoute` logs them with correlation IDs.
3. **`lib/extraction/index.ts`** — `getExtractor()` adds `case "http":` branch reading `OPENGEO_EXTRACTOR_URL` / `OPENGEO_EXTRACTOR_TOKEN`.
4. **`lib/env.ts`** — adds those two vars (optional strings, validated non-empty only when `OPENGEO_EXTRACTOR=http`).
5. **`.env.example`** — documents the two new vars.
6. **`docs/OPERATIONS.md`** — adds a section on deploying the extractor, running it locally, rotating the bearer token.
7. **`docker-compose.yml`** — adds an optional `extractor-cpu` service that builds `services/extractor/Dockerfile.cpu`. Behind a profile so it doesn't boot by default.
8. **Smoke test:** the Phase 1 gauntlet (`pnpm gauntlet`) gains an `--extractor=http` flag that points at a running local extractor; CI keeps the `mock` default.

Estimated effort: ~2 focused sessions. No schema changes, no migrations, no product-plane refactor.

## Revisit triggers

Re-open this ADR if any of these occur:

- Monthly extraction volume sustainably exceeds ~5,000 runs — at that point a dedicated GPU VPS is cheaper and the operational story has stabilized enough to justify it.
- Modal pricing changes such that a warm GPU becomes competitive with A100/L40S Fly Machines — consolidate vendors.
- A customer requires on-prem / air-gapped deployment — the HTTP contract makes the replacement easy, but we'd document a self-host path (single container, CPU SAM acceptable for small-scale internal use, or customer brings their own GPU).
- Replicate (or another managed endpoint) ships a first-class samgeo endpoint with the right feature set — may be worth re-evaluating "build vs. rent" at that point.
- Meta changes SAM's license terms in a way that makes commercial redistribution onerous — likely forces a swap to an alternative model (Mask2Former, YOLOv8-seg, or a foundation model from a different lab).

## Decisions on open questions

Resolved 2026-04-16 during the implementation milestone under autonomous authorization from Nathaniel ("you decide what's best"). Each decision is reversible; flag any of these for a revisit if reality diverges from the assumptions.

1. **Warm pool vs. cold start → cold start is acceptable in v1.** Phase 1 volume (~10–100 extractions/month across all orgs) doesn't justify the $12–20/mo of a keepalive function. The `/api/orthomosaics/[id]/extract` response already carries `latencyMs`; we surface a "spinning up model" state in the UI for the first extraction after idle. Revisit if a real user reports unacceptable first-hit latency.
2. **Prompt modalities → text-prompt only in v1.** Matches the "ask the AI in English" mental model that NL→SQL and NL→Style already establish. The `ExtractionPrompt` union stays as-is so point/bbox adds are non-breaking; the Python service accepts them in the request schema but returns a 422 if given — explicit rather than silent. Fast-follow lands once we have a UI affordance for drawing points/boxes.
3. **Per-extraction cost accounting → not in v1.** At Phase 1 spend ($1–5/mo) a line-item in the audit log is noise. The Python service does write an `estimated_cost_cents` field to `metrics.extras` when Modal surfaces it; the UI ignores it. Revisit when monthly spend crosses ~$50 or when a customer asks.
4. **Weights hosting → R2 public bucket.** The $0.10/mo storage cost is rounding error against the operational pain of a Meta CDN URL breaking mid-build. A one-shot bootstrap script (`services/extractor/scripts/sync_weights.py`) downloads from Meta's CDN and pushes to `R2_BUCKET/models/sam/vit_h.pth` (and matching for GroundingDINO). Image builds pull from R2. If R2 itself goes down, the Modal image's layer cache still has the weights baked in from the last successful build.
