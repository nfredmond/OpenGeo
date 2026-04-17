#!/usr/bin/env python3
"""Sync SAM + GroundingDINO weights from the upstream sources to R2.

One-shot bootstrap. Runs once per model release; after that, Modal image
builds pull from R2 rather than from Meta's CDN or the HuggingFace hub.
See ADR-002 §4 for rationale.

Usage:
    python scripts/sync_weights.py

Environment:
    R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
"""

from __future__ import annotations

import hashlib
import os
import sys
from pathlib import Path
from urllib.request import urlopen

import boto3  # type: ignore[import-not-found]

# SAM ViT-H (default for samgeo).
SAM_URL = "https://dl.fbaipublicfiles.com/segment_anything/sam_vit_h_4b8939.pth"
SAM_DEST = "models/sam/vit_h.pth"

# GroundingDINO SwinT OGC (samgeo's LangSAM default).
GDINO_URL = (
    "https://github.com/IDEA-Research/GroundingDINO/releases/download/v0.1.0-alpha/"
    "groundingdino_swint_ogc.pth"
)
GDINO_DEST = "models/groundingdino/swint_ogc.pth"


def download(url: str, local_path: Path) -> Path:
    if local_path.exists():
        print(f"[skip] {local_path} already present")
        return local_path
    local_path.parent.mkdir(parents=True, exist_ok=True)
    print(f"[get]  {url}")
    with urlopen(url) as response, local_path.open("wb") as fh:
        while chunk := response.read(1024 * 1024):
            fh.write(chunk)
    return local_path


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        while chunk := fh.read(1024 * 1024):
            h.update(chunk)
    return h.hexdigest()


def upload_to_r2(local: Path, key: str) -> None:
    account = os.environ["R2_ACCOUNT_ID"]
    bucket = os.environ["R2_BUCKET"]
    endpoint = f"https://{account}.r2.cloudflarestorage.com"
    s3 = boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )
    print(f"[put]  r2://{bucket}/{key}  ({local.stat().st_size // (1024 * 1024)} MB)")
    s3.upload_file(str(local), bucket, key)


def main() -> int:
    required = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]
    missing = [k for k in required if not os.environ.get(k)]
    if missing:
        print(f"Missing env vars: {', '.join(missing)}")
        return 1

    cache = Path(os.environ.get("OPENGEO_WEIGHT_CACHE", "./.weights"))
    cache.mkdir(parents=True, exist_ok=True)

    sam_local = download(SAM_URL, cache / "sam_vit_h.pth")
    print(f"       sha256 {sha256(sam_local)}")
    upload_to_r2(sam_local, SAM_DEST)

    gdino_local = download(GDINO_URL, cache / "groundingdino_swint_ogc.pth")
    print(f"       sha256 {sha256(gdino_local)}")
    upload_to_r2(gdino_local, GDINO_DEST)

    print("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
