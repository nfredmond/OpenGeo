"""LangSAM extractor — downloads a COG, runs text-prompted segmentation, returns GeoJSON.

The heavy work (torch, samgeo) is imported lazily so `/healthz` and tests
that don't touch inference don't pay the import cost. The SAM + GroundingDINO
weights are downloaded on first `extract()` call and cached in-process.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import time
from pathlib import Path

import httpx

from .schema import ExtractionInput, ExtractionMetrics, ExtractionResult

logger = logging.getLogger(__name__)

MODEL_NAME = "samgeo-langsam-v1"

# Thresholds tuned for aerial imagery. These match samgeo's defaults; expose
# via metrics.extras for reproducibility rather than request-level config.
BOX_THRESHOLD = 0.24
TEXT_THRESHOLD = 0.24

_lang_sam = None  # Cached model instance (lazy singleton)


def _get_lang_sam():
    """Lazy-load LangSAM. Weights download on first call (~2.5GB total)."""
    global _lang_sam
    if _lang_sam is not None:
        return _lang_sam

    logger.info("Loading LangSAM model (SAM vit_h + GroundingDINO)…")
    from samgeo.text_sam import LangSAM  # type: ignore[import-not-found]

    _lang_sam = LangSAM()
    logger.info("LangSAM ready.")
    return _lang_sam


def weights_loaded() -> bool:
    return _lang_sam is not None


async def download_cog(cog_url: str, dest_dir: Path) -> Path:
    """Fetch a COG to a local path. Uses httpx for async-friendly I/O."""
    dest = dest_dir / "ortho.tif"
    async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=10.0)) as client:
        async with client.stream("GET", cog_url) as response:
            response.raise_for_status()
            with dest.open("wb") as fh:
                async for chunk in response.aiter_bytes(chunk_size=1024 * 1024):
                    fh.write(chunk)
    return dest


def run_lang_sam(image_path: Path, text_prompt: str) -> dict:
    """Run LangSAM and emit a GeoJSON FeatureCollection.

    Text prompt is passed through to GroundingDINO + SAM. Result is a
    geopandas GeoDataFrame; we serialize it to GeoJSON and attach the
    source prompt to each feature's properties so downstream audit can
    trace which prompt produced which polygon.
    """
    sam = _get_lang_sam()
    out_geojson = image_path.parent / "result.geojson"

    sam.predict(
        str(image_path),
        text_prompt=text_prompt,
        box_threshold=BOX_THRESHOLD,
        text_threshold=TEXT_THRESHOLD,
    )

    # samgeo's `.raster_to_vector` is the documented way to get polygons
    # when the output is a mask; `.gdf` is set after `.predict()` for
    # text-prompted runs. Prefer `.gdf` and fall back to mask export only
    # if the former is absent (older samgeo versions).
    if hasattr(sam, "gdf") and sam.gdf is not None:
        gdf = sam.gdf
    else:
        mask_path = image_path.parent / "mask.tif"
        sam.show_anns(output=str(mask_path))
        import geopandas as gpd  # noqa: F401  # local import: heavy
        from samgeo import raster_to_vector  # type: ignore[import-not-found]

        raster_to_vector(str(mask_path), str(out_geojson))
        with out_geojson.open() as fh:
            return json.load(fh)

    # Reproject to EPSG:4326 so the client always gets lng/lat, regardless
    # of the input ortho's CRS.
    if gdf.crs is not None and gdf.crs.to_epsg() != 4326:
        gdf = gdf.to_crs(epsg=4326)

    # Attach the source prompt for provenance. The logger on the Next.js
    # side already records the prompt at the event level; this puts it on
    # each feature too so exported GeoJSON carries its own audit trail.
    gdf = gdf.assign(prompt=text_prompt)

    # Drop columns that won't serialize (e.g., raster bbox tuples).
    keep_cols = [c for c in gdf.columns if c == "geometry" or gdf[c].dtype != object or all(
        isinstance(v, (str, int, float, bool, type(None))) for v in gdf[c]
    )]
    gdf = gdf[keep_cols]

    gdf.to_file(out_geojson, driver="GeoJSON")
    with out_geojson.open() as fh:
        return json.load(fh)


async def extract(payload: ExtractionInput) -> ExtractionResult:
    """End-to-end: download COG → run LangSAM → return FeatureCollection."""
    if payload.prompts:
        # Explicit rather than silent — ADR-002 locks v1 to text-only.
        non_text = [p for p in payload.prompts if p.kind != "text"]
        if non_text:
            raise ValueError(
                "Point/bbox prompts are not yet supported (ADR-002, v1 ships text-only)."
            )

    started = time.perf_counter()
    with tempfile.TemporaryDirectory(prefix="opengeo-extract-") as tmp:
        tmp_path = Path(tmp)
        cog_path = await download_cog(payload.cog_url, tmp_path)
        download_ms = int((time.perf_counter() - started) * 1000)

        inference_started = time.perf_counter()
        feature_collection = run_lang_sam(cog_path, payload.prompt)
        inference_ms = int((time.perf_counter() - inference_started) * 1000)

    features = feature_collection.get("features", [])
    total_ms = int((time.perf_counter() - started) * 1000)

    # Best-effort cost estimate. Modal doesn't expose per-invocation cost
    # at call time; this is a rough back-of-envelope based on active GPU
    # seconds at the A10G rate ($1.10/hr). Overwritten by the Modal wrapper
    # if it has a better number.
    gpu_seconds = inference_ms / 1000
    estimated_cost_cents = round(gpu_seconds * (1.10 / 3600) * 100, 4)

    return ExtractionResult(
        feature_collection=feature_collection,
        metrics=ExtractionMetrics(
            model=MODEL_NAME,
            latency_ms=total_ms,
            feature_count=len(features),
            extras={
                "downloadMs": download_ms,
                "inferenceMs": inference_ms,
                "boxThreshold": BOX_THRESHOLD,
                "textThreshold": TEXT_THRESHOLD,
                "estimatedCostCents": estimated_cost_cents,
                "device": os.environ.get("OPENGEO_DEVICE", "auto"),
            },
        ),
    )
