"""Phase 4B — CQC rule definition (pure data + Mongo-filter helper).

Extracted from ``cqc_routes`` so both router modules (and
``territory_routes``) can import the rule without pulling in the
FastAPI router build. Eliminates the cqc_routes ↔ scotland_routes
circular import the static analyser flagged: those modules now both
depend on this leaf module, not on each other.
"""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field


DEFAULT_DEFINITION_ID = "system-default"


class CqcDefinition(BaseModel):
    """The single rule that drives every home count in the system."""

    include_service_types: list[str] = Field(default_factory=list)
    exclude_service_types: list[str] = Field(default_factory=list)
    include_specialisms: list[str] = Field(default_factory=list)
    exclude_specialisms: list[str] = Field(default_factory=list)
    include_regulated_activities: list[str] = Field(default_factory=list)
    require_care_home: Optional[str] = None  # "Y" / "N" / None (either)
    registration_statuses: list[str] = Field(default_factory=lambda: ["Registered"])
    min_beds: Optional[int] = None
    require_rating: list[str] = Field(default_factory=list)  # ["Good","Outstanding"]


def definition_to_mongo_filter(d: CqcDefinition) -> dict:
    """Translates the rule into a MongoDB filter on ``cqc_locations_live``.

    If the admin hasn't set ANY positive inclusion criterion we return an
    impossible filter so the count is 0. Otherwise an unconfigured page
    would silently match every Registered CQC location (~120k incl.
    dentists, GPs, ambulances) — confusing for the territory counters.
    """
    has_inclusion = bool(
        d.include_service_types
        or d.include_specialisms
        or d.include_regulated_activities
        or d.require_care_home
        or d.min_beds
        or d.require_rating
    )
    if not has_inclusion:
        return {"_no_rule_defined": True}  # matches nothing
    f: dict = {}
    if d.registration_statuses:
        f["registrationStatus"] = {"$in": d.registration_statuses}
    if d.require_care_home in ("Y", "N"):
        f["careHome"] = d.require_care_home
    if d.include_service_types:
        f["gacServiceTypes.name"] = {"$in": d.include_service_types}
    if d.exclude_service_types:
        f.setdefault("gacServiceTypes.name", {})
        f["gacServiceTypes.name"]["$nin"] = d.exclude_service_types
    if d.include_specialisms:
        f["specialisms.name"] = {"$in": d.include_specialisms}
    if d.exclude_specialisms:
        f.setdefault("specialisms.name", {})
        f["specialisms.name"]["$nin"] = d.exclude_specialisms
    if d.include_regulated_activities:
        f["regulatedActivities.name"] = {"$in": d.include_regulated_activities}
    if d.min_beds:
        f["numberOfBeds"] = {"$gte": d.min_beds}
    if d.require_rating:
        f["currentRatings.overall.rating"] = {"$in": d.require_rating}
    return f
