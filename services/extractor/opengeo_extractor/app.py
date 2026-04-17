"""FastAPI app — the HTTP surface the Next.js Extractor contract talks to."""

from __future__ import annotations

import logging
import os
from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException, status
from fastapi.responses import JSONResponse

from . import __version__
from .extractor import MODEL_NAME, extract, weights_loaded
from .schema import ErrorResponse, ExtractionInput, ExtractionResult, HealthResponse

logging.basicConfig(
    level=os.environ.get("OPENGEO_LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="OpenGeo Extractor",
    description="AI feature extractor — text-prompted segmentation of drone orthomosaics.",
    version=__version__,
)


def _verify_token(
    authorization: Annotated[str | None, Header()] = None,
) -> None:
    """Bearer-token auth. Skipped when OPENGEO_EXTRACTOR_TOKEN is unset (dev)."""
    expected = os.environ.get("OPENGEO_EXTRACTOR_TOKEN", "").strip()
    if not expected:
        return

    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or malformed Authorization header.",
        )

    provided = authorization.removeprefix("Bearer ").strip()
    if provided != expected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid bearer token.",
        )


@app.get("/healthz", response_model=HealthResponse)
def healthz() -> HealthResponse:
    return HealthResponse(
        status="ok",
        version=__version__,
        model=MODEL_NAME,
        weights_loaded=weights_loaded(),
    )


@app.post(
    "/extract",
    response_model=ExtractionResult,
    responses={
        401: {"model": ErrorResponse},
        422: {"model": ErrorResponse},
        500: {"model": ErrorResponse},
    },
    dependencies=[Depends(_verify_token)],
)
async def extract_route(payload: ExtractionInput) -> ExtractionResult:
    try:
        return await extract(payload)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc
    except Exception as exc:
        logger.exception("Extraction failed for orthomosaic %s", payload.orthomosaic_id)
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={"error": "extraction_failed", "detail": str(exc)},
        )
