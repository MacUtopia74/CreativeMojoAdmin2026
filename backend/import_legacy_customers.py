"""Import the legacy admin's customer list into a unified `crm_customers`
collection and stitch each row through to:

  1. Any matching live ``woo_orders`` (via customer_email match).
  2. The cached Xero contacts (via email match) so the reconciliation
     page can suggest a known Xero ContactID up-front.

The CSV the user supplied was scraped from the old admin's customer list
HTML table, so its columns came from the source page's CSS class names
rather than meaningful headers. We map them positionally:

    col 1  px-3 href      legacy customer detail URL (.../customers/{id})
    col 2  inline-flex    customer name / company
    col 3  px-3           email
    col 4  px-3 2         order count (we ignore — derived elsewhere)
    col 5  px-3 href 2    legacy orders URL (we ignore — derived elsewhere)
    col 6  text-green-500 active flag ("Yes" if the customer is enabled)

Usage:
    python -m backend.import_legacy_customers /path/to/Old\\ Admin\\ Contacts.csv
"""
from __future__ import annotations

import asyncio
import csv
import os
import re
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

from motor.motor_asyncio import AsyncIOMotorClient

MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")

LEGACY_ID_RE = re.compile(r"/customers/(\d+)")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_row(row: dict) -> dict | None:
    """Project one CSV row onto the canonical customer schema. Returns
    None if the row is unusable (missing name)."""
    legacy_url = (row.get("px-3 href") or "").strip()
    name = (row.get("inline-flex") or "").strip()
    email = (row.get("px-3") or "").strip()
    active_flag = (row.get("text-green-500") or "").strip()
    if not name:
        return None
    m = LEGACY_ID_RE.search(legacy_url)
    legacy_id = int(m.group(1)) if m else None
    return {
        "id": str(uuid.uuid4()),
        "legacy_id": legacy_id,
        "name": name,
        "name_lc": name.lower(),
        "email": email or None,
        "email_lc": (email or "").lower() or None,
        "active": active_flag.lower() == "yes",
        "xero_contact_id": None,
        "xero_match_status": "pending",
        "source": "old_admin_csv",
        "created_at": _now(),
    }


async def main(csv_path: str) -> None:
    p = Path(csv_path)
    if not p.exists():
        print(f"File not found: {csv_path}", file=sys.stderr)
        sys.exit(2)

    client = AsyncIOMotorClient(MONGO_URL)
    db = client[DB_NAME]

    # Read + parse all rows
    with p.open("r", encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    print(f"Read {len(rows)} CSV rows from {p.name}")

    inserted = 0
    updated = 0
    skipped = 0
    for row in rows:
        rec = _parse_row(row)
        if not rec:
            skipped += 1
            continue
        # Idempotent by legacy_id (if we have one) else by email
        match = {}
        if rec["legacy_id"] is not None:
            match["legacy_id"] = rec["legacy_id"]
        elif rec.get("email_lc"):
            match["email_lc"] = rec["email_lc"]
        else:
            match["name_lc"] = rec["name_lc"]
        existing = await db.crm_customers.find_one(match)
        if existing:
            await db.crm_customers.update_one(
                {"_id": existing["_id"]},
                {"$set": {
                    "name": rec["name"],
                    "name_lc": rec["name_lc"],
                    "email": rec.get("email"),
                    "email_lc": rec.get("email_lc"),
                    "active": rec["active"],
                    "updated_at": _now(),
                }},
            )
            updated += 1
        else:
            await db.crm_customers.insert_one(rec)
            inserted += 1
    print(f"Inserted: {inserted} | Updated: {updated} | Skipped: {skipped}")

    # ---- Stitch crm_customers → Xero contacts (auto-link by email) ----
    print("\nAuto-linking crm_customers to Xero contacts by email…")
    matched_xero = 0
    async for cust in db.crm_customers.find({"xero_contact_id": None, "email_lc": {"$ne": None}}):
        hit = await db.xero_contacts_cache.find_one({"email_lc": cust["email_lc"]})
        if hit:
            await db.crm_customers.update_one(
                {"_id": cust["_id"]},
                {"$set": {
                    "xero_contact_id": hit["contact_id"],
                    "xero_contact_name": hit.get("name"),
                    "xero_match_status": "auto_matched_by_email",
                    "updated_at": _now(),
                }},
            )
            matched_xero += 1
    print(f"Matched {matched_xero} crm_customers to Xero contacts.")

    # ---- Stitch crm_customers → existing woo_orders (so orders without a
    # crm_customer_id pick one up by email) ----
    print("\nStamping crm_customer_id onto matching woo_orders…")
    linked_orders = 0
    async for cust in db.crm_customers.find({"email_lc": {"$ne": None}}):
        r = await db.woo_orders.update_many(
            {
                "customer_email": {"$regex": f"^{re.escape(cust['email_lc'])}$", "$options": "i"},
                "crm_customer_id": {"$in": [None, ""]},
            },
            {"$set": {
                "crm_customer_id": cust["id"],
                "crm_customer_legacy_id": cust.get("legacy_id"),
            }},
        )
        linked_orders += r.modified_count
    print(f"Linked {linked_orders} woo_orders to crm_customers.")

    # ---- Also propagate xero_contact_id onto woo_orders where we now
    # know it via the crm_customer link ----
    print("\nPropagating xero_contact_id from crm_customers onto woo_orders…")
    propagated = 0
    async for cust in db.crm_customers.find({"xero_contact_id": {"$ne": None}}):
        r = await db.woo_orders.update_many(
            {
                "crm_customer_id": cust["id"],
                "xero_contact_id": {"$in": [None, ""]},
            },
            {"$set": {
                "xero_contact_id": cust["xero_contact_id"],
                "xero_contact_name": cust.get("xero_contact_name"),
                "xero_contact_match_status": "auto_matched_via_legacy",
            }},
        )
        propagated += r.modified_count
    print(f"Propagated {propagated} order linkages.")

    total_customers = await db.crm_customers.count_documents({})
    matched_total = await db.crm_customers.count_documents({"xero_contact_id": {"$ne": None}})
    unmatched_orders = await db.woo_orders.count_documents({"xero_contact_id": {"$in": [None, ""]}})
    print("\n=== Summary ===")
    print(f"crm_customers: {total_customers} total, {matched_total} linked to Xero")
    print(f"woo_orders still unmatched to Xero: {unmatched_orders}")

    client.close()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python -m backend.import_legacy_customers <csv_path>", file=sys.stderr)
        sys.exit(2)
    asyncio.run(main(sys.argv[1]))
