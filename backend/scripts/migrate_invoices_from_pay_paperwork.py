"""One-off migration — pulls invoices, clients and settings from the legacy
Pay-Paperwork app (https://pay-paperwork.emergent.host) and writes them
into Sandra's Admin MongoDB.

Idempotent: every record is upserted by `id`, so re-running this is safe.

Usage (from /app/backend):
    python -m scripts.migrate_invoices_from_pay_paperwork
"""

from __future__ import annotations

import asyncio
import os
import sys
from typing import Any

import httpx
from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient


LEGACY_BASE = "https://pay-paperwork.emergent.host/api"

# Settings fields that were specific to the standalone app's password gate.
# We don't carry these into the host — the host has its own JWT auth.
SETTINGS_SKIP_KEYS = {"password_hash", "security_question", "security_answer_hash"}


async def _get(client: httpx.AsyncClient, path: str) -> Any:
    r = await client.get(f"{LEGACY_BASE}{path}", timeout=30.0)
    r.raise_for_status()
    return r.json()


async def main() -> None:
    load_dotenv("/app/backend/.env")
    mongo_url = os.environ["MONGO_URL"]
    db_name = os.environ["DB_NAME"]
    db = AsyncIOMotorClient(mongo_url)[db_name]

    async with httpx.AsyncClient() as client:
        print("Fetching legacy data…")
        clients = await _get(client, "/clients")
        invoices_active = await _get(client, "/invoices?include_deleted=true")
        invoices_deleted = await _get(client, "/invoices/deleted/list")
        settings = await _get(client, "/settings")
    # `include_deleted=true` already includes deleted in some versions; merge
    # defensively by id.
    by_id: dict[str, dict] = {}
    for inv in invoices_active:
        by_id[inv["id"]] = inv
    for inv in invoices_deleted:
        # Keep the "deleted" copy if both exist — it carries deleted_at/etc.
        by_id[inv["id"]] = inv
    invoices = list(by_id.values())

    print(
        f"Found {len(clients)} clients · {len(invoices)} invoices "
        f"({len(invoices_deleted)} deleted)"
    )

    # ---------- Upsert clients into invoice_clients ----------
    if clients:
        upserts = 0
        for c in clients:
            c.pop("_id", None)
            await db.invoice_clients.update_one(
                {"id": c["id"]}, {"$set": c}, upsert=True
            )
            upserts += 1
        print(f"  • invoice_clients · upserted {upserts}")

    # ---------- Upsert invoices ----------
    if invoices:
        upserts = 0
        for inv in invoices:
            inv.pop("_id", None)
            await db.invoices.update_one(
                {"id": inv["id"]}, {"$set": inv}, upsert=True
            )
            upserts += 1
        print(f"  • invoices · upserted {upserts}")

    # ---------- Settings (strip password fields) ----------
    settings.pop("_id", None)
    for k in SETTINGS_SKIP_KEYS:
        settings.pop(k, None)
    await db.invoice_settings.update_one(
        {"id": "app_settings"}, {"$set": settings}, upsert=True
    )
    print(
        f"  • invoice_settings · business_name = {settings.get('business_name')!r}"
    )

    # ---------- Final counts ----------
    print("\nFinal counts in Sandra's Admin DB:")
    print("  invoice_clients:", await db.invoice_clients.count_documents({}))
    print("  invoices:", await db.invoices.count_documents({}))
    print(
        "    └ active:",
        await db.invoices.count_documents({"status": {"$ne": "deleted"}}),
    )
    print(
        "    └ deleted:",
        await db.invoices.count_documents({"status": "deleted"}),
    )
    print("  invoice_settings:", await db.invoice_settings.count_documents({}))


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(1)
