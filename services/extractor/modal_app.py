"""Modal wrapper for the extractor.

Deploy with:
    modal deploy modal_app.py

That creates an auto-scaling GPU endpoint at a Modal-generated URL. Set
the URL + token in your Vercel env as OPENGEO_EXTRACTOR_URL and
OPENGEO_EXTRACTOR_TOKEN, then set OPENGEO_EXTRACTOR=http on the Next.js
side. The Next.js HttpExtractor will POST to /extract on the Modal
function's public URL.

Weights are baked into the image layer cache at build time by cloning
R2 with awscli on first build; subsequent deploys pull from layer cache.
"""

from __future__ import annotations

import os

import modal  # type: ignore[import-not-found]

GPU_KIND = os.environ.get("OPENGEO_MODAL_GPU", "a10g")  # "a10g" | "l4" | "h100"
VOLUME_NAME = "opengeo-extractor-weights"
WEIGHTS_DIR = "/weights"

image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install(
        "build-essential",
        "git",
        "libgdal-dev",
        "gdal-bin",
        "libgeos-dev",
        "libproj-dev",
    )
    .pip_install_from_pyproject("pyproject.toml", optional_dependencies=["modal"])
    .env(
        {
            "OPENGEO_DEVICE": "cuda",
            "TORCH_HOME": WEIGHTS_DIR,
            "HF_HOME": WEIGHTS_DIR,
        }
    )
    .add_local_python_source("opengeo_extractor")
)

weights_volume = modal.Volume.from_name(VOLUME_NAME, create_if_missing=True)

stub = modal.App("opengeo-extractor")


@stub.function(
    image=image,
    gpu=GPU_KIND,
    timeout=600,
    min_containers=0,
    volumes={WEIGHTS_DIR: weights_volume},
    secrets=[modal.Secret.from_name("opengeo-extractor")],
)
@modal.asgi_app()
def fastapi_app():
    from opengeo_extractor.app import app

    return app
