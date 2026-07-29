"""Read-only audit endpoint that surfaces every franchisee whose
`website_email` or `website_phone` matches ANOTHER franchisee's admin
contact — OR whose website_email local-part obviously belongs to
another franchisee by name (the Feb-2026 Monica → Bel pattern).

`GET  /api/admin/website-profile-audit` — list every leak, sorted by
severity (published leaks first). Writes nothing.

`POST /api/admin/website-profile-audit/clear-leaks` — bulk suppression:
for each leaked field, sets `show_website_<field>` to False. Never
overwrites the underlying `website_email` / `website_phone` value so a
franchisee's own edit is preserved and HQ can inspect the raw data
before deciding whether to clear it. Writes an audit record per
franchisee touched.

`GET  /api/admin/wp-bio-migration/dry-run.csv` — authenticated download
of the WordPress → live-franchisee biography matching report used to
approve the July-2026 backfill. Admin-only.

`GET  /api/admin/wp-bio-migration/log` — read-only view of the durable
per-franchisee audit log written by `scripts/wp_bio_backfill.py`.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Body, Depends, HTTPException
from fastapi.responses import FileResponse

logger = logging.getLogger("creative-mojo-admin.website-profile-audit")

AUDIT_LOG_COLL = "website_profile_audit_log"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _digits(v) -> str:
    return "".join(ch for ch in str(v or "") if ch.isdigit())


def _name_variants(first: str, last: str) -> set[str]:
    first = (first or "").strip().lower()
    last = (last or "").strip().lower()
    out: set[str] = set()
    if first:
        out.update({first, first.replace(" ", "")})
    if last:
        out.update({last, last.replace(" ", "")})
    if first and last:
        out.update({f"{first}.{last}", f"{first}{last}",
                    f"{first[0]}{last}", f"{first}.{last[0]}"})
    return {v for v in out if v and len(v) >= 3}


async def _scan(db) -> dict:
    """Read every franchisee once. Cross-check emails/phones/names.

    Strong matches (full-name local-parts) → high confidence, single owner.
    Weak matches (first-name-only local-parts) → LOW confidence, may map
    to multiple franchisees; the report lists every possible owner so
    HQ can decide which one it really belongs to.
    """
    admin_email_owner: dict[str, dict] = {}
    admin_phone_owner: dict[str, dict] = {}
    strong_owner: dict[str, list[dict]] = {}   # local → list of owners
    weak_owner: dict[str, list[dict]] = {}
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
        first = str(f.get("first_name") or "").strip().lower()
        last = str(f.get("last_name") or "").strip().lower()
        strong_variants: set[str] = set()
        weak_variants: set[str] = set()
        if first and len(first) >= 3:
            weak_variants.update({first, first.replace(" ", "")})
        if last and len(last) >= 3:
            weak_variants.update({last, last.replace(" ", "")})
        if first and last:
            for v in (f"{first}.{last}", f"{first}{last}",
                      f"{first[0]}{last}", f"{first}.{last[0]}"):
                if v and len(v) >= 4:
                    strong_variants.add(v)
        for v in strong_variants:
            strong_owner.setdefault(v, []).append(summary)
        for v in weak_variants:
            if v not in strong_variants:
                weak_owner.setdefault(v, []).append(summary)

    try:
        async for u in db.users.find({}, {"_id": 0, "email": 1, "franchisee_id": 1}):
            if u.get("email") and u.get("franchisee_id"):
                admin_email_owner.setdefault(
                    str(u["email"]).strip().lower(),
                    {"id": u["franchisee_id"], "name": "(from users collection)",
                     "franchise_number": None},
                )
    except Exception:  # noqa: BLE001
        pass

    leaks: list[dict] = []
    for f in all_rows:
        my_id = f.get("id")
        # Franchisee's own name-variants — don't self-flag
        first = str(f.get("first_name") or "").strip().lower()
        last = str(f.get("last_name") or "").strip().lower()
        own_locals: set[str] = set()
        if first:
            own_locals.update({first, first.replace(" ", "")})
        if last:
            own_locals.update({last, last.replace(" ", "")})
        if first and last:
            own_locals.update({f"{first}.{last}", f"{first}{last}",
                               f"{first[0]}{last}", f"{first}.{last[0]}"})

        summary_self = {
            "id": my_id,
            "name": f"{f.get('first_name') or ''} {f.get('last_name') or ''}".strip(),
            "franchise_number": f.get("franchise_number"),
            "lifecycle_status": f.get("lifecycle_status"),
        }

        we_raw = str(f.get("website_email") or "").strip()
        we = we_raw.lower()
        matched = False

        # 1) Direct admin-email match — HIGH confidence
        if we and we in admin_email_owner and admin_email_owner[we]["id"] != my_id:
            leaks.append({
                "franchisee": summary_self,
                "field": "website_email",
                "leaked_value": we_raw,
                "reason": "matches_other_admin_email",
                "confidence": "high",
                "candidate_owners": [admin_email_owner[we]],
                "is_published": bool(f.get("show_website_email")),
            })
            matched = True
        elif we:
            local = we.split("@", 1)[0]
            local_stripped = local.replace(".", "").replace("_", "").replace("-", "")
            # 2) Strong name match — HIGH confidence
            for probe in (local, local_stripped):
                if probe in strong_owner and probe not in own_locals:
                    owners = [o for o in strong_owner[probe] if o["id"] != my_id]
                    if owners:
                        leaks.append({
                            "franchisee": summary_self,
                            "field": "website_email",
                            "leaked_value": we_raw,
                            "reason": "email_local_part_matches_other_franchisee_full_name",
                            "confidence": "high",
                            "candidate_owners": owners,
                            "is_published": bool(f.get("show_website_email")),
                        })
                        matched = True
                        break
            # 3) Weak (first-name-only) match — LOW confidence; list all candidates
            if not matched:
                for probe in (local, local_stripped):
                    if probe in weak_owner and probe not in own_locals:
                        owners = [o for o in weak_owner[probe] if o["id"] != my_id]
                        if owners:
                            leaks.append({
                                "franchisee": summary_self,
                                "field": "website_email",
                                "leaked_value": we_raw,
                                "reason": "email_local_part_matches_other_franchisee_first_or_last_name",
                                "confidence": "low",
                                "candidate_owners": owners,
                                "is_published": bool(f.get("show_website_email")),
                                "review_note": (
                                    f"'{probe}' is a shared name; "
                                    f"{len(owners)} franchisee(s) could match. HQ to review "
                                    "before suppressing."
                                ),
                            })
                            break

        # 4) Phone match
        wp = f.get("website_phone")
        wpd = _digits(wp)
        if wpd and wpd in admin_phone_owner and admin_phone_owner[wpd]["id"] != my_id:
            leaks.append({
                "franchisee": summary_self,
                "field": "website_phone",
                "leaked_value": str(wp),
                "reason": "matches_other_admin_phone",
                "confidence": "high",
                "candidate_owners": [admin_phone_owner[wpd]],
                "is_published": bool(f.get("show_website_phone")),
            })

    # Sort: published first, then high-confidence, then by name
    leaks.sort(key=lambda l: (
        0 if l["is_published"] else 1,
        0 if l.get("confidence") == "high" else 1,
        l["field"],
        l["franchisee"]["name"],
    ))

    return {
        "generated_at": _now_iso(),
        "totals": {
            "franchisees_scanned": len(all_rows),
            "leaks_total": len(leaks),
            "leaks_published_and_currently_visible": sum(1 for l in leaks if l["is_published"]),
            "leaks_high_confidence": sum(1 for l in leaks if l.get("confidence") == "high"),
            "leaks_low_confidence": sum(1 for l in leaks if l.get("confidence") == "low"),
            "leaks_email": sum(1 for l in leaks if l["field"] == "website_email"),
            "leaks_phone": sum(1 for l in leaks if l["field"] == "website_phone"),
        },
        "leaks": leaks,
    }


def build_website_profile_audit_router(db, require_role):
    router = APIRouter()

    @router.get("/admin/website-profile-audit")
    async def audit(_user: dict = Depends(require_role("admin"))):
        return await _scan(db)

    @router.post("/admin/website-profile-audit/clear-leaks")
    async def clear(body: dict = Body(default={}),
                    user: dict = Depends(require_role("admin"))):
        confirm = (body or {}).get("confirm")
        if confirm != "CLEAR-LEAKS":
            return {
                "status": "refused",
                "reason": "confirmation_missing",
                "hint": "POST body must contain {\"confirm\": \"CLEAR-LEAKS\"}",
            }
        report = await _scan(db)
        touched: list[dict] = []
        skipped_low_confidence: list[dict] = []
        for leak in report["leaks"]:
            if not leak["is_published"]:
                continue
            if leak.get("confidence") == "low":
                # Never bulk-clear a low-confidence (shared-name) leak.
                # HQ must review these one-by-one via the audit table.
                skipped_low_confidence.append(leak)
                continue
            fid = leak["franchisee"]["id"]
            flag = "show_website_email" if leak["field"] == "website_email" else "show_website_phone"
            await db.franchisees.update_one({"id": fid}, {"$set": {flag: False}})
            audit_row = {
                "id": str(uuid.uuid4()),
                "at": _now_iso(),
                "actor": user.get("email", "unknown"),
                "franchisee_id": fid,
                "franchisee_name": leak["franchisee"]["name"],
                "franchise_number": leak["franchisee"]["franchise_number"],
                "action": f"suppress_{flag}",
                "field": leak["field"],
                "reason": leak.get("reason"),
                "confidence": leak.get("confidence"),
                "leaked_value": leak["leaked_value"],
                "leaked_belongs_to": leak.get("candidate_owners"),
            }
            await db[AUDIT_LOG_COLL].insert_one(audit_row)
            touched.append(audit_row)
            logger.warning(
                "[website-profile-audit] suppressed %s on %s (reason=%s, belongs_to=%s)",
                flag, leak["franchisee"]["name"],
                leak.get("reason"), leak["belongs_to"]["name"],
            )
        return {
            "status": "ok",
            "cleared_count": len(touched),
            "skipped_low_confidence_count": len(skipped_low_confidence),
            "skipped_low_confidence": [
                {"franchisee": l["franchisee"], "reason": l.get("review_note")}
                for l in skipped_low_confidence
            ],
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

    # ---- WordPress → website_bio backfill: admin-only artefacts -----------
    WP_BIO_LOG_COLL = "website_bio_migration_log"
    WP_BIO_DRY_RUN_CSV = Path(__file__).parent / "static" / "wp_bio_dry_run_2026-07-29.csv"

    @router.get("/admin/wp-bio-migration/dry-run.csv")
    async def download_wp_bio_dry_run(
        _user: dict = Depends(require_role("admin")),
    ):
        """Authenticated download of the WordPress-export → live
        franchisee matching report. Deliberately NOT mounted on any
        public static path — access requires an admin JWT."""
        if not WP_BIO_DRY_RUN_CSV.exists():
            raise HTTPException(
                status_code=404,
                detail="wp_bio_dry_run report not found on disk",
            )
        return FileResponse(
            path=str(WP_BIO_DRY_RUN_CSV),
            media_type="text/csv",
            filename="wp_bio_dry_run_2026-07-29.csv",
        )

    @router.get("/admin/wp-bio-migration/log")
    async def wp_bio_migration_log(
        _user: dict = Depends(require_role("admin")),
    ):
        """Read-only view of the durable per-franchisee audit rows
        written by `scripts/wp_bio_backfill.py`. Useful for the admin
        UI to show what happened, when, and by which script version."""
        rows: list[dict] = []
        async for r in db[WP_BIO_LOG_COLL].find(
            {}, {"_id": 0}
        ).sort([("franchise_number", 1), ("migrated_at", 1)]):
            # Normalise datetime → ISO for JSON.
            if isinstance(r.get("migrated_at"), datetime):
                r["migrated_at"] = r["migrated_at"].isoformat()
            rows.append(r)
        by_action: dict[str, int] = {}
        for r in rows:
            by_action[r.get("action", "unknown")] = (
                by_action.get(r.get("action", "unknown"), 0) + 1
            )
        return {
            "total_rows": len(rows),
            "by_action": by_action,
            "rows": rows,
        }

    return router
