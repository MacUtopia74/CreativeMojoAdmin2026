"""Northern Ireland (RQIA) rule definition — pure data + Mongo-filter helper.

Mirrors ``scotland_definition`` / ``cqc_definition`` so Territory Builder
and the rest of the platform can treat NI services identically to CQC /
Scotland data.
"""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field


DEFAULT_DEFINITION_ID = "ni-default"


class NiDefinition(BaseModel):
    """Single rule selecting which RQIA services count as a 'home'."""

    include_service_types: list[str] = Field(default_factory=list)
    exclude_service_types: list[str] = Field(default_factory=list)
    include_categories: list[str] = Field(default_factory=list)
    exclude_categories: list[str] = Field(default_factory=list)
    include_providers: list[str] = Field(default_factory=list)
    min_places: Optional[int] = None


def definition_to_mongo_filter(d: NiDefinition) -> dict:
    has_inclusion = bool(
        d.include_service_types
        or d.include_categories
        or d.include_providers
        or d.min_places
    )
    if not has_inclusion:
        return {"_no_rule_defined": True}
    f: dict = {}
    if d.include_service_types:
        f["serviceType"] = {"$in": d.include_service_types}
    if d.exclude_service_types:
        f.setdefault("serviceType", {})
        f["serviceType"]["$nin"] = d.exclude_service_types
    if d.include_categories:
        # Categories live as a list per row (multi-value field) — `$in`
        # against an array field matches docs where any element overlaps.
        f["categoriesOfCare"] = {"$in": d.include_categories}
    if d.exclude_categories:
        f.setdefault("categoriesOfCare", {})
        f["categoriesOfCare"]["$nin"] = d.exclude_categories
    if d.include_providers:
        f["provider"] = {"$in": d.include_providers}
    if d.min_places:
        f["maxApprovedPlaces"] = {"$gte": d.min_places}
    return f
