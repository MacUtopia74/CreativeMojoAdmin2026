"""Read-only audit endpoint that surfaces every franchisee whose
`website_email` or `website_phone` matches ANOTHER franchisee's admin
contact — the pattern that caused Monica's popup to display Bel's email
on production (Feb 2026).

`GET  /api/admin/website-profile-audit` — list every leak, sorted by
severity (published leaks first). Writes nothing.

`POST /api/admin/website-profile-audit/clear-leaks` — bulk suppression:
for each leaked field, sets `show_website_<field>` to False. Never
overwrites the underlying `website_email` / `website_phone` value so a
franchisee's own edit is preserved and HQ can inspect the raw data
before deciding whether to clear it. Writes an audit record per
franchisee touched.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Body, Depends

logger = logging.getLogger("creative-mojo-admin.website-profile-audit")

AUDIT_LOG_COLL = "website_profile_audit_log"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _digits(v) -> str:
    return "".join(ch for ch in str(v or "") if ch.isdigit())


async def _scan(db) -> dict:
    """Read every franchisee once, then cross-check emails/phones."""
    # Build the admin-identity index
    admin_email_owner: dict[str, dict] = {}  # lower email → franchisee summary
    admin_phone_owner: dict[str, dict] = {}  # digits phone → franchisee summary
    all_rows: list[dict] = []
    async for f in db.franchisees.find(
        {},
        {"_id": 0, "id": 1, "first_name": 1, "last_name": 1,
         "franchise_number": 1, "email": 1, "phone": 1, "mobile": 1,
         "website_email": 1, "website_phone": 1,
         "show_website_email": 1, "show_website_phone": 1,
         "lifecycle_status": 1},
    ):
        all_rows.append(f)
        summary = {
            "id": f.get("id"),
            "name": f"{f.get('first_name') or ''} {f.get('last_name') or ''}".strip(),
            "franchise_number": f.get("franchise_number"),
        }
        if f.get("email"):
            admin_email_owner.setdefault(str(f["email"]).strip().lower(), summary)
        for k in ("phone", "mobile"):
            v = f.get(k)
            if v is None:
                continue
            d = _digits(v)
            if d:
                admin_phone_owner.setdefault(d, summary)

    leaks: list[dict] = []
    for f in all_rows:
        my_id = f.get("id")
        # Website email leak?
        we = str(f.get("website_email") or "").strip().lower()
        if we and we in admin_email_owner and admin_email_owner[we]["id"] != my_id:
            leaks.append({
                "franchisee": {
                    "id": my_id,
                    "name": f"{f.get('first_name') or ''} {f.get('last_name') or ''}".strip(),
                    "franchise_number": f.get("franchise_number"),
                    "lifecycle_status": f.get("lifecycle_status"),
                },
                "field": "website_email",
                "leaked_value": we,
                "belongs_to": admin_email_owner[we],
                "is_published": bool(f.get("show_website_email")),
            })
        # Website phone leak?
        wp = f.get("website_phone")
        wpd = _digits(wp)
        if wpd and wpd in admin_phone_owner and admin_phone_owner[wpd]["id"] != my_id:
            leaks.append({
                "franchisee": {
                    "id": my_id,
                    "name": f"{f.get('first_name') or ''} {f.get('last_name') or ''}".strip(),
                    "franchise_number": f.get("franchise_number"),
                    "lifecycle_status": f.get("lifecycle_status"),
                },
                "field": "website_phone",
                "leaked_value": str(wp),
                "belongs_to": admin_phone_owner[wpd],
                "is_published": bool(f.get("show_website_phone")),
            })

    # Sort: published leaks first (the ones actively exposed), then by field
    leaks.sort(key=lambda l: (0 if l["is_published"] else 1, l["field"], l["franchisee"]["name"]))

    return {
        "generated_at": _now_iso(),
        "totals": {
            "franchisees_scanned": len(all_rows),
            "leaks_total": len(leaks),
            "leaks_published_and_currently_visible": sum(1 for l in leaks if l["is_published"]),
            "leaks_email": sum(1 for l in leaks if l["field"] == "website_email"),
            "leaks_phone": sum(1 for l in leaks if l["field"] == "website_phone"),
        },
        "leaks": leaks,
    }


def build_website_profile_audit_router(db, require_role):
    router = APIRouter()

    @router.get("/admin/website-profile-audit")
    async def audit(_user: dict = Depends(require_role("admin"))):
        """Read-only scan. Writes nothing."""
        return await _scan(db)

    @router.post("/admin/website-profile-audit/clear-leaks")
    async def clear(body: dict = Body(default={}),
                    user: dict = Depends(require_role("admin"))):
        """Suppress every currently-published leak by setting the
        matching `show_website_*` flag to False.

        * NEVER overwrites `website_email` / `website_phone` — the raw
          value is preserved so HQ can inspect what the franchisee had.
        * NEVER touches any other field.
        * Idempotent — re-running on a clean dataset is a no-op.
        * Writes one audit row per franchisee touched.
        """
        confirm = (body or {}).get("confirm")
        if confirm != "CLEAR-LEAKS":
            return {
                "status": "refused",
                "reason": "confirmation_missing",
                "hint": "POST body must contain {\"confirm\": \"CLEAR-LEAKS\"}",
            }
        report = await _scan(db)
        touched: list[dict] = []
        for leak in report["leaks"]:
            if not leak["is_published"]:
                continue
            fid = leak["franchisee"]["id"]
            flag = "show_website_email" if leak["field"] == "website_email" else "show_website_phone"
            await db.franchisees.update_one(
                {"id": fid}, {"$set": {flag: False}}
            )
            audit_row = {
                "id": str(uuid.uuid4()),
                "at": _now_iso(),
                "actor": user.get("email", "unknown"),
                "franchisee_id": fid,
                "franchisee_name": leak["franchisee"]["name"],
                "franchise_number": leak["franchisee"]["franchise_number"],
                "action": f"suppress_{flag}",
                "field": leak["field"],
                "leaked_value": leak["leaked_value"],
                "leaked_belongs_to": leak["belongs_to"],
            }
            await db[AUDIT_LOG_COLL].insert_one(audit_row)
            touched.append(audit_row)
            logger.warning(
                "[website-profile-audit] suppressed %s on %s (leaked value belonged to %s)",
                flag, leak["franchisee"]["name"], leak["belongs_to"]["name"],
            )
        return {
            "status": "ok",
            "cleared_count": len(touched),
            "touched": touched,
            "guarantees": {
                "writes_only": [
                    "franchisees.show_website_email (single boolean per row, set to False)",
                    "franchisees.show_website_phone (single boolean per row, set to False)",
                    f"{AUDIT_LOG_COLL} (one audit row per touched franchisee)",
                ],
                "no_writes_to": [
                    "franchisees.website_email (raw value preserved)",
                    "franchisees.website_phone (raw value preserved)",
                    "any other franchisee field",
                    "franchisee_clients", "hq_home_notes", "contacts", "email_sends",
                ],
            },
        }

    return router
