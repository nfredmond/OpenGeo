"""Request / response schema.

Wire format is camelCase to match the TypeScript `ExtractionInput` /
`ExtractionResult` types on the Next.js side. Pydantic `alias_generator`
handles the translation so Python code can use snake_case internally.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

_camel_config = ConfigDict(
    alias_generator=to_camel,
    populate_by_name=True,
    extra="forbid",
)


class ExtractionPromptText(BaseModel):
    model_config = _camel_config
    kind: str = Field(pattern="^text$")
    text: str


class ExtractionPromptPoint(BaseModel):
    model_config = _camel_config
    kind: str = Field(pattern="^point$")
    lng: float
    lat: float
    label: str | None = None  # "include" | "exclude"


class ExtractionPromptBbox(BaseModel):
    model_config = _camel_config
    kind: str = Field(pattern="^bbox$")
    bbox: tuple[float, float, float, float]


ExtractionPrompt = ExtractionPromptText | ExtractionPromptPoint | ExtractionPromptBbox


class ExtractionInput(BaseModel):
    model_config = _camel_config

    orthomosaic_id: str
    cog_url: str
    prompt: str
    prompts: list[ExtractionPrompt] | None = None
    bbox: tuple[float, float, float, float] | None = None


class ExtractionMetrics(BaseModel):
    model_config = _camel_config

    model: str
    latency_ms: int
    feature_count: int
    extras: dict | None = None


class ExtractionResult(BaseModel):
    model_config = _camel_config

    feature_collection: dict  # Raw GeoJSON FeatureCollection
    metrics: ExtractionMetrics


class HealthResponse(BaseModel):
    status: str
    version: str
    model: str
    weights_loaded: bool


class ErrorResponse(BaseModel):
    error: str
    detail: str | None = None
