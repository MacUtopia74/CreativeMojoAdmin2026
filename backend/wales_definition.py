"""Care Inspectorate Wales (CIW) rule definition — pure data + Mongo-filter helper.

Mirrors ``ni_definition`` / ``scotland_definition`` / ``cqc_definition`` so
Territory Builder and the rest of the platform can treat Welsh services
identically to CQC / Scotland / NI data.
"""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field


DEFAULT_DEFINITION_ID = "wales-default"


class WalesDefinition(BaseModel):
    """Single rule selecting which CIW services count as a 'home'.

    The CIW dataset is mostly already filtered at import-time to
    ``Service Type == "Care Home Service"`` (per the product spec), but
    we still expose the same chip-based admin facets so subsets like
    "Adults Without Nursing" can be carved out.
    """

    include_service_types: list[str] = Field(default_factory=list)
    exclude_service_types: list[str] = Field(default_factory=list)
    include_subtypes: list[str] = Field(default_factory=list)
    exclude_subtypes: list[str] = Field(default_factory=list)
    include_categories: list[str] = Field(default_factory=list)
    exclude_categories: list[str] = Field(default_factory=list)
    include_providers: list[str] = Field(default_factory=list)
    min_places: Optional[int] = None
    # When True, ``active: false`` records (URNs no longer in the source
    # CSV) are excluded from territory queries. Default False — per spec
    # they remain visible (dimmed) as "recently closed".
    hide_inactive: bool = False


def definition_to_mongo_filter(d: WalesDefinition) -> dict:
    has_inclusion = bool(
        d.include_service_types
        or d.include_subtypes
        or d.include_categories
        or d.include_providers
        or d.min_places
    )
    if not has_inclusion:
        # No rule yet — return a sentinel that matches nothing so the
        # territory counter doesn't accidentally include the whole 1,461
        # rows on first install.
        return {"_no_rule_defined": True}
    f: dict = {}
    if d.include_service_types:
        f["serviceType"] = {"$in": d.include_service_types}
    if d.exclude_service_types:
        f.setdefault("serviceType", {})
        f["serviceType"]["$nin"] = d.exclude_service_types
    if d.include_subtypes:
        f["serviceSubType"] = {"$in": d.include_subtypes}
    if d.exclude_subtypes:
        f.setdefault("serviceSubType", {})
        f["serviceSubType"]["$nin"] = d.exclude_subtypes
    if d.include_categories:
        # ``categoriesOfCare`` stored as a list per row — ``$in`` against
        # an array field overlaps on any element.
        f["categoriesOfCare"] = {"$in": d.include_categories}
    if d.exclude_categories:
        f.setdefault("categoriesOfCare", {})
        f["categoriesOfCare"]["$nin"] = d.exclude_categories
    if d.include_providers:
        f["provider"] = {"$in": d.include_providers}
    if d.min_places:
        f["maxApprovedPlaces"] = {"$gte": d.min_places}
    if d.hide_inactive:
        f["active"] = {"$ne": False}
    return f
