"""Phase 4C — Scotland rule definition (pure data + Mongo-filter helper).

Extracted from ``scotland_routes`` so the CQC router + territory
router can import without triggering a circular import.
"""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field


DEFAULT_DEFINITION_ID = "scotland-default"


class ScotlandDefinition(BaseModel):
    """Single rule selecting which Scottish services count as a 'home'."""

    include_care_services: list[str] = Field(default_factory=list)
    exclude_care_services: list[str] = Field(default_factory=list)
    include_subtypes: list[str] = Field(default_factory=list)
    exclude_subtypes: list[str] = Field(default_factory=list)
    include_client_groups: list[str] = Field(default_factory=list)
    statuses: list[str] = Field(default_factory=lambda: ["Active"])
    min_beds: Optional[int] = None
    min_grade: Optional[int] = None
    require_main_area_care_home: bool = False


def definition_to_mongo_filter(d: ScotlandDefinition) -> dict:
    has_inclusion = bool(
        d.include_care_services
        or d.include_subtypes
        or d.include_client_groups
        or d.min_beds
        or d.min_grade
        or d.require_main_area_care_home
    )
    if not has_inclusion:
        return {"_no_rule_defined": True}
    f: dict = {}
    if d.statuses:
        f["serviceStatus"] = {"$in": d.statuses}
    if d.include_care_services:
        f["careService"] = {"$in": d.include_care_services}
    if d.exclude_care_services:
        f.setdefault("careService", {})
        f["careService"]["$nin"] = d.exclude_care_services
    if d.include_subtypes:
        f["subtype"] = {"$in": d.include_subtypes}
    if d.exclude_subtypes:
        f.setdefault("subtype", {})
        f["subtype"]["$nin"] = d.exclude_subtypes
    if d.include_client_groups:
        f["clientGroup"] = {"$in": d.include_client_groups}
    if d.min_beds:
        f["totalBeds"] = {"$gte": d.min_beds}
    if d.min_grade:
        f["minGrade"] = {"$gte": d.min_grade}
    if d.require_main_area_care_home:
        f["careHomeMainArea"] = {"$ne": ""}
    return f
