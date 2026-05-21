"""Import historic orders from the legacy admin CSV.

Skips Woo-channel rows whose Woo order ID is already in our ``woo_orders``
collection (those came in via the live backfill so we don't want dupes).
Imports Direct rows as ``channel='direct'``, status='completed'. Idempotent
— every imported row is tagged ``legacy_import=True`` and keyed by the
``legacy_order_id`` so re-running cleans up + re-inserts safely.

Run:
    python -m backend.import_legacy_orders /path/to/Completed_orders.csv
"""
import asyncio
import csv
import logging
import os
import sys
from datetime import datetime, timezone

from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient

load_dotenv("/app/backend/.env")
logger = logging.getLogger("creative-mojo-admin.legacy-import")


def _parse_uk_date(s: str) -> str | None:
    """``07/05/2026`` or ``07/05/26`` → ISO ``2026-05-07T00:00:00+00:00``."""
    if not s or not s.strip():
        return None
    for fmt in ("%d/%m/%Y", "%d/%m/%y"):
        try:
            d = datetime.strptime(s.strip(), fmt).replace(tzinfo=timezone.utc)
            return d.isoformat()
        except ValueError:
            continue
    return None


def _detect_schema(header: list[str]) -> str:
    """Tell the active-orders CSV layout from the completed-orders one.

    The active export adds two columns the completed one doesn't:
      • a ``text-green-500`` "in X days" relative-date string at index 4
      • a final ``css-…-singleValue`` production-status column

    Returns ``"active"`` or ``"completed"``.
    """
    return "active" if any("green-500" in (h or "") for h in header) else "completed"


def _row_to_order(row: list[str], schema: str, force_status: str | None = None) -> dict | None:
    """Map a single CSV row (in either schema) to the ``woo_orders`` shape."""
    if len(row) < 8 or not (row[1] or "").strip():
        return None

    order_id = row[1].strip()
    created = _parse_uk_date(row[2])
    due = _parse_uk_date(row[3])

    if schema == "active":
        # Active CSV column map:
        # 0:url 1:order_id 2:created 3:due 4:"in X days" 5:customer
        # 6:customer_url 7:channel_main ("Direct"/"n/a") 8:payment 9:channel_woo_marker
        # 10:woo_url 11:woo_id 12:production_status
        customer = (row[5] or "").strip() or "Unknown customer"
        channel_main = (row[7] or "").strip()  # "Direct" / "n/a"
        channel_woo = (row[9] if len(row) > 9 else "").strip()  # "Woo#" / ""
        payment_raw = (row[8] or "").strip().lower()
        woo_id = (row[11] if len(row) > 11 else "").strip() or None
        production = (row[12] if len(row) > 12 else "").strip() or "Awaiting Assembly"
        status = force_status or "active"
        channel_raw = channel_woo or channel_main  # prefer Woo#
    else:
        # Completed CSV: cust at 4, status at 6, payment at 7, channel at 8, woo URL/id at 9/10
        customer = (row[4] or "").strip() or "Unknown customer"
        channel_raw = (row[8] or "").strip()
        payment_raw = (row[7] or "").strip().lower()
        woo_id = (row[10] if len(row) > 10 else "").strip() or None
        production = "Completed"
        status = force_status or "completed"

    is_woo = ("Woo" in channel_raw) and woo_id
    channel = "woocommerce" if is_woo else "direct"
    channel_label = f"Woo#{woo_id}" if is_woo else "Direct"
    payment_status = "Paid" if payment_raw == "paid" else "Pending"

    now = datetime.now(timezone.utc).isoformat()
    canonical_id = f"legacy-{order_id}" if not is_woo else str(woo_id)
    return {
        "id": canonical_id,
        "legacy_order_id": order_id,
        "legacy_import": True,
        "woo_id": int(woo_id) if (is_woo and woo_id and woo_id.isdigit()) else None,
        "woo_number": woo_id if is_woo else None,
        "customer_label": customer,
        "customer_email": None,
        "billing": {"company": customer},
        "shipping": {"company": customer},
        "date_created": created or now,
        "date_modified": now,
        "date_paid": created if payment_status == "Paid" else None,
        "due_date": due.split("T")[0] if due else None,
        "currency": "GBP",
        "total": "0.00",
        "shipping_total": "0.00",
        "line_items": [],
        "line_items_unavailable": True,
        "invoiced": payment_status == "Paid" and status == "completed",
        "status": status,
        "is_draft": False,
        "woo_status": "completed" if status == "completed" else "processing",
        "production_status": production,
        "payment_status": payment_status,
        "channel": channel,
        "channel_label": channel_label,
        "updated_at": now,
    }


async def main(csv_path: str, dry_run: bool = False) -> None:
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = client[os.environ["DB_NAME"]]

    # Build the set of Woo IDs already in our DB so we don't recreate them.
    existing_woo_ids: set[str] = set()
    async for o in db.woo_orders.find(
        {"channel": "woocommerce"}, {"_id": 0, "id": 1, "woo_number": 1, "woo_id": 1}
    ):
        if o.get("id"):
            existing_woo_ids.add(str(o["id"]))
        if o.get("woo_number"):
            existing_woo_ids.add(str(o["woo_number"]))
        if o.get("woo_id"):
            existing_woo_ids.add(str(o["woo_id"]))

    inserted = updated = skipped_woo_dupe = skipped_malformed = 0
    by_channel: dict[str, int] = {"direct": 0, "woocommerce": 0}

    with open(csv_path, newline="", encoding="utf-8") as fh:
        reader = csv.reader(fh)
        header = next(reader, [])
        schema = _detect_schema(header)
        print(f"Detected schema: {schema}")
        for row in reader:
            doc = _row_to_order(row, schema=schema)
            if not doc:
                skipped_malformed += 1
                continue
            # Skip Woo orders that came from the live backfill.
            if doc["channel"] == "woocommerce":
                key = str(doc.get("woo_number") or doc.get("woo_id") or doc["id"])
                if key in existing_woo_ids:
                    skipped_woo_dupe += 1
                    continue
            by_channel[doc["channel"]] += 1
            if dry_run:
                continue
            r = await db.woo_orders.update_one(
                {"id": doc["id"]}, {"$set": doc}, upsert=True
            )
            if r.upserted_id:
                inserted += 1
            else:
                updated += 1

    print("=== Legacy completed-orders import ===")
    print(f"  Direct rows imported    : {by_channel['direct']}")
    print(f"  Woo rows imported       : {by_channel['woocommerce']}")
    print(f"  Skipped (already in DB) : {skipped_woo_dupe}")
    print(f"  Skipped (malformed)     : {skipped_malformed}")
    print(f"  Mongo upserts           : inserted={inserted} · updated={updated}")
    if dry_run:
        print("  DRY RUN — no writes performed.")


if __name__ == "__main__":
    path = next((a for a in sys.argv[1:] if not a.startswith("--")), None)
    if not path:
        print("usage: python -m backend.import_legacy_orders <csv> [--dry-run]")
        sys.exit(1)
    asyncio.run(main(path, dry_run="--dry-run" in sys.argv))
