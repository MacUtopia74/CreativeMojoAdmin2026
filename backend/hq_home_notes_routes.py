"""HQ note history attached to CQC / regulator entries per franchisee.

Purpose
-------
HQ often makes initial client calls on behalf of a franchisee before
their territory has fully bedded in. Every one of those touch-points
needs to be surfaced back to the franchisee — not stashed in a single
free-form text field that can be silently overwritten. Each save
appends a new entry against the same ``(franchisee_id, source, home_id)``
triple; entries are read back newest-first on both the admin panel and
the franchisee portal.

This is an **append-only HQ note history with controlled admin
deletion** — admins can remove a specific entry (e.g. for a typo) and
those deletions are separately logged to ``hq_home_note_deletions`` so
the removal itself is traceable. Franchisees have read-only access.

Model
-----
Collection: ``hq_home_notes``
    { id: uuid,
      franchisee_id: str,
      source: "cqc" | "scotland" | "wales" | "ni",
      home_id: str,
      note: str,
      updated_by: str  (admin user id or email),
      updated_by_name: str  (display name, falls back to email),
      updated_at: iso-string }

Historical note (pre-Feb-2026): the collection used to enforce a unique
composite index on (franchisee_id, source, home_id) with upsert
semantics — one row per key, overwriting on each save. On upgrade we
drop that unique index and stop upserting, so historical rows now
represent the *first* entry in the log for their key. No data is lost.

Endpoints
---------
    GET    /api/admin/franchisees/{franchisee_id}/hq-home-notes
    POST   /api/admin/franchisees/{franchisee_id}/hq-home-notes/{source}/{home_id}
    DELETE /api/admin/franchisees/{franchisee_id}/hq-home-notes/entry/{entry_id}
    GET    /api/portal/hq-home-notes            (franchisee reads own notes)

The `map` field on GET responses groups entries by
``"{source}:{home_id}"`` so the frontend can O(1) drop them onto rows.
Each map value is a list of entries in newest-first order.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel


COLLECTION = "hq_home_notes"
VALID_SOURCES = {"cqc", "scotland", "wales", "ni"}
_logger = logging.getLogger("creative-mojo-admin.hq_home_notes")


class HqNoteBody(BaseModel):
    note: str


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _entry_view(row: dict) -> dict:
    """Trim a raw Mongo row for API responses (no _id)."""
    return {
        "id": row.get("id"),
        "note": row.get("note") or "",
        "source": row.get("source"),
        "home_id": row.get("home_id"),
        "updated_at": row.get("updated_at"),
        "updated_by": row.get("updated_by"),
        "updated_by_name": row.get("updated_by_name") or row.get("updated_by") or "HQ",
    }


def _map_entries(rows: list[dict]) -> dict:
    """Group rows by ``"{source}:{home_id}"``. Each value is a list of
    entries in **newest-first** order so the UI can render straight
    from the map without a further sort."""
    grouped: dict[str, list[dict]] = {}
    for r in rows:
        key = f"{r.get('source')}:{r.get('home_id')}"
        grouped.setdefault(key, []).append(_entry_view(r))
    for k in grouped:
        grouped[k].sort(key=lambda e: (e.get("updated_at") or ""), reverse=True)
    return grouped


def attach(app, db, require_role):
    api = APIRouter()

    async def _ensure_indexes():
        """Drop the legacy unique composite index (single-note-per-key
        semantics) if it exists, and create a non-unique compound
        index on (franchisee_id, source, home_id, updated_at desc) so
        the history list stays fast. Runs once on startup; safe to
        re-run (all ops are idempotent)."""
        try:
            existing = await db[COLLECTION].index_information()
        except Exception:  # noqa: BLE001
            _logger.exception("could not list hq_home_notes indexes")
            existing = {}
        # Legacy unique index from the pre-history model.
        if "hq_home_notes_unique" in existing:
            try:
                await db[COLLECTION].drop_index("hq_home_notes_unique")
                _logger.info("dropped legacy hq_home_notes_unique index")
            except Exception:  # noqa: BLE001
                _logger.exception("failed to drop legacy hq_home_notes_unique index")
        # Non-unique index for the history read pattern.
        try:
            await db[COLLECTION].create_index(
                [("franchisee_id", 1), ("source", 1), ("home_id", 1), ("updated_at", -1)],
                name="hq_home_notes_history",
            )
        except Exception:  # noqa: BLE001
            _logger.exception("failed to create hq_home_notes_history index")

    # Kick off index setup on first import.
    import asyncio
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            loop.create_task(_ensure_indexes())
        else:
            loop.run_until_complete(_ensure_indexes())
    except Exception:  # noqa: BLE001
        pass

    @api.get("/admin/franchisees/{franchisee_id}/hq-home-notes")
    async def list_notes_admin(franchisee_id: str, _: dict = Depends(require_role("admin"))):
        rows = []
        async for r in db[COLLECTION].find(
            {"franchisee_id": franchisee_id}, {"_id": 0},
        ):
            rows.append(r)
        rows.sort(key=lambda r: (r.get("updated_at") or ""), reverse=True)
        return {
            "items": [_entry_view(r) for r in rows],
            "map": _map_entries(rows),
        }

    @api.post("/admin/franchisees/{franchisee_id}/hq-home-notes/{source}/{home_id}")
    async def append_note(
        franchisee_id: str, source: str, home_id: str,
        body: HqNoteBody,
        user: dict = Depends(require_role("admin")),
    ):
        """Append a new HQ note entry to the audit trail for this
        (franchisee, home) pair. Never overwrites — every call inserts
        a fresh row so historical entries remain visible on both the
        admin panel and the franchisee portal."""
        if source not in VALID_SOURCES:
            raise HTTPException(400, detail=f"source must be one of {sorted(VALID_SOURCES)}")
        note = (body.note or "").strip()
        if not note:
            raise HTTPException(400, detail="Note text cannot be empty. Type something in the box before saving.")
        now = _iso_now()
        actor = user.get("id") or user.get("email") or "admin"
        actor_name = (
            (f"{user.get('first_name','')} {user.get('last_name','')}".strip())
            or user.get("name")
            or user.get("email")
            or "HQ"
        )
        row = {
            "id": str(uuid.uuid4()),
            "franchisee_id": franchisee_id,
            "source": source,
            "home_id": home_id,
            "note": note,
            "updated_at": now,
            "updated_by": actor,
            "updated_by_name": actor_name,
        }
        await db[COLLECTION].insert_one(row)
        return {"ok": True, "entry": _entry_view(row)}

    @api.delete("/admin/franchisees/{franchisee_id}/hq-home-notes/entry/{entry_id}")
    async def delete_entry(
        franchisee_id: str, entry_id: str,
        user: dict = Depends(require_role("admin")),
    ):
        """Admin-only. Removes a specific entry from the history — used
        when an HQ user made a typo. Not exposed on the portal side.

        Every deletion is recorded to ``hq_home_note_deletions`` so
        removals are traceable (who deleted what, when, and the exact
        text that was removed). This is deliberately NOT a soft-delete
        on the main collection so ``GET /hq-home-notes`` remains a
        clean append-only history for the franchisee — the deletion
        log is admin-only audit exhaust."""
        row = await db[COLLECTION].find_one(
            {"franchisee_id": franchisee_id, "id": entry_id}, {"_id": 0},
        )
        if not row:
            raise HTTPException(404, detail="Entry not found for this franchisee.")
        res = await db[COLLECTION].delete_one({
            "franchisee_id": franchisee_id, "id": entry_id,
        })
        if res.deleted_count == 0:
            raise HTTPException(404, detail="Entry not found for this franchisee.")
        actor = user.get("id") or user.get("email") or "admin"
        actor_name = (
            (f"{user.get('first_name','')} {user.get('last_name','')}".strip())
            or user.get("name")
            or user.get("email")
            or "HQ"
        )
        try:
            await db["hq_home_note_deletions"].insert_one({
                "id": str(uuid.uuid4()),
                "entry_id": entry_id,
                "franchisee_id": franchisee_id,
                "source": row.get("source"),
                "home_id": row.get("home_id"),
                "note_snapshot": row.get("note"),
                "original_updated_at": row.get("updated_at"),
                "original_updated_by": row.get("updated_by"),
                "deleted_by": actor,
                "deleted_by_name": actor_name,
                "deleted_at": _iso_now(),
            })
        except Exception:  # noqa: BLE001
            _logger.exception("failed to log hq-home-note deletion")
        return {"deleted": True}

    @api.get("/portal/hq-home-notes")
    async def portal_list_notes(user: dict = Depends(require_role("franchisee"))):
        """Franchisee reads their own HQ history. Read-only — no POST /
        DELETE endpoints are exposed on the portal side. Scoped by the
        session's ``franchisee_id`` so a franchisee can never see
        another franchisee's notes."""
        fid = user.get("franchisee_id")
        if not fid:
            return {"items": [], "map": {}}
        rows = []
        async for r in db[COLLECTION].find({"franchisee_id": fid}, {"_id": 0}):
            rows.append(r)
        rows.sort(key=lambda r: (r.get("updated_at") or ""), reverse=True)
        return {
            "items": [_entry_view(r) for r in rows],
            "map": _map_entries(rows),
        }

    app.include_router(api, prefix="/api")
    return api
