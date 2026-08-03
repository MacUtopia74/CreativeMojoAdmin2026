"""Add a UNIQUE index on ``franchisees.franchise_number``.

Run **only** after every duplicate franchise_number has been
reconciled (i.e. after a human has decided which record retains the
number and which is renumbered). The script REFUSES to create the
index if any duplicates remain, listing them so the reconciler knows
what to fix first.

Usage:
    cd /app/backend && python scripts/add_unique_franchise_number_index.py

Idempotent: if the index is already present with unique=true, it exits
0 silently. If a non-unique index with the same key exists it is
dropped and re-created as unique (never happens under normal
operations because ``franchise_number_1`` was created without
``unique=True`` in migration.py).
"""
from __future__ import annotations

import asyncio
import os
import sys

# Allow running from repo root or the backend/scripts directory.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402

from franchisee_duplicate_guard import find_duplicate_groups  # noqa: E402


MONGO_URL = os.environ.get("MONGO_URL")
DB_NAME = os.environ.get("DB_NAME")
if not MONGO_URL or not DB_NAME:
    print("ERROR: MONGO_URL and DB_NAME environment variables must be set", file=sys.stderr)
    sys.exit(2)


async def main() -> int:
    client = AsyncIOMotorClient(MONGO_URL)
    db = client[DB_NAME]

    dupes = await find_duplicate_groups(db)
    if dupes:
        print("REFUSING to add unique index — duplicates still present:")
        for g in dupes:
            print(f"  franchise_number={g['franchise_number']!r} used by {len(g['records'])} records:")
            for r in g["records"]:
                print(
                    f"    id={r.get('id')}  organisation={r.get('organisation')!r}"
                    f"  name={r.get('first_name')} {r.get('last_name')}"
                    f"  status={r.get('status')}  created_at={r.get('created_at')}"
                )
        print(
            "\nReconcile these via the admin UI (renumber the duplicate, or"
            " retire it), then re-run this script."
        )
        return 1

    existing = await db.franchisees.index_information()
    for name, info in existing.items():
        keys = info.get("key") or []
        if keys == [("franchise_number", 1)]:
            if info.get("unique"):
                print(f"Index {name} already unique — nothing to do.")
                return 0
            # Non-unique variant present — drop and re-create.
            print(f"Dropping non-unique index {name} in preparation for unique re-creation…")
            await db.franchisees.drop_index(name)
            break

    # Sparse=True so records without a franchise_number (contacts
    # awaiting number allocation) don't collide on the null key.
    await db.franchisees.create_index(
        [("franchise_number", 1)], unique=True, sparse=True,
        name="franchise_number_1_unique",
    )
    print("✅ Created unique index franchise_number_1_unique (sparse=True).")
    return 0


if __name__ == "__main__":
    rc = asyncio.run(main())
    sys.exit(rc)
