"""Schema round-trip and validation tests.

These don't need torch / samgeo installed — they cover the HTTP contract
and make sure the wire format (camelCase) matches the TypeScript side.
"""

from __future__ import annotations

import pytest

from opengeo_extractor.schema import (
    ExtractionInput,
    ExtractionMetrics,
    ExtractionResult,
)


def test_extraction_input_accepts_camel_case_wire_format() -> None:
    payload = {
        "orthomosaicId": "00000000-0000-0000-0000-000000000001",
        "cogUrl": "https://example.invalid/ortho.tif",
        "prompt": "all buildings",
    }
    parsed = ExtractionInput.model_validate(payload)
    assert parsed.orthomosaic_id == payload["orthomosaicId"]
    assert parsed.cog_url == payload["cogUrl"]


def test_extraction_input_rejects_extras() -> None:
    payload = {
        "orthomosaicId": "00000000-0000-0000-0000-000000000001",
        "cogUrl": "https://example.invalid/ortho.tif",
        "prompt": "all buildings",
        "mysteryField": "surprise!",
    }
    with pytest.raises(ValueError):
        ExtractionInput.model_validate(payload)


def test_extraction_input_carries_bbox_and_prompts() -> None:
    payload = {
        "orthomosaicId": "id-1",
        "cogUrl": "https://example.invalid/ortho.tif",
        "prompt": "buildings",
        "bbox": [-121.07, 39.21, -121.05, 39.22],
        "prompts": [{"kind": "text", "text": "buildings"}],
    }
    parsed = ExtractionInput.model_validate(payload)
    assert parsed.bbox == (-121.07, 39.21, -121.05, 39.22)
    assert parsed.prompts is not None
    assert parsed.prompts[0].kind == "text"


def test_extraction_result_emits_camel_case() -> None:
    result = ExtractionResult(
        feature_collection={"type": "FeatureCollection", "features": []},
        metrics=ExtractionMetrics(
            model="samgeo-langsam-v1",
            latency_ms=1234,
            feature_count=0,
            extras={"downloadMs": 10},
        ),
    )
    emitted = result.model_dump(by_alias=True)
    assert "featureCollection" in emitted
    assert "latencyMs" in emitted["metrics"]
    assert "featureCount" in emitted["metrics"]


def test_extraction_metrics_extras_is_optional() -> None:
    metrics = ExtractionMetrics(
        model="samgeo-langsam-v1",
        latency_ms=1,
        feature_count=0,
    )
    assert metrics.extras is None
