"""Care Inspectorate Wales (CIW) Registered Services — CSV upload.

CIW publishes a ~5,000 row CSV of every regulated service in Wales.
This module mirrors ``ni_routes`` but with three deliberate deviations
driven by the product brief:

  1. **CSV** (not XLSX). CIW only publishes CSV.
  2. **Incremental upsert by Service URN** — never a full collection
     swap. The user explicitly wants closed homes to remain visible
     (greyed-out as "recently closed") rather than disappear.
  3. **No polygon importer**. Welsh sectors (CF/SA/LL/NP/LD plus
     border sectors SY/HR/CH) are already covered by the whole-UK
     Doogal KML import. Territory mapping uses postcode sectors only,
     per the brief.

Collections written:
  • ``wales_care_services``    — one document per Service URN.
  • ``wales_definition``       — single "which services count" rule.
  • ``wales_import_state``     — last-import metadata + history.

Endpoints (admin only):
  • GET  /api/wales/definition
  • PUT  /api/wales/definition
  • GET  /api/wales/definition/preview
  • GET  /api/wales/distinct?field=...
  • POST /api/wales/import         — multipart CSV upload
  • GET  /api/wales/import/status
"""
from __future__ import annotations

import csv
import io
import logging
import re
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File

from care_group_normaliser import normalise_provider_name
from wales_definition import (
    DEFAULT_DEFINITION_ID,
    WalesDefinition,
    definition_to_mongo_filter,
)

logger = logging.getLogger("creative-mojo-admin.wales")

_POSTCODE_RE = re.compile(r"^\s*([A-Z]{1,2}\d[A-Z\d]?)\s*(\d)([A-Z]{2})\s*$", re.I)

# Service types we keep. CIW also publishes childcare, fostering,
# adoption etc. — none of which are useful for the franchise network.
KEEP_SERVICE_TYPE = "Care Home Service"


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


def _clean(v) -> str:
    if v is None:
        return ""
    return str(v).replace("\xa0", " ").strip()


def _split_provisions(raw: str) -> list[str]:
    """CIW's 'Provision For' column is comma-separated free text, e.g.
    ``"Personal care for adults, Learning disability, Mental health"``.

    Some operators use semicolons. Normalise both → single list."""
    if not raw:
        return []
    parts = re.split(r"[\n;,]+", raw)
    return [p.strip() for p in parts if p.strip()]


def _parse_int(v) -> Optional[int]:
    try:
        return int(float(v)) if v not in (None, "", " ") else None
    except (TypeError, ValueError):
        return None


def _row_to_doc(row: dict) -> Optional[dict]:
    """Project one CIW CSV row → persisted document.

    Returns None when the row should be skipped (wrong service type or
    missing URN). The header lookup is exact-match because the user
    has confirmed the CIW export format is stable.
    """
    service_type = _clean(row.get("Service Type"))
    if service_type != KEEP_SERVICE_TYPE:
        return None

    urn = _clean(row.get("Service URN"))
    if not urn:
        return None

    pc = _clean(row.get("Service Postcode")).upper()
    sector = parse_sector(pc)
    district = parse_district(pc)

    provider_name = _clean(row.get("Provider Name"))
    provider_urn = _clean(row.get("Provider URN"))

    address_lines = [
        _clean(row.get("Service Address Line 1")),
        _clean(row.get("Service Address Line 2")),
        _clean(row.get("Service Address Line 3")),
    ]

    return {
        "serviceUrn": urn,
        "name": _clean(row.get("Service Name")) or urn,
        "knownAs": _clean(row.get("Known as")),
        "serviceType": service_type,
        "serviceSubType": _clean(row.get("Service Sub-Type")),
        "categoriesOfCare": _split_provisions(_clean(row.get("Provision For"))),
        "addressLines": [a for a in address_lines if a],
        "town": _clean(row.get("Service Town/City")),
        "postalCode": pc,
        "postcode_sector": sector,
        "postcode_district": district,
        "localAuthority": _clean(row.get("Local Authority")),
        "phone": _clean(row.get("Primary telephone number")),
        "email": _clean(row.get("Primary email address")),
        "website": _clean(row.get("Website")),
        "maxApprovedPlaces": _parse_int(row.get("Maximum No. of Places")),
        "ratingsText": _clean(row.get("Service Ratings")),
        "responsibleIndividual": _clean(row.get("Responsible Individual Names")),
        "registeredPersons": _clean(row.get("Registered Person Names")),
        "providerUrn": provider_urn,
        "provider": provider_name,
        "providerNameKey": normalise_provider_name(provider_name),
        "providerType": _clean(row.get("Provider Type")),
        "providerCompanyNumber": _clean(row.get("Company Number")),
        "providerWebsite": _clean(row.get("Provider Website")),
        "lastUpdatedOn": _clean(row.get("Last Updated On")),
        "country": "Wales",
    }


def _parse_csv_bytes(raw: bytes) -> tuple[list[dict], int, int]:
    """Read CSV bytes → (docs, skipped_wrong_type, skipped_blank).

    Memory is fine — CIW dataset is ~5k rows / 6MB.
    """
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw.decode("latin-1")
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames or "Service URN" not in reader.fieldnames:
        raise HTTPException(
            400,
            detail=(
                "CSV doesn't look like the CIW Registered Services export — "
                "expected a 'Service URN' column."
            ),
        )
    docs: list[dict] = []
    skipped_wrong_type = 0
    skipped_blank = 0
    for row in reader:
        # Reject rows where everything is blank (some CSVs have trailing
        # noise rows).
        if not any((row.get(k) or "").strip() for k in reader.fieldnames):
            skipped_blank += 1
            continue
        d = _row_to_doc(row)
        if d is None:
            skipped_wrong_type += 1
            continue
        docs.append(d)
    return docs, skipped_wrong_type, skipped_blank


async def _upsert_incremental(db, docs: list[dict], imported_by: str, filename: str) -> dict:
    """Upsert each doc by ``serviceUrn`` and flag missing URNs inactive.

    Strategy:
      • For each parsed doc: ``$set`` business fields + ``active=True``
        + ``last_seen_at`` + ``last_seen_filename``. If new → also set
        ``first_seen_at`` + ``first_seen_filename``.
      • After the upsert pass: every URN that was previously ``active``
        but didn't appear in this CSV → ``active=False`` +
        ``inactive_since`` timestamp. Re-runs that include a previously
        inactive URN flip it back to active automatically.

    Indexes are created idempotently on first run.
    """
    coll = db.wales_care_services

    # Idempotent index setup. ``serviceUrn`` is the natural unique key.
    await coll.create_index("serviceUrn", unique=True)
    await coll.create_index("postcode_sector")
    await coll.create_index("provider")
    await coll.create_index("providerNameKey")
    await coll.create_index("serviceSubType")
    await coll.create_index("active")
    await coll.create_index("localAuthority")
    await coll.create_index("town")

    now = datetime.now(timezone.utc)
    now_iso = now.isoformat()
    seen_urns = [d["serviceUrn"] for d in docs]

    # Pre-fetch which URNs already exist so we can split insert vs update
    # counts honestly + only set ``first_seen_at`` on the truly new ones.
    existing_urns: set[str] = set()
    cur = coll.find(
        {"serviceUrn": {"$in": seen_urns}},
        {"_id": 0, "serviceUrn": 1},
    )
    async for d in cur:
        existing_urns.add(d["serviceUrn"])

    # Bulk upsert in chunks of 1000 — single round-trip per chunk is the
    # sweet spot for motor against this dataset size.
    from pymongo import UpdateOne

    CHUNK = 1000
    inserted = 0
    updated = 0
    reactivated = 0
    # Track URNs that were inactive coming in and present in this CSV —
    # i.e. they're being re-activated. Done in a single pre-query to
    # keep the per-doc cost flat.
    inactive_cur = coll.find(
        {"serviceUrn": {"$in": seen_urns}, "active": False},
        {"_id": 0, "serviceUrn": 1},
    )
    inactive_urns: set[str] = set()
    async for d in inactive_cur:
        inactive_urns.add(d["serviceUrn"])
    reactivated = len(inactive_urns)

    for i in range(0, len(docs), CHUNK):
        ops = []
        chunk = docs[i:i + CHUNK]
        for d in chunk:
            urn = d["serviceUrn"]
            set_fields = {
                **d,
                "active": True,
                "last_seen_at": now_iso,
                "last_seen_filename": filename,
                # Once inactive → active again, clear the closed-timestamp.
                "inactive_since": None,
            }
            on_insert = {
                "first_seen_at": now_iso,
                "first_seen_filename": filename,
            }
            ops.append(
                UpdateOne(
                    {"serviceUrn": urn},
                    {"$set": set_fields, "$setOnInsert": on_insert},
                    upsert=True,
                )
            )
        if ops:
            res = await coll.bulk_write(ops, ordered=False)
            inserted += res.upserted_count
        updated += sum(1 for d in chunk if d["serviceUrn"] in existing_urns)

    # Flag previously-active URNs that disappeared from this CSV. We
    # deliberately keep the documents intact — the frontend dims them
    # as "recently closed/removed" rather than hiding them.
    res = await coll.update_many(
        {
            "serviceUrn": {"$nin": seen_urns},
            "active": {"$ne": False},
        },
        {"$set": {"active": False, "inactive_since": now_iso}},
    )
    inactivated = res.modified_count

    total_active = await coll.count_documents({"active": {"$ne": False}})
    total_inactive = await coll.count_documents({"active": False})

    meta = {
        "_id": "last_import",
        "filename": filename,
        "source": "upload",
        "imported_at": now,
        "imported_by": imported_by,
        "rows_in_file": len(docs),
        "inserted": inserted,
        "updated": updated,
        "reactivated": reactivated,
        "inactivated": inactivated,
        "total_active": total_active,
        "total_inactive": total_inactive,
    }
    await db.wales_import_state.update_one(
        {"_id": "last_import"}, {"$set": meta}, upsert=True
    )
    # Append a history record so the admin UI can show "Imports so far".
    history_entry = {**meta}
    history_entry.pop("_id", None)
    await db.wales_import_state.update_one(
        {"_id": "history"},
        {"$push": {"items": {"$each": [history_entry], "$slice": -20}}},
        upsert=True,
    )
    return meta


# ----------------------------------------------------------------- router
def build_wales_router(db, require_role):  # noqa: D401
    router = APIRouter()

    async def _get_def() -> WalesDefinition:
        doc = await db.wales_definition.find_one(
            {"_id": DEFAULT_DEFINITION_ID}, {"_id": 0}
        )
        if not doc:
            return WalesDefinition()
        return WalesDefinition(**doc)

    @router.get("/wales/definition")
    async def get_definition(_user: dict = Depends(require_role("admin"))):
        d = await _get_def()
        return d.model_dump()

    @router.put("/wales/definition")
    async def put_definition(
        body: WalesDefinition,
        user: dict = Depends(require_role("admin")),
    ):
        doc = body.model_dump()
        doc.update({
            "_id": DEFAULT_DEFINITION_ID,
            "updated_at": datetime.now(timezone.utc),
            "updated_by": user.get("email"),
        })
        await db.wales_definition.update_one(
            {"_id": DEFAULT_DEFINITION_ID}, {"$set": doc}, upsert=True,
        )
        return body.model_dump()

    @router.get("/wales/definition/preview")
    async def preview_definition(
        include_service_types: Optional[str] = Query(None),
        exclude_service_types: Optional[str] = Query(None),
        include_subtypes: Optional[str] = Query(None),
        exclude_subtypes: Optional[str] = Query(None),
        include_categories: Optional[str] = Query(None),
        exclude_categories: Optional[str] = Query(None),
        include_providers: Optional[str] = Query(None),
        min_places: Optional[str] = Query(None),
        hide_inactive: Optional[str] = Query(None),
        _user: dict = Depends(require_role("admin")),
    ):
        def split(v):
            return [x.strip() for x in (v or "").split(",") if x.strip()]

        def _opt_int(v):
            try:
                return int(v) if v and str(v).strip() else None
            except (TypeError, ValueError):
                return None

        d = WalesDefinition(
            include_service_types=split(include_service_types),
            exclude_service_types=split(exclude_service_types),
            include_subtypes=split(include_subtypes),
            exclude_subtypes=split(exclude_subtypes),
            include_categories=split(include_categories),
            exclude_categories=split(exclude_categories),
            include_providers=split(include_providers),
            min_places=_opt_int(min_places),
            hide_inactive=str(hide_inactive).lower() in ("true", "1", "yes"),
        )
        f = definition_to_mongo_filter(d)
        count = await db.wales_care_services.count_documents(f)
        by_la = await db.wales_care_services.aggregate([
            {"$match": f},
            {"$group": {"_id": "$localAuthority", "n": {"$sum": 1}}},
            {"$sort": {"n": -1}},
            {"$limit": 12},
        ]).to_list(12)
        sample = await db.wales_care_services.find(
            f,
            {
                "_id": 0, "serviceUrn": 1, "name": 1, "postalCode": 1, "town": 1,
                "localAuthority": 1, "serviceSubType": 1, "maxApprovedPlaces": 1,
                "provider": 1, "active": 1,
            },
        ).limit(8).to_list(8)
        return {"count": count, "by_la": by_la, "sample": sample}

    @router.get("/wales/distinct")
    async def distinct_values(
        field: str = Query(
            ...,
            description=(
                "serviceType | serviceSubType | categoriesOfCare | "
                "provider | town | localAuthority"
            ),
        ),
        _user: dict = Depends(require_role("admin")),
    ):
        allowed = {
            "serviceType", "serviceSubType", "categoriesOfCare",
            "provider", "town", "localAuthority",
        }
        if field not in allowed:
            raise HTTPException(400, detail="Invalid field")
        if field == "categoriesOfCare":
            pipeline = [
                {"$unwind": f"${field}"},
                {"$group": {"_id": f"${field}", "n": {"$sum": 1}}},
                {"$sort": {"n": -1}},
                {"$limit": 200},
            ]
        else:
            pipeline = [
                {"$group": {"_id": f"${field}", "n": {"$sum": 1}}},
                {"$sort": {"n": -1}},
                {"$limit": 200},
            ]
        rows = await db.wales_care_services.aggregate(pipeline).to_list(500)
        return {"values": [{"value": r["_id"], "count": r["n"]} for r in rows if r["_id"]]}

    @router.post("/wales/import")
    async def import_csv(
        file: UploadFile = File(...),
        user: dict = Depends(require_role("admin")),
    ):
        """Incremental upsert into ``wales_care_services`` from an
        uploaded CIW CSV.

        See module-level docstring for the upsert + inactive-flag
        contract. Returns a summary the admin UI uses to show
        ``X new · Y updated · Z reactivated · N closed``.
        """
        if not file.filename or not file.filename.lower().endswith(".csv"):
            raise HTTPException(400, detail="Please upload a .csv file")
        raw = await file.read()
        docs, skipped_wrong_type, skipped_blank = _parse_csv_bytes(raw)
        if not docs:
            raise HTTPException(
                400,
                detail=(
                    "No Care Home Service rows found in this CSV. "
                    "Check the Service Type column."
                ),
            )
        meta = await _upsert_incremental(
            db, docs,
            imported_by=user.get("email") or "unknown",
            filename=file.filename,
        )
        return {
            "ok": True,
            "filename": file.filename,
            "rows_in_file": meta["rows_in_file"],
            "inserted": meta["inserted"],
            "updated": meta["updated"],
            "reactivated": meta["reactivated"],
            "inactivated": meta["inactivated"],
            "total_active": meta["total_active"],
            "total_inactive": meta["total_inactive"],
            "skipped_wrong_type": skipped_wrong_type,
            "skipped_blank": skipped_blank,
        }

    @router.get("/wales/import/status")
    async def import_status(_user: dict = Depends(require_role("admin"))):
        last = await db.wales_import_state.find_one(
            {"_id": "last_import"}, {"_id": 0}
        )
        history_doc = await db.wales_import_state.find_one(
            {"_id": "history"}, {"_id": 0}
        )
        live_count = await db.wales_care_services.count_documents(
            {"active": {"$ne": False}}
        )
        inactive_count = await db.wales_care_services.count_documents(
            {"active": False}
        )
        return {
            "live_count": live_count,
            "inactive_count": inactive_count,
            "last_import": last,
            "history": (history_doc or {}).get("items", []),
        }

    return router
