"""FastAPI route-level tests.

Covers auth, healthz, and the 422 path for non-text prompts. Does NOT
exercise real inference — that needs torch + weights + GPU (or a lot of
patience on CPU) and belongs in a separate e2e/integration suite that
we gate behind a marker.
"""

from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient

from opengeo_extractor.app import app


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def test_healthz_returns_ok(client: TestClient) -> None:
    response = client.get("/healthz")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["model"] == "samgeo-langsam-v1"
    assert "version" in body


def test_extract_rejects_non_text_prompts(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Clear token so auth doesn't intercept before we reach validation.
    monkeypatch.delenv("OPENGEO_EXTRACTOR_TOKEN", raising=False)
    response = client.post(
        "/extract",
        json={
            "orthomosaicId": "id-1",
            "cogUrl": "https://example.invalid/ortho.tif",
            "prompt": "buildings",
            "prompts": [{"kind": "point", "lng": -121, "lat": 39}],
        },
    )
    assert response.status_code == 422
    assert "text-only" in response.json()["detail"].lower()


def test_extract_requires_bearer_when_token_set(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OPENGEO_EXTRACTOR_TOKEN", "secret-for-test")
    response = client.post(
        "/extract",
        json={
            "orthomosaicId": "id-1",
            "cogUrl": "https://example.invalid/ortho.tif",
            "prompt": "buildings",
        },
    )
    assert response.status_code == 401


def test_extract_accepts_valid_bearer(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OPENGEO_EXTRACTOR_TOKEN", "secret-for-test")
    # Using the unsupported-prompt path to confirm auth passed without
    # actually kicking off inference. 422 beats 401.
    response = client.post(
        "/extract",
        headers={"Authorization": "Bearer secret-for-test"},
        json={
            "orthomosaicId": "id-1",
            "cogUrl": "https://example.invalid/ortho.tif",
            "prompt": "buildings",
            "prompts": [{"kind": "bbox", "bbox": [0, 0, 1, 1]}],
        },
    )
    assert response.status_code == 422


def test_extract_rejects_malformed_payload(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("OPENGEO_EXTRACTOR_TOKEN", raising=False)
    response = client.post("/extract", json={"orthomosaicId": "id-1"})
    assert response.status_code == 422
