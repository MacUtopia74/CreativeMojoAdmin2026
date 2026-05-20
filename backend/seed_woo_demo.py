"""Seed the Orders page with realistic demo data so the admin UI can be
previewed before live WooCommerce credentials are wired in tomorrow.

Idempotent — re-running this script just refreshes the seed docs. All
seeded orders carry ``seed=True`` so they can be wiped in one operation
once the real Woo backfill takes over.

Run once:
    python -m backend.seed_woo_demo
"""
import asyncio
import os
from datetime import datetime, timezone, timedelta

from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient

load_dotenv("/app/backend/.env")

NOW = datetime.now(timezone.utc)


def days(n: int) -> str:
    return (NOW + timedelta(days=n)).isoformat()


# Realistic care-home customers + Woo product names, mirroring the user's
# screenshots so the UI looks production-ready immediately.
SEED_ORDERS = [
    # (id, customer, due_offset_days, created_offset_days, products, woo_status, channel, paid, draft)
    ("1386", "The Haven Care Home (Black Swan)",          10, 0,
        [("World Cup 2026 - Group Art Kit - Large", 1, "50.00")], "processing", "direct", False, False),
    ("1385", "The Beeches (Black Swan)",                  10, 0,
        [("World Cup 2026 - Group Art Kit - Large", 1, "50.00")], "processing", "direct", False, False),
    ("1384", "Merryfield House Nursing Home",             10, 0,
        [("World Cup 2026 - Group Art Kit - Large", 1, "50.00")], "processing", "direct", False, False),
    ("1383", "Linden Lodge Nursing Home",                 10, 0,
        [("World Cup 2026 - Group Art Kit - Large", 1, "50.00")], "processing", "direct", False, False),
    ("1382", "Kernow House Care Home",                    10, 0,
        [("World Cup 2026 - Group Art Kit - Large", 1, "50.00")], "processing", "direct", False, False),
    ("1381", "Cumnor Hill House",                         10, 0,
        [("World Cup 2026 - Group Art Kit - Large", 1, "50.00")], "processing", "direct", False, False),
    ("1380", "Catmoor House Care Home",                    8, -2,
        [("Love you Tonnes! - Group Art Kit - Large", 1, "50.00"),
         ("Random Acts of Kindness Day - 1-2-1 Art Kit", 2, "18.00")], "processing", "direct", False, False),
    ("1379", "The Birches Care Home",                      8, -2,
        [("Butterfly Dress - Group Art Kit - Large", 1, "50.00")], "processing", "direct", False, False),
    ("1378", "Ashurst Mews Care Home",                     5, -5,
        [("Musicals - Mary Poppins - Group Art Kit - Medium", 1, "40.00"),
         ("World Wellbeing Day - Group Art Kit - Medium", 1, "40.00"),
         ("Fathers Day Printed Activity Pack - 1x A4 Activity Pack Printed & Posted", 1, "8.00"),
         ("Garden Wildlife Week - Group Art Kit - Medium", 1, "40.00"),
         ("World Cup 2026 - Group Art Kit - Medium", 1, "40.00")], "processing", "woocommerce", False, False),
    ("1377", "Creative Mojo Dartford Bexley and Rochester", 1, -9,
        [("Die Cut Shapes Set 4 - Misc Shapes", 1, "12.00"),
         ("Die Cut Shapes Set 2 - Animals & Leaves", 1, "12.00")], "pending", "woocommerce", True, False),
    ("1376", "St Margaret's Care Home",                   -3, -12,
        [("Easter Crafts - 1-2-1 Art Kit", 3, "18.00")], "completed", "direct", True, False),
    ("1375", "Greenacres Residential",                    -5, -15,
        [("Spring Garden - Group Art Kit - Large", 2, "50.00")], "completed", "woocommerce", True, False),
]

SEED_PRODUCTS = [
    ("10 Lords-a-Leaping Project Kit - 1-2-1 Art Kit",        "sku-10lal-121",  "18.00"),
    ("10 Lords-a-Leaping Project Kit - Group Art Kit - Large","sku-10lal-grpl", "50.00"),
    ("10 Lords-a-Leaping Project Kit - Group Art Kit - Medium","sku-10lal-grpm","40.00"),
    ("11 Pipers Piping Project Kit - 1-2-1 Art Kit",          "sku-11pp-121",   "18.00"),
    ("11 Pipers Piping Project Kit - Group Art Kit - Large",  "sku-11pp-grpl",  "50.00"),
    ("11 Pipers Piping Project Kit - Group Art Kit - Medium", "sku-11pp-grpm",  "40.00"),
    ("12 Days of Christmas - Set of 12 Christmas Cards MEDIUM","sku-12dc-cards","15.00"),
    ("World Cup 2026 - Group Art Kit - Large",                "sku-wc26-grpl",  "50.00"),
    ("World Cup 2026 - Group Art Kit - Medium",               "sku-wc26-grpm",  "40.00"),
    ("Butterfly Dress - Group Art Kit - Large",               "sku-bd-grpl",    "50.00"),
    ("Love you Tonnes! - Group Art Kit - Large",              "sku-lyt-grpl",   "50.00"),
    ("Random Acts of Kindness Day - 1-2-1 Art Kit",           "sku-rak-121",    "18.00"),
    ("Musicals - Mary Poppins - Group Art Kit - Medium",      "sku-mmp-grpm",   "40.00"),
    ("World Wellbeing Day - Group Art Kit - Medium",          "sku-wwd-grpm",   "40.00"),
    ("Fathers Day Printed Activity Pack - 1x A4 Activity Pack Printed & Posted",
     "sku-fd-actpack", "8.00"),
    ("Garden Wildlife Week - Group Art Kit - Medium",         "sku-gww-grpm",   "40.00"),
    ("Die Cut Shapes Set 4 - Misc Shapes",                    "sku-dcs4",       "12.00"),
    ("Die Cut Shapes Set 2 - Animals & Leaves",               "sku-dcs2",       "12.00"),
    ("Easter Crafts - 1-2-1 Art Kit",                         "sku-easter-121", "18.00"),
    ("Spring Garden - Group Art Kit - Large",                 "sku-sg-grpl",    "50.00"),
]

WOO_TO_PROD = {
    "pending":    "Awaiting Assembly",
    "on-hold":    "Awaiting Assembly",
    "processing": "Ready To Ship",
    "completed":  "Completed",
}


def _line(name: str, qty: int, subtotal: str, idx: int) -> dict:
    """Build a line-item entry resembling Woo's ``line_items`` shape."""
    total = f"{float(subtotal) * qty:.2f}"
    sku = next((s for n, s, _ in SEED_PRODUCTS if n == name), f"sku-demo-{idx}")
    return {
        "id": idx * 100,
        "product_id": idx * 1000,
        "name": name,
        "sku": sku,
        "quantity": qty,
        "subtotal": str(float(subtotal) * qty),
        "total": total,
    }


async def main() -> None:
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = client[os.environ["DB_NAME"]]

    # Wipe previous seed before re-inserting (idempotent).
    await db.woo_orders.delete_many({"seed": True})
    await db.woo_products.delete_many({"seed": True})

    # Seed products
    for idx, (name, sku, price) in enumerate(SEED_PRODUCTS):
        await db.woo_products.insert_one({
            "seed": True,
            "id": str(8000 + idx),
            "woo_id": 8000 + idx,
            "name": name,
            "sku": sku,
            "type": "simple",
            "price": price,
            "regular_price": price,
            "stock_status": "instock",
            "attributes": [],
            "updated_at": NOW.isoformat(),
        })

    # Seed orders
    for oid, customer, due_d, created_d, products, woo_status, channel, paid, draft in SEED_ORDERS:
        line_items = [_line(n, q, s, i) for i, (n, q, s) in enumerate(products, 1)]
        total = sum(float(li["total"]) for li in line_items) + 3.99  # shipping
        is_terminal = woo_status in ("completed", "cancelled", "refunded", "failed")
        # Direct orders are billed via Xero AFTER dispatch so they sit Pending
        # until invoiced. Woo orders are only Paid when the seed says so.
        is_paid = paid
        await db.woo_orders.insert_one({
            "seed": True,
            "id": oid,
            "woo_id": int(oid),
            "woo_number": oid,
            "customer_label": customer,
            "customer_email": (customer.lower().replace(" ", "")[:18] + "@example.co.uk"),
            "billing": {"company": customer, "first_name": "", "last_name": "",
                        "email": (customer.lower().replace(" ", "")[:18] + "@example.co.uk")},
            "shipping": {"company": customer},
            "date_created": days(created_d),
            "date_modified": days(created_d),
            "date_paid": days(created_d) if is_paid else None,
            "due_date": days(due_d).split("T")[0],
            "currency": "GBP",
            "total": f"{total:.2f}",
            "shipping_total": "3.99",
            "line_items": line_items,
            "invoiced": is_terminal,
            "woo_status": woo_status,
            "production_status": WOO_TO_PROD.get(woo_status, "Awaiting Assembly"),
            "status": "completed" if is_terminal else "active",
            "payment_status": "Paid" if is_paid else "Pending",
            "channel": channel,
            "channel_label": "Direct" if channel == "direct" else f"Woo#{oid}",
            "is_draft": draft,
            "updated_at": NOW.isoformat(),
        })

    print(f"Seeded {len(SEED_ORDERS)} orders + {len(SEED_PRODUCTS)} products.")
    client.close()


if __name__ == "__main__":
    asyncio.run(main())
