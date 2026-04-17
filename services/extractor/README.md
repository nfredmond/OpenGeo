# OpenGeo Extractor

Text-prompted geospatial segmentation over drone orthomosaics, served as a FastAPI app. Wraps [segment-geospatial](https://samgeo.gishub.org/)'s `LangSAM` (SAM + GroundingDINO) and returns a GeoJSON `FeatureCollection`.

Part of the OpenGeo platform — see [ADR-002](../../docs/ADR/ADR-002-ai-feature-extractor-infra.md) for why this runs as a separate service behind an HTTP boundary.

## HTTP contract

```
POST /extract
Authorization: Bearer <OPENGEO_EXTRACTOR_TOKEN>
Content-Type: application/json

{
  "orthomosaicId": "uuid",
  "cogUrl": "https://…/ortho.tif",
  "prompt": "all buildings in frame"
}
```

Response:

```json
{
  "featureCollection": { "type": "FeatureCollection", "features": [...] },
  "metrics": {
    "model": "samgeo-langsam-v1",
    "latencyMs": 1234,
    "featureCount": 8,
    "extras": {
      "downloadMs": 120,
      "inferenceMs": 1100,
      "boxThreshold": 0.24,
      "textThreshold": 0.24,
      "estimatedCostCents": 0.37,
      "device": "cuda"
    }
  }
}
```

Point- and bbox-mode prompts are rejected with HTTP 422 in v1 (see ADR-002 §2).

## Deployment — Modal (production)

```bash
# First-time setup:
pip install modal
modal setup   # logs into your Modal account
modal secret create opengeo-extractor OPENGEO_EXTRACTOR_TOKEN=<your-token>

# Deploy:
cd services/extractor
modal deploy modal_app.py
```

Modal returns a public URL like `https://<workspace>--opengeo-extractor-fastapi-app.modal.run`. Put that in Vercel as `OPENGEO_EXTRACTOR_URL` and set `OPENGEO_EXTRACTOR=http`. The Next.js `HttpExtractor` picks up the rest.

GPU kind defaults to `a10g` (~$1.10/hr, ~5s inference for a small ortho tile). Override with `OPENGEO_MODAL_GPU=l4|h100` in the Modal environment.

## Local development — Docker CPU

The CPU image is intentionally available as a `docker compose` profile so it doesn't boot by default (pulling torch + samgeo + GDAL is a multi-GB image).

```bash
# Bring up the CPU extractor alongside the rest of the stack:
docker compose --profile extractor up -d

# Or build/run it standalone:
cd services/extractor
docker build -f Dockerfile.cpu -t opengeo-extractor:cpu .
docker run --rm -p 8100:8100 opengeo-extractor:cpu
```

Point the Next.js app at it by setting in `.env.local`:

```
OPENGEO_EXTRACTOR=http
OPENGEO_EXTRACTOR_URL=http://localhost:8100
OPENGEO_EXTRACTOR_TOKEN=
```

(Empty token = auth skipped, which the Python side detects as dev mode.)

**CPU inference is slow.** A 2048×2048 ortho tile takes 3–10 minutes for LangSAM on a modern CPU. This is for exercising the end-to-end pipeline, not real work. Use Modal for real work.

## Weights sync

SAM (ViT-H) and GroundingDINO (SwinT-OGC) weights are hosted on R2 so image builds don't depend on Meta's CDN being up. One-shot bootstrap:

```bash
cd services/extractor
python scripts/sync_weights.py
```

Requires `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` in the environment. Subsequent Modal image builds pull from R2 automatically.

## Development

```bash
cd services/extractor
pip install -e ".[dev]"
pytest                  # schema + HTTP route tests (no torch needed)
ruff check .
```

The inference path (`extractor.py::run_lang_sam`) is **not** covered by unit tests — it needs weights and takes minutes on CPU. Verify end-to-end via the gauntlet (`pnpm gauntlet --extractor=http` from the repo root) or by hand with a real ortho.

## Layout

```
services/extractor/
├── pyproject.toml               # deps, ruff config, pytest config
├── Dockerfile.cpu               # local dev CPU image
├── modal_app.py                 # `modal deploy` entrypoint
├── opengeo_extractor/
│   ├── __init__.py
│   ├── app.py                   # FastAPI routes + bearer auth
│   ├── extractor.py             # LangSAM pipeline: download → predict → GeoJSON
│   └── schema.py                # Pydantic models (camelCase wire format)
├── scripts/
│   └── sync_weights.py          # one-shot R2 weight sync
└── tests/
    ├── test_app.py              # route-level tests
    └── test_schema.py           # wire-format round-trips
```
