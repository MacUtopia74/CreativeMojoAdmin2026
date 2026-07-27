"""HQ notes attached to CQC / regulator entries per franchisee.

Purpose
-------
HQ often makes initial client calls on behalf of a franchisee before
that franchisee's territory has fully bedded in. They need a place to
scribble a short note against a specific care home (e.g. "spoke to
Kate on 12 Feb, revisit in April") so the intelligence isn't lost.

**Deliberately decoupled from ``franchisee_clients``.**  The note lives
against the CQC entry, keyed by ``(franchisee_id, source, home_id)``.
Basic-MyTerritory franchisees don't have a ``franchisee_clients`` doc,
and HQ still needs to be able to leave notes for them — auto-creating
those docs would silently promote a home to "my client" from the
franchisee's point of view, which is not what we want.

Model
-----
Collection: ``hq_home_notes``
    { id: uuid,
      franchisee_id: str,
      source: "cqc" | "scotland" | "wales" | "ni",
      home_id: str,
      note: str,
      updated_by: str  (admin user id),
      updated_at: iso-string }

Uniqueness: (franchisee_id, source, home_id).  Upsert semantics —
saving an empty note deletes the row so we never end up with orphaned
blank annotations.

Endpoints
---------
    GET    /api/admin/franchisees/{franchisee_id}/hq-home-notes
    PUT    /api/admin/franchisees/{franchisee_id}/hq-home-notes/{source}/{home_id}
    DELETE /api/admin/franchisees/{franchisee_id}/hq-home-notes/{source}/{home_id}
    GET    /api/portal/hq-home-notes            (franchisee reads own notes)
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel


COLLECTION = "hq_home_notes"
VALID_SOURCES = {"cqc", "scotland", "wales", "ni"}


class HqNoteBody(BaseModel):
    note: Optional[str] = ""


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def attach(app, db, require_role):
    api = APIRouter()

    async def _ensure_indexes():
        try:
            await db[COLLECTION].create_index(
                [("franchisee_id", 1), ("source", 1), ("home_id", 1)],
                unique=True, name="hq_home_notes_unique",
            )
        except Exception:  # noqa: BLE001 — index may already exist
            pass

    # Kick off index creation on first import.
    import asyncio
    try: asyncio.get_event_loop().create_task(_ensure_indexes())
    except Exception: pass

    def _map_notes(rows):
        """Return a dict keyed by ``"{source}:{home_id}"`` so the
        frontend can drop a note onto a row in O(1)."""
        out = {}
        for r in rows:
            key = f"{r.get('source')}:{r.get('home_id')}"
            out[key] = {
                "note": r.get("note") or "",
                "updated_at": r.get("updated_at"),
                "updated_by": r.get("updated_by"),
            }
        return out

    @api.get("/admin/franchisees/{franchisee_id}/hq-home-notes")
    async def list_notes(franchisee_id: str, user: dict = Depends(require_role("admin"))):
        rows = []
        async for r in db[COLLECTION].find(
            {"franchisee_id": franchisee_id}, {"_id": 0},
        ):
            rows.append(r)
        return {"items": rows, "map": _map_notes(rows)}

    @api.put("/admin/franchisees/{franchisee_id}/hq-home-notes/{source}/{home_id}")
    async def upsert_note(
        franchisee_id: str, source: str, home_id: str,
        body: HqNoteBody,
        user: dict = Depends(require_role("admin")),
    ):
        if source not in VALID_SOURCES:
            raise HTTPException(400, detail=f"source must be one of {sorted(VALID_SOURCES)}")
        note = (body.note or "").strip()
        # Empty note deletes the row — keeps the collection tidy and
        # avoids orphaned blank annotations cluttering the portal.
        if not note:
            await db[COLLECTION].delete_one({
                "franchisee_id": franchisee_id,
                "source": source, "home_id": home_id,
            })
            return {"deleted": True}
        now = _iso_now()
        actor = user.get("id") or user.get("email") or "admin"
        res = await db[COLLECTION].update_one(
            {"franchisee_id": franchisee_id, "source": source, "home_id": home_id},
            {
                "$set": {"note": note, "updated_at": now, "updated_by": actor},
                "$setOnInsert": {"id": str(uuid.uuid4())},
            },
            upsert=True,
        )
        return {"ok": True, "created": res.upserted_id is not None,
                "note": note, "updated_at": now, "updated_by": actor}

    @api.delete("/admin/franchisees/{franchisee_id}/hq-home-notes/{source}/{home_id}")
    async def delete_note(
        franchisee_id: str, source: str, home_id: str,
        user: dict = Depends(require_role("admin")),
    ):
        r = await db[COLLECTION].delete_one({
            "franchisee_id": franchisee_id, "source": source, "home_id": home_id,
        })
        return {"deleted": r.deleted_count}

    @api.get("/portal/hq-home-notes")
    async def portal_list_notes(user: dict = Depends(require_role("franchisee"))):
        """Franchisee reads HQ's notes for their own homes. Read-only —
        no PUT/DELETE exposed on the portal side. HQ notes are visible
        to Plus franchisees; Basic franchisees don't have a My
        Territory+ list to display them in, so the endpoint still
        returns them (harmless) — the portal UI decides whether to
        show the panel."""
        fid = user.get("franchisee_id")
        if not fid:
            return {"items": [], "map": {}}
        rows = []
        async for r in db[COLLECTION].find({"franchisee_id": fid}, {"_id": 0}):
            rows.append(r)
        return {"items": rows, "map": _map_notes(rows)}

    app.include_router(api, prefix="/api")
    return api
