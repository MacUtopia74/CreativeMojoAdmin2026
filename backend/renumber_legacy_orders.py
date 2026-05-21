"""Assign continuous ``display_order_id`` numbers to legacy-imported orders
so they slot in seamlessly above the live Woo ID sequence (which currently
peaks at 8066).

Strategy:
  • Live Woo orders keep their existing Woo number (8066, 8063, 8054 …)
  • Legacy orders get a new ``display_order_id`` starting from ``max_woo + 1``,
    assigned in descending order of their ``legacy_order_id`` so the most
    recent legacy admin entries get the lowest new IDs (just above 8066).

Result:
  • legacy admin's #1389  → 8067
  • legacy admin's #1388  → 8068
  • legacy admin's #1379  → 8077
  • …
  • legacy admin's #1     → ~9165

Idempotent — re-running is safe (recomputes from scratch).

Future Woo orders will keep arriving with their own Woo IDs (8067+), so
to avoid display-ID collisions we reserve a buffer: legacy renumbering
actually starts at ``max_woo + buffer`` where ``buffer`` defaults to 1.
Override with ``--buffer 1000`` if Paul wants room for Woo to grow before
legacy IDs kick in.

Run:
    python -m backend.renumber_legacy_orders
    python -m backend.renumber_legacy_orders --buffer 1000
"""
import argparse
import asyncio
import os

from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient

load_dotenv("/app/backend/.env")


async def main(buffer: int = 1, dry_run: bool = False) -> None:
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = client[os.environ["DB_NAME"]]

    # Highest Woo ID actually in the DB (only count live-API orders to
    # avoid an old legacy-imported Woo row inflating the ceiling).
    max_woo = 0
    async for o in db.woo_orders.find(
        {"channel": "woocommerce", "legacy_import": {"$ne": True}},
        {"_id": 0, "woo_id": 1},
    ):
        wid = o.get("woo_id") or 0
        if isinstance(wid, int) and wid > max_woo:
            max_woo = wid
    print(f"Highest live Woo ID in DB: {max_woo}")

    start_at = max_woo + buffer
    print(f"Legacy display-id range will start at: {start_at}")

    # All legacy-imported orders, sorted by original legacy_order_id DESC so
    # newest legacy entries land closest to the Woo range.
    legacy = await db.woo_orders.find(
        {"legacy_import": True},
        {"_id": 0, "id": 1, "legacy_order_id": 1},
    ).to_list(length=None)

    def _key(o):
        try:
            return int(o.get("legacy_order_id") or 0)
        except (TypeError, ValueError):
            return 0

    legacy.sort(key=_key, reverse=True)

    print(f"Renumbering {len(legacy)} legacy orders …")
    updated = 0
    for i, o in enumerate(legacy):
        new_id = start_at + i
        if dry_run:
            continue
        await db.woo_orders.update_one(
            {"id": o["id"]},
            {"$set": {"display_order_id": new_id}},
        )
        updated += 1

    if dry_run:
        print(f"DRY RUN — would have written {len(legacy)} display_order_ids.")
        print(f"Sample: top 3 legacy IDs → display "
              f"{[(o.get('legacy_order_id'), start_at + i) for i, o in enumerate(legacy[:3])]}")
    else:
        print(f"Wrote display_order_id on {updated} orders.")
        # Quick verification
        sample = await db.woo_orders.find(
            {"legacy_import": True},
            {"_id": 0, "legacy_order_id": 1, "display_order_id": 1, "customer_label": 1},
        ).sort("display_order_id", 1).limit(5).to_list(5)
        print("Sample (lowest new IDs):", sample)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--buffer", type=int, default=1, help="Reserve N Woo IDs above current max before legacy block starts")
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()
    asyncio.run(main(buffer=args.buffer, dry_run=args.dry_run))
