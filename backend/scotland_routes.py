"""Phase 4C — Scottish Care Inspectorate data (no API, CSV-driven).

The Care Inspectorate publishes a quarterly "Datastore" CSV — there is
no live API. This module mirrors the shape of ``cqc_routes`` so the rest
of the platform (Territory Builder, Find-a-Class, franchisee map) can
treat Scottish data identically to English/Welsh CQC data.

Collections:
  • ``scotland_care_services``       — one document per CSNumber.
  • ``scotland_definition``          — single "which services count" rule.
  • ``scotland_import_state``        — last-import metadata.

Endpoints (admin only):
  • GET  /api/scotland/definition
  • PUT  /api/scotland/definition
  • GET  /api/scotland/definition/preview
  • GET  /api/scotland/distinct?field=...
  • POST /api/scotland/import        — multipart CSV upload
  • GET  /api/scotland/import/status — last upload meta + row count

Postcode sector is derived using the same ``_POSTCODE_RE`` used by the
CQC importer, so Scottish + English data live in the same sector
namespace and the existing ``postcode_sector_polygons`` collection
covers both.
"""
from __future__ import annotations

import csv
import io
import logging
import re
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File
from pydantic import BaseModel, Field

from geo_postcode import is_scottish_postcode, SCOTTISH_PREFIXES  # noqa: F401  re-exported for back-compat

logger = logging.getLogger("creative-mojo-admin.scotland")

DEFAULT_DEFINITION_ID = "scotland-default"
_POSTCODE_RE = re.compile(r"^\s*([A-Z]{1,2}\d[A-Z\d]?)\s*(\d)([A-Z]{2})\s*$", re.I)


def parse_sector(raw: Optional[str]) -> Optional[str]:
    if not raw:
        return None
    m = _POSTCODE_RE.match(str(raw).upper())
    if not m:
        return None
    return f"{m.group(1)} {m.group(2)}"


def parse_district(raw: Optional[str]) -> Optional[str]:
    if not raw:
        return None
    m = _POSTCODE_RE.match(str(raw).upper())
    if not m:
        return None
    return m.group(1)


# ----------------------------------------------------------- CSV → document
def _row_to_doc(row: dict) -> Optional[dict]:
    """Project one CSV row into the persisted Scotland service shape.
    Returns None for rows missing the CSNumber key — they're noise."""
    cs = (row.get("CSNumber") or "").strip()
    if not cs:
        return None
    pc_raw = (row.get("Service_Postcode") or "").strip()
    sector = parse_sector(pc_raw)
    district = parse_district(pc_raw)

    def _int(v):
        s = (v or "").strip()
        if not s:
            return None
        try:
            return int(float(s))
        except (TypeError, ValueError):
            return None

    return {
        "csNumber": cs,
        "name": (row.get("ServiceName") or "").strip(),
        "careService": (row.get("CareService") or "").strip(),
        "subtype": (row.get("Subtype") or "").strip(),
        "additionalSubtypes": (row.get("AdditionalSubtypes") or "").strip(),
        "serviceType": (row.get("ServiceType") or "").strip(),
        "serviceProvider": (row.get("ServiceProvider") or "").strip(),
        "serviceStatus": (row.get("ServiceStatus") or "").strip(),
        "managerName": (row.get("Manager_Name") or "").strip(),
        "phone": (row.get("Service_Phone_Number") or "").strip(),
        "email": (row.get("Eforms_email_address") or "").strip(),
        "addressLines": [
            (row.get("Address_line_1") or "").strip(),
            (row.get("Address_line_2") or "").strip(),
            (row.get("Address_line_3") or "").strip(),
            (row.get("Address_line_4") or "").strip(),
        ],
        "town": (row.get("Service_town") or "").strip(),
        "postalCode": pc_raw,
        "postcode_sector": sector,
        "postcode_district": district,
        "councilArea": (row.get("Council_Area_Name") or "").strip(),
        "healthBoard": (row.get("Health_Board_Name") or "").strip(),
        "integrationAuthority": (row.get("Integration_Authority_Name") or "").strip(),
        "numberStaff": (row.get("NumberStaff") or "").strip(),
        "registeredPlaces": _int(row.get("Registered_Places")),
        "totalBeds": _int(row.get("TotalBeds")),
        "clientGroup": (row.get("Client_group") or "").strip(),
        "publicList": (row.get("PublicList") or "").strip(),
        "careHomeMainArea": (row.get("CareHome_Main_Area_of_Care") or "").strip(),
        "minGrade": _int(row.get("MinGrade")),
        "maxGrade": _int(row.get("MaxGrade")),
        "gradeSpread": (row.get("GradeSpread") or "").strip(),
        "latestGradePublished": (row.get("Publication_of_Latest_Grading") or "").strip(),
        "lastInspectionDate": (row.get("Last_inspection_Date") or "").strip(),
        "country": "Scotland",
    }


# -------------------------------------------------------------- definitions
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


# ----------------------------------------------------------------- router
def build_scotland_router(db, require_role):  # noqa: D401
    router = APIRouter()

    async def _get_def() -> ScotlandDefinition:
        doc = await db.scotland_definition.find_one({"_id": DEFAULT_DEFINITION_ID}, {"_id": 0})
        if not doc:
            return ScotlandDefinition()
        return ScotlandDefinition(**doc)

    @router.get("/scotland/definition")
    async def get_definition(_user: dict = Depends(require_role("admin"))):
        d = await _get_def()
        return d.model_dump()

    @router.put("/scotland/definition")
    async def put_definition(body: ScotlandDefinition, user: dict = Depends(require_role("admin"))):
        doc = body.model_dump()
        doc.update({
            "_id": DEFAULT_DEFINITION_ID,
            "updated_at": datetime.now(timezone.utc),
            "updated_by": user.get("email"),
        })
        await db.scotland_definition.update_one(
            {"_id": DEFAULT_DEFINITION_ID}, {"$set": doc}, upsert=True,
        )
        # Re-count every Scottish franchisee + Scottish saved plan so any
        # change to the rule flows through to the dashboard pills.
        franchisees_updated = 0
        cur = db.franchisees.find(
            {"territory_sectors": {"$exists": True, "$ne": []}},
            {"_id": 0, "id": 1, "territory_sectors": 1, "territory_home_count": 1, "postcode": 1},
        )
        async for f in cur:
            scot_sectors = [s for s in (f.get("territory_sectors") or []) if is_scottish_postcode(s)]
            if not scot_sectors:
                continue
            cnt = await db.scotland_care_services.count_documents({
                **definition_to_mongo_filter(body),
                "postcode_sector": {"$in": scot_sectors},
            })
            # We only own the Scottish portion of the count here. Add the
            # English/Welsh portion (already on the doc) so franchisees
            # straddling the border keep their full number. The CQC import
            # is kept *lazy* because the recount cycle is the only
            # cross-router call site — full top-level cycle is avoided by
            # ``geo_postcode`` carrying the shared classifier.
            from cqc_routes import CqcDefinition, definition_to_mongo_filter as _cqc_f
            cqc_doc = await db.cqc_definition.find_one({"_id": "system-default"}, {"_id": 0})
            cqc_def = CqcDefinition(**cqc_doc) if cqc_doc else CqcDefinition()
            eng_sectors = [s for s in (f.get("territory_sectors") or []) if not is_scottish_postcode(s)]
            eng_cnt = 0
            if eng_sectors:
                eng_cnt = await db.cqc_locations_live.count_documents({
                    **_cqc_f(cqc_def), "postcode_sector": {"$in": eng_sectors},
                })
                if eng_cnt == 0:
                    eng_cnt = await db.cqc_locations.count_documents({
                        **_cqc_f(cqc_def), "postcode_sector": {"$in": eng_sectors},
                    })
            await db.franchisees.update_one({"id": f["id"]}, {"$set": {"territory_home_count": cnt + eng_cnt}})
            franchisees_updated += 1
        return {**body.model_dump(), "_recount": {"franchisees_updated": franchisees_updated}}

    @router.get("/scotland/definition/preview")
    async def preview_definition(
        include_care_services: Optional[str] = Query(None),
        exclude_care_services: Optional[str] = Query(None),
        include_subtypes: Optional[str] = Query(None),
        exclude_subtypes: Optional[str] = Query(None),
        include_client_groups: Optional[str] = Query(None),
        statuses: Optional[str] = Query(None),
        min_beds: Optional[str] = Query(None),
        min_grade: Optional[str] = Query(None),
        require_main_area_care_home: Optional[bool] = Query(False),
        _user: dict = Depends(require_role("admin")),
    ):
        def split(v):
            return [x.strip() for x in (v or "").split(",") if x.strip()]

        def _opt_int(v):
            try:
                return int(v) if v and str(v).strip() else None
            except (TypeError, ValueError):
                return None

        d = ScotlandDefinition(
            include_care_services=split(include_care_services),
            exclude_care_services=split(exclude_care_services),
            include_subtypes=split(include_subtypes),
            exclude_subtypes=split(exclude_subtypes),
            include_client_groups=split(include_client_groups),
            statuses=split(statuses) or ["Active"],
            min_beds=_opt_int(min_beds),
            min_grade=_opt_int(min_grade),
            require_main_area_care_home=bool(require_main_area_care_home),
        )
        f = definition_to_mongo_filter(d)
        count = await db.scotland_care_services.count_documents(f)
        by_council = await db.scotland_care_services.aggregate([
            {"$match": f},
            {"$group": {"_id": "$councilArea", "n": {"$sum": 1}}},
            {"$sort": {"n": -1}},
            {"$limit": 12},
        ]).to_list(12)
        sample = await db.scotland_care_services.find(
            f,
            {
                "_id": 0, "csNumber": 1, "name": 1, "postalCode": 1, "town": 1,
                "careService": 1, "subtype": 1, "totalBeds": 1, "clientGroup": 1,
                "minGrade": 1, "maxGrade": 1, "councilArea": 1,
            },
        ).limit(8).to_list(8)
        return {"count": count, "by_council": by_council, "sample": sample}

    @router.get("/scotland/distinct")
    async def distinct_values(
        field: str = Query(..., description="careService | subtype | clientGroup | councilArea | serviceStatus"),
        _user: dict = Depends(require_role("admin")),
    ):
        allowed = {"careService", "subtype", "clientGroup", "councilArea", "serviceStatus"}
        if field not in allowed:
            raise HTTPException(400, detail="Invalid field")
        # Mirror the CQC pattern — restrict the chip counts to the same
        # baseline the preview uses (Active services only).
        base = {"serviceStatus": "Active"}
        pipeline = [
            {"$match": base},
            {"$group": {"_id": f"${field}", "n": {"$sum": 1}}},
            {"$sort": {"n": -1}},
            {"$limit": 200},
        ]
        rows = await db.scotland_care_services.aggregate(pipeline).to_list(500)
        return {"values": [{"value": r["_id"], "count": r["n"]} for r in rows if r["_id"]]}

    @router.post("/scotland/import")
    async def import_csv(
        file: UploadFile = File(...),
        user: dict = Depends(require_role("admin")),
    ):
        """Wipe + reload the ``scotland_care_services`` collection from a
        Care Inspectorate Datastore CSV. The upload is atomic — we read
        the entire file into memory, parse all rows, then replace the
        collection in one go. Typical CSV is ~10k rows / 4MB, so this
        comfortably fits."""
        if not file.filename or not file.filename.lower().endswith(".csv"):
            raise HTTPException(400, detail="Please upload a .csv file")
        raw = await file.read()
        text = None
        for enc in ("utf-8-sig", "utf-8", "latin-1"):
            try:
                text = raw.decode(enc)
                break
            except UnicodeDecodeError:
                continue
        if text is None:
            raise HTTPException(400, detail="Could not decode CSV (try saving as UTF-8)")
        reader = csv.DictReader(io.StringIO(text))
        docs: list[dict] = []
        skipped = 0
        for row in reader:
            d = _row_to_doc(row)
            if d is None:
                skipped += 1
                continue
            docs.append(d)
        if not docs:
            raise HTTPException(400, detail="No usable rows found — does the CSV have a CSNumber column?")

        # Replace existing dataset in a fresh collection then atomically swap.
        await db.scotland_care_services_tmp.drop()
        # MongoDB has a 100k document insert_many limit per call; chunk it.
        CHUNK = 5000
        for i in range(0, len(docs), CHUNK):
            await db.scotland_care_services_tmp.insert_many(docs[i:i + CHUNK])
        # Indexes used by lookups
        await db.scotland_care_services_tmp.create_index("csNumber", unique=True)
        await db.scotland_care_services_tmp.create_index("postcode_sector")
        await db.scotland_care_services_tmp.create_index("careService")
        await db.scotland_care_services_tmp.create_index("subtype")
        await db.scotland_care_services_tmp.create_index("clientGroup")
        await db.scotland_care_services_tmp.create_index("councilArea")
        await db.scotland_care_services_tmp.create_index("serviceStatus")
        # Atomic swap: drop old, rename tmp into place
        await db.scotland_care_services.drop()
        await db.scotland_care_services_tmp.rename("scotland_care_services")

        meta = {
            "_id": "last_import",
            "filename": file.filename,
            "imported_at": datetime.now(timezone.utc),
            "imported_by": user.get("email"),
            "rows_loaded": len(docs),
            "rows_skipped": skipped,
        }
        await db.scotland_import_state.update_one({"_id": "last_import"}, {"$set": meta}, upsert=True)
        return {
            "ok": True,
            "rows_loaded": len(docs),
            "rows_skipped": skipped,
            "filename": file.filename,
        }

    @router.get("/scotland/import/status")
    async def import_status(_user: dict = Depends(require_role("admin"))):
        last = await db.scotland_import_state.find_one({"_id": "last_import"}, {"_id": 0})
        live_count = await db.scotland_care_services.count_documents({})
        return {"live_count": live_count, "last_import": last}

    return router
