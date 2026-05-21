"""Backfill line items into already-imported legacy orders.

Run AFTER ``import_legacy_orders.py``. The first import gave us order headers
(customer, dates, channel, status) but the CSV had no products. This script
takes the follow-up CSV (which adds a ``Products`` column packed with
``x{qty} {name}`` segments) and:

1. Parses the products string into structured ``line_items``.
2. Strips Woo's HTML markup (``<strong>FREE</strong>`` → ``FREE``).
3. Updates the matching order on legacy id (preferring ``legacy-{N}`` then
   the Woo-id key).
4. Clears the ``line_items_unavailable`` flag so the UI shows products.

Idempotent — re-running just rewrites the line items.

Run:
    python -m backend.import_legacy_order_lines /path/to/file.csv
"""
import asyncio
import csv
import os
import re
import sys
from datetime import datetime, timezone

from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient

load_dotenv("/app/backend/.env")

_HTML_TAG_RE = re.compile(r"<[^>]+>")
# Item-start: a digit-prefix qty AFTER whitespace AFTER a capital letter
# (i.e. the start of the next product). The lookahead requires a Capital
# Letter immediately after the qty so substrings like "1x A4" inside the
# middle of a product name don't get treated as a delimiter.
_ITEM_START_RE = re.compile(r"(?<=\S)\s+(?=x\d{1,2}\s+[A-Z])")
_PIPE_RE = re.compile(r"\s*\|\s*")
_QTY_NAME_RE = re.compile(r"^x(\d+)\s+(.+)$")


def _strip(s: str) -> str:
    return re.sub(r"\s+", " ", _HTML_TAG_RE.sub("", s or "")).strip()


def parse_products_cell(cell: str) -> list[dict]:
    """``"x1 World Cup 2026 - Group Art Kit - Large | x2 Easter Crafts - 1-2-1
    Art Kit"`` → ``[{quantity:1,name:"World Cup 2026 - Group Art Kit - Large"},
    {quantity:2,name:"Easter Crafts - 1-2-1 Art Kit"}]``."""
    if not cell or not cell.strip():
        return []
    # Pipes are unambiguous separators; replace them with a sentinel that we
    # also split on at the end.
    s = _PIPE_RE.sub("<<SEP>>", cell)
    # Then break at the start of a new "xN ProductName" inside the string,
    # using the strict lookahead defined above.
    s = _ITEM_START_RE.sub("<<SEP>>", s)
    chunks = [c.strip() for c in s.split("<<SEP>>") if c.strip()]
    out: list[dict] = []
    for idx, c in enumerate(chunks):
        c = _strip(c)
        m = _QTY_NAME_RE.match(c)
        if m:
            qty = int(m.group(1))
            name = m.group(2).strip()
        else:
            qty, name = 1, c
        out.append({
            "id": idx + 1,
            "product_id": None,
            "name": name,
            "sku": None,
            "quantity": qty,
            "subtotal": "0.00",
            "total": "0.00",
        })
    return out


async def main(csv_path: str, dry_run: bool = False) -> None:
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = client[os.environ["DB_NAME"]]
    now = datetime.now(timezone.utc).isoformat()

    matched = updated = no_target = empty_products = 0
    sample_parses: list[tuple[str, int]] = []

    with open(csv_path, newline="", encoding="utf-8-sig") as fh:
        reader = csv.reader(fh)
        next(reader, None)
        for row in reader:
            if len(row) < 5 or not (row[0] or "").strip():
                continue
            legacy_id = row[0].strip()
            products_cell = row[4] if len(row) > 4 else ""
            items = parse_products_cell(products_cell)
            if not items:
                empty_products += 1
                continue
            if len(sample_parses) < 5:
                sample_parses.append((legacy_id, len(items)))

            # Match the order in our DB. Try the legacy-{N} key first, then
            # any order whose ``legacy_order_id`` was recorded by the prior
            # import step (covers Woo orders where the canonical id is the
            # Woo id, e.g. "8066").
            target = await db.woo_orders.find_one(
                {"id": f"legacy-{legacy_id}"}, {"_id": 0, "id": 1}
            )
            if not target:
                target = await db.woo_orders.find_one(
                    {"legacy_order_id": legacy_id}, {"_id": 0, "id": 1}
                )
            if not target:
                no_target += 1
                continue
            matched += 1
            if dry_run:
                continue
            await db.woo_orders.update_one(
                {"id": target["id"]},
                {"$set": {
                    "line_items": items,
                    "line_items_unavailable": False,
                    "updated_at": now,
                }},
            )
            updated += 1

    print("=== Legacy order-lines backfill ===")
    print(f"  CSV rows with products    : matched={matched}")
    print(f"  Rows with empty products  : {empty_products}")
    print(f"  Rows with NO matching DB  : {no_target}")
    print(f"  Mongo updates             : {updated}")
    print(f"  Sample parses             : {sample_parses}")
    if dry_run:
        print("  DRY RUN — no writes performed.")


if __name__ == "__main__":
    path = next((a for a in sys.argv[1:] if not a.startswith("--")), None)
    if not path:
        print("usage: python -m backend.import_legacy_order_lines <csv> [--dry-run]")
        sys.exit(1)
    asyncio.run(main(path, dry_run="--dry-run" in sys.argv))
