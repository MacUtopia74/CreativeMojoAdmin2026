"""
Migration & CRM module for Creative Mojo Admin.
Handles Airtable → MongoDB migration plus CRUD endpoints for migrated data.
"""
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any
import os
import uuid
import logging
import asyncio
import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

logger = logging.getLogger("creative-mojo-admin.crm")

# ============================================================================
# Field mapping definitions (Airtable name → MongoDB field name)
# ============================================================================
FRANCHISEE_FIELDS = {
    "Organisation": "organisation",
    "Franchise/Licencee Number": "franchise_number",
    "Upload": "photos_raw",  # attachments — keep original urls
    "First Name": "first_name",
    "Last Name": "last_name",
    "Date Added": "date_added",
    "Mojo Email": "mojo_email",
    "Secondary Email": "secondary_email",
    "Home Phone": "home_phone",
    "Mobile Phone": "mobile_phone",
    "Address Street": "address_street",
    "City": "city",
    "County": "county",
    "Postcode": "postcode",
    "Tags": "tags",
    "Website": "website",
    "Facebook": "facebook",
    "Contracts": "_contract_airtable_ids",  # link — resolved post-pass
    "Contract Number": "contract_number_rollup",
    "Notes": "notes",
    "Mandate": "mandate",
    "Postcode Lookup": "_territory_airtable_ids",  # link
}

CONTRACT_FIELDS = {
    "Ref": "ref",
    "Franchise": "_franchisee_airtable_ids",
    "First Name": "first_name_rollup",
    "Last Name": "last_name_rollup",
    "Email Address": "email_rollup",
    "Renewal Date": "renewal_date",
    "Contract Term": "contract_term_years",
    "Staying/Leaving": "staying_leaving",
    "Days Remaining": "days_remaining",
    "Notes & Contract Response": "notes_and_response",
    "Commencement Date": "commencement_date",
    "Renewal Fee": "renewal_fee",
    "Monthly Fee": "monthly_fee",
    "Cancelled Early": "cancelled_early",
    "1st Anniversary Date": "anniversary_reminder",  # RENAMED
    "Renewal Fee Paid?": "renewal_fee_paid",
}

CONTACT_FIELDS = {
    "Email Address": "email",
    "First Name": "first_name",
    "Last Name": "last_name",
    "Date Added": "date_added",
    "Telephone": "telephone",
    "Mobile Phone": "mobile_phone",
    "Address Street": "address_street",
    "City": "city",
    "County": "county",
    "Postcode": "postcode",
    "Why you are contacting us (from Web Form - Contact)": "why_contacting",
    "Why you are contacting us (from Web Form - Contact) 2": "_why_contacting_2",  # merged below
    "Contact Type - Facebook": "contact_type_facebook",
    "Contact Type - Twitter": "contact_type_twitter",
    "Contact Type - Instagram": "contact_type_instagram",
    "Contact Type - Google": "contact_type_google",
    "Contact Type - Other": "contact_type_other",
}

WEBFORM_FIELDS = {
    "Date": "date",
    "First Name": "first_name",
    "Last Name": "last_name",
    "Telephone Number": "telephone",
    "Email": "email_raw",  # this is a multipleRecordLinks in airtable — odd
    "Name of establishment": "establishment_name",
    "1st Line of Address": "address_street",
    "City/Town": "city",
    "County": "county",
    "Postcode": "postcode",
    "Why you are contacting us": "why_contacting",
    "Your Message": "message",
    "Response Sent?": "response_sent",
    "Email opened?": "email_opened",
    "Notes": "notes",
    "Sandra follow up?": "follow_up_needed",
    "Entry ID": "gravity_entry_id",
    "Country Tag": "country_tag",
    "Potential?": "potential",
    "Shadow Booked": "shadow_booked",
    "Had a map?": "had_a_map",
    "Price": "price_tier",
    "Franchisees/Licencees": "_franchisee_airtable_ids",
}

TERRITORY_FIELDS = {
    "Postcode": "postcode",
    "Franchisee": "_franchisee_airtable_ids",
}


def _coerce_value(value):
    """Flatten Airtable's annoyingly nested values."""
    if value is None:
        return None
    if isinstance(value, list):
        # Lookup/rollup fields return arrays even for single values
        if len(value) == 1:
            return _coerce_value(value[0])
        # Multi-select tags - keep as list of strings
        if all(isinstance(v, str) for v in value):
            return value
        return value
    return value


def _extract_attachment_urls(value):
    if not value or not isinstance(value, list):
        return []
    return [
        {"url": v.get("url"), "filename": v.get("filename"), "type": v.get("type")}
        for v in value if isinstance(v, dict) and v.get("url")
    ]


def _map_fields(record: dict, field_map: dict) -> dict:
    """Transform an Airtable record into a MongoDB doc using the field map."""
    out = {
        "airtable_id": record["id"],
        "airtable_created_time": record.get("createdTime"),
    }
    src = record.get("fields", {})
    for at_name, mongo_name in field_map.items():
        if at_name not in src:
            continue
        v = src[at_name]
        if at_name == "Upload":  # attachments
            out["photos"] = _extract_attachment_urls(v)
        else:
            out[mongo_name] = _coerce_value(v)
    return out


# ============================================================================
# Airtable fetcher
# ============================================================================
async def _fetch_all_records(base_id: str, table_id: str, token: str) -> List[dict]:
    """Paginate through entire table."""
    records = []
    offset = None
    headers = {"Authorization": f"Bearer {token}"}
    async with httpx.AsyncClient(timeout=60) as client:
        while True:
            params = {"pageSize": 100}
            if offset:
                params["offset"] = offset
            r = await client.get(
                f"https://api.airtable.com/v0/{base_id}/{table_id}",
                headers=headers, params=params,
            )
            r.raise_for_status()
            j = r.json()
            records.extend(j.get("records", []))
            offset = j.get("offset")
            if not offset:
                break
    return records


# ============================================================================
# Migration runner
# ============================================================================
async def run_migration(db, airtable_pat: str, airtable_base_id: str, run_by_email: str) -> dict:
    """Idempotent migration. Drops existing migrated data and re-imports.
    Returns counts per collection."""
    # Get the migration plan from MongoDB to know table IDs
    table_decisions = await db.migration_table_decisions.find({}, {"_id": 0}).to_list(1000)
    by_name = {td["table_name"]: td for td in table_decisions}

    # Required tables for Phase 1 migration
    required = {
        "Franchisees/Licencees": (FRANCHISEE_FIELDS, "franchisees"),
        "Contracts": (CONTRACT_FIELDS, "contracts"),
        "Contacts": (CONTACT_FIELDS, "contacts"),
        "Web Form - Contact": (WEBFORM_FIELDS, "web_form_contacts"),
        "DaD Postcode Lookup": (TERRITORY_FIELDS, "territories"),
    }

    # Clear existing migrated data
    for coll in ["franchisees", "contracts", "contacts", "web_form_contacts", "territories"]:
        await db[coll].delete_many({})

    counts = {}
    airtable_id_to_uuid: Dict[str, Dict[str, str]] = {coll: {} for _, coll in required.values()}

    # Pass 1: fetch + insert (without resolving links)
    for table_name, (field_map, coll_name) in required.items():
        td = by_name.get(table_name)
        if not td or not td.get("migrate"):
            counts[coll_name] = 0
            continue
        records = await _fetch_all_records(airtable_base_id, td["table_id"], airtable_pat)
        docs = []
        for rec in records:
            doc = _map_fields(rec, field_map)
            doc["id"] = str(uuid.uuid4())
            doc["created_at"] = datetime.now(timezone.utc).isoformat()
            doc["updated_at"] = doc["created_at"]
            # Special handling
            if coll_name == "contacts":
                doc["source"] = "legacy_general_enquiry"
                # Merge "Why you are contacting us 2" into "Why you are contacting us"
                w1, w2 = doc.get("why_contacting"), doc.pop("_why_contacting_2", None)
                if w1 and w2 and w1 != w2:
                    doc["why_contacting"] = f"{w1}; {w2}"
                elif w2 and not w1:
                    doc["why_contacting"] = w2
                # Default pipeline status
                doc["pipeline_status"] = "archive"  # legacy data
            elif coll_name == "web_form_contacts":
                doc["source"] = "franchise_enquiry"
                # Default pipeline status based on existing fields
                doc["pipeline_status"] = "new"
                if doc.get("response_sent") and str(doc["response_sent"]).lower() not in ("no", "false", ""):
                    doc["pipeline_status"] = "contacted"
                if doc.get("potential") and "yes" in str(doc.get("potential", "")).lower():
                    doc["pipeline_status"] = "qualified"
                # If linked to a franchisee → converted
                if doc.get("_franchisee_airtable_ids"):
                    doc["pipeline_status"] = "converted"
            airtable_id_to_uuid[coll_name][rec["id"]] = doc["id"]
            docs.append(doc)
        if docs:
            await db[coll_name].insert_many(docs)
        counts[coll_name] = len(docs)
        logger.info(f"Migrated {len(docs)} into {coll_name}")

    # Pass 2: resolve links
    # Franchisees → contract_ids + territory_ids
    franchisees = await db.franchisees.find({}, {"_id": 0}).to_list(10000)
    for f in franchisees:
        contract_ids = [airtable_id_to_uuid["contracts"].get(aid) for aid in (f.get("_contract_airtable_ids") or [])]
        territory_ids = [airtable_id_to_uuid["territories"].get(aid) for aid in (f.get("_territory_airtable_ids") or [])]
        await db.franchisees.update_one(
            {"id": f["id"]},
            {"$set": {
                "contract_ids": [x for x in contract_ids if x],
                "territory_ids": [x for x in territory_ids if x],
            }, "$unset": {"_contract_airtable_ids": "", "_territory_airtable_ids": ""}},
        )

    # Contracts → franchisee_id (single)
    contracts = await db.contracts.find({}, {"_id": 0}).to_list(10000)
    for c in contracts:
        flist = c.get("_franchisee_airtable_ids") or []
        if isinstance(flist, str):
            flist = [flist]
        fid = airtable_id_to_uuid["franchisees"].get(flist[0]) if flist else None
        await db.contracts.update_one(
            {"id": c["id"]},
            {"$set": {"franchisee_id": fid}, "$unset": {"_franchisee_airtable_ids": ""}},
        )

    # Territories → franchisee_id (single)
    territories = await db.territories.find({}, {"_id": 0}).to_list(10000)
    for t in territories:
        flist = t.get("_franchisee_airtable_ids") or []
        if isinstance(flist, str):
            flist = [flist]
        fid = airtable_id_to_uuid["franchisees"].get(flist[0]) if flist else None
        await db.territories.update_one(
            {"id": t["id"]},
            {"$set": {"franchisee_id": fid}, "$unset": {"_franchisee_airtable_ids": ""}},
        )

    # Web form contacts → franchisee_id (single, if any)
    wfs = await db.web_form_contacts.find({}, {"_id": 0}).to_list(10000)
    for w in wfs:
        flist = w.get("_franchisee_airtable_ids") or []
        if isinstance(flist, str):
            flist = [flist]
        fid = airtable_id_to_uuid["franchisees"].get(flist[0]) if flist else None
        await db.web_form_contacts.update_one(
            {"id": w["id"]},
            {"$set": {"franchisee_id": fid}, "$unset": {"_franchisee_airtable_ids": ""}},
        )

    # Indexes
    await db.franchisees.create_index("id", unique=True)
    await db.franchisees.create_index("mojo_email")
    await db.franchisees.create_index("franchise_number")
    await db.contracts.create_index("id", unique=True)
    await db.contracts.create_index("franchisee_id")
    await db.contracts.create_index("anniversary_reminder")
    await db.contacts.create_index("id", unique=True)
    await db.contacts.create_index("email")
    await db.contacts.create_index("pipeline_status")
    await db.web_form_contacts.create_index("id", unique=True)
    await db.web_form_contacts.create_index("pipeline_status")
    await db.web_form_contacts.create_index("franchisee_id")
    await db.territories.create_index("id", unique=True)
    await db.territories.create_index("postcode")
    await db.territories.create_index("franchisee_id")

    # Audit log
    await db.migration_runs.insert_one({
        "id": str(uuid.uuid4()),
        "run_at": datetime.now(timezone.utc).isoformat(),
        "run_by": run_by_email,
        "counts": counts,
    })

    return counts
