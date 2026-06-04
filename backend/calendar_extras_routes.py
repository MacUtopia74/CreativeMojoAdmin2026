"""Calendar extras — yearly HQ events (admin-managed) + per-franchisee
personal entries (portal-managed).

Sits alongside ``calendar_routes`` which owns the Google Calendar
integration. These extras live entirely in Mongo so they keep working
even if HQ haven't connected Google Calendar yet.

Collections
-----------
``calendar_yearly_events``
    {
      id, date_iso (YYYY-MM-DD), title, source ("csv"|"manual"),
      uploaded_at, uploaded_by,
    }
    Visible to every authenticated user on the portal. Rendered as a
    solid light-blue block with white text + a "Yearly Events" entry in
    the portal calendar legend.

``calendar_franchisee_events``
    {
      id, franchisee_id, title, start (ISO), end (ISO), all_day,
      location, notes, created_at, created_by,
    }
    Strictly scoped to the franchisee who owns it — never returned to
    other franchisees or admins via the portal endpoints.

Endpoints
---------
**Admin**
  * ``POST   /api/admin/calendar/yearly-events/upload``  CSV upload
  * ``GET    /api/admin/calendar/yearly-events``         list
  * ``POST   /api/admin/calendar/yearly-events``         single add
  * ``DELETE /api/admin/calendar/yearly-events/{id}``    delete one
  * ``DELETE /api/admin/calendar/yearly-events``         wipe all

**Portal** (any authenticated user)
  * ``GET  /api/portal/calendar/yearly-events``          read-only list
  * ``GET  /api/portal/calendar/my-events``              franchisee's own
  * ``POST /api/portal/calendar/my-events``              create
  * ``PATCH /api/portal/calendar/my-events/{id}``        update
  * ``DELETE /api/portal/calendar/my-events/{id}``       delete
"""
from __future__ import annotations

import csv
import io
import logging
import re
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel, Field

logger = logging.getLogger("creative-mojo-admin.calendar_extras")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# --------------------------------------------------------------- CSV parsing
_DATE_PATTERNS = (
    # 25/12/2026 — UK-first, as agreed with Paul
    (re.compile(r"^\s*(\d{1,2})/(\d{1,2})/(\d{4})\s*$"), ("d", "m", "y")),
    # 2026-12-25 ISO
    (re.compile(r"^\s*(\d{4})-(\d{1,2})-(\d{1,2})\s*$"), ("y", "m", "d")),
    # 25-12-2026 dash-UK
    (re.compile(r"^\s*(\d{1,2})-(\d{1,2})-(\d{4})\s*$"), ("d", "m", "y")),
    # 25/12 short (recurs yearly — stored against the current year so
    # admins can simply re-upload each January)
    (re.compile(r"^\s*(\d{1,2})/(\d{1,2})\s*$"), ("d", "m")),
)


def _parse_csv_date(raw: str) -> Optional[str]:
    """Parse a single date cell into YYYY-MM-DD. Returns None on failure."""
    if not raw:
        return None
    for rx, order in _DATE_PATTERNS:
        m = rx.match(raw)
        if not m:
            continue
        groups = dict(zip(order, m.groups()))
        try:
            day = int(groups["d"])
            month = int(groups["m"])
            year = int(groups.get("y") or datetime.now(timezone.utc).year)
            return datetime(year, month, day).strftime("%Y-%m-%d")
        except (KeyError, ValueError):
            return None
    return None


def _parse_csv(blob: bytes) -> tuple[list[dict], list[str]]:
    """Parse the uploaded CSV. Returns ``(rows, errors)`` where rows is a
    list of ``{date_iso, title}`` dicts and errors is a human-readable
    list of per-line problems (truncated to 20 entries)."""
    text = blob.decode("utf-8-sig", errors="replace")
    reader = csv.reader(io.StringIO(text))
    rows: list[dict] = []
    errors: list[str] = []
    first = True
    for line_no, parts in enumerate(reader, start=1):
        if not parts:
            continue
        # Trim trailing empty cells (Excel padding)
        while parts and not (parts[-1] or "").strip():
            parts.pop()
        if not parts:
            continue
        # Skip an optional header row when the first cell is non-numeric
        # ("date", "Date", "DATE", etc.). Only fires once on row 1.
        if first:
            first = False
            head = (parts[0] or "").strip().lower()
            if head in {"date", "dates", "day", "when"}:
                continue
        if len(parts) < 2:
            errors.append(f"Line {line_no}: needs both date and event title.")
            continue
        date_iso = _parse_csv_date(parts[0])
        title = (parts[1] or "").strip()
        if not date_iso:
            errors.append(f"Line {line_no}: couldn't parse date '{parts[0]}'.")
            continue
        if not title:
            errors.append(f"Line {line_no}: missing event title.")
            continue
        rows.append({"date_iso": date_iso, "title": title[:300]})
    return rows, errors[:20]


# ---------------------------------------------------------------- Pydantic
class YearlyEventIn(BaseModel):
    date_iso: str = Field(..., description="YYYY-MM-DD")
    title: str = Field(..., min_length=1, max_length=300)


class FranchiseeEventIn(BaseModel):
    title: str = Field(..., min_length=1, max_length=300)
    start: str = Field(..., description="ISO 8601")
    end: str = Field(..., description="ISO 8601")
    all_day: bool = False
    location: Optional[str] = Field(None, max_length=500)
    notes: Optional[str] = Field(None, max_length=2000)


def _shape_yearly(doc: dict) -> dict:
    return {
        "id": doc.get("id"),
        "date_iso": doc.get("date_iso"),
        "title": doc.get("title"),
        "source": doc.get("source"),
        "uploaded_at": doc.get("uploaded_at"),
        "uploaded_by": doc.get("uploaded_by"),
    }


def _shape_franchisee(doc: dict) -> dict:
    return {
        "id": doc.get("id"),
        "title": doc.get("title"),
        "start": doc.get("start"),
        "end": doc.get("end"),
        "all_day": bool(doc.get("all_day")),
        "location": doc.get("location"),
        "notes": doc.get("notes"),
        "created_at": doc.get("created_at"),
    }


def attach(api, db, require_role, get_current_user):
    router = APIRouter()

    # =========================== ADMIN: yearly events =====================
    @router.post("/admin/calendar/yearly-events/upload")
    async def upload_yearly_csv(
        file: UploadFile = File(...),
        replace: bool = False,
        user: dict = Depends(require_role("admin")),
    ):
        """Upload a CSV of date,event pairs. By default new rows are
        merged with the existing list — pass ``replace=true`` to wipe and
        re-seed (e.g. when rolling a fresh year's calendar). Returns a
        per-row summary so the admin can see exactly what got imported.
        """
        if not file.filename or not file.filename.lower().endswith((".csv", ".txt")):
            raise HTTPException(400, detail="Please upload a .csv file.")
        blob = await file.read()
        if len(blob) > 2_000_000:
            raise HTTPException(413, detail="File too large (max 2 MB).")
        parsed, errors = _parse_csv(blob)
        if not parsed:
            raise HTTPException(
                400,
                detail={
                    "message": "No valid rows found in the uploaded CSV.",
                    "errors": errors,
                },
            )
        if replace:
            await db.calendar_yearly_events.delete_many({})
        # De-dupe by (date_iso, title) so accidental re-uploads don't
        # create twins. Existing rows keep their original id/uploaded_at.
        existing_keys: set[tuple[str, str]] = set()
        async for d in db.calendar_yearly_events.find(
            {}, {"_id": 0, "date_iso": 1, "title": 1},
        ):
            existing_keys.add((d.get("date_iso"), (d.get("title") or "").strip().lower()))
        now = _now_iso()
        inserted = 0
        skipped = 0
        for row in parsed:
            key = (row["date_iso"], row["title"].strip().lower())
            if key in existing_keys:
                skipped += 1
                continue
            doc = {
                "id": str(uuid.uuid4()),
                "date_iso": row["date_iso"],
                "title": row["title"],
                "source": "csv",
                "uploaded_at": now,
                "uploaded_by": user.get("email"),
            }
            await db.calendar_yearly_events.insert_one(doc)
            existing_keys.add(key)
            inserted += 1
        return {
            "ok": True,
            "inserted": inserted,
            "skipped_duplicates": skipped,
            "errors": errors,
            "total_in_csv": len(parsed),
        }

    @router.get("/admin/calendar/yearly-events")
    async def list_yearly_admin(_: dict = Depends(require_role("admin"))):
        items: list[dict] = []
        async for d in db.calendar_yearly_events.find({}, {"_id": 0}).sort("date_iso", 1):
            items.append(_shape_yearly(d))
        return {"items": items, "total": len(items)}

    @router.post("/admin/calendar/yearly-events")
    async def add_yearly_admin(body: YearlyEventIn, user: dict = Depends(require_role("admin"))):
        # Validate date format
        try:
            datetime.strptime(body.date_iso, "%Y-%m-%d")
        except ValueError as exc:
            raise HTTPException(400, detail="date_iso must be YYYY-MM-DD") from exc
        doc = {
            "id": str(uuid.uuid4()),
            "date_iso": body.date_iso,
            "title": body.title.strip(),
            "source": "manual",
            "uploaded_at": _now_iso(),
            "uploaded_by": user.get("email"),
        }
        await db.calendar_yearly_events.insert_one(doc)
        return _shape_yearly(doc)

    @router.delete("/admin/calendar/yearly-events/{event_id}")
    async def delete_yearly_admin(event_id: str, _: dict = Depends(require_role("admin"))):
        r = await db.calendar_yearly_events.delete_one({"id": event_id})
        if not r.deleted_count:
            raise HTTPException(404, detail="Event not found")
        return {"ok": True}

    @router.delete("/admin/calendar/yearly-events")
    async def wipe_yearly_admin(_: dict = Depends(require_role("admin"))):
        r = await db.calendar_yearly_events.delete_many({})
        return {"ok": True, "deleted": r.deleted_count}

    # =========================== PORTAL: yearly events ====================
    @router.get("/portal/calendar/yearly-events")
    async def list_yearly_portal(_user: dict = Depends(get_current_user)):
        items: list[dict] = []
        async for d in db.calendar_yearly_events.find({}, {"_id": 0}).sort("date_iso", 1):
            items.append(_shape_yearly(d))
        return {"items": items, "total": len(items)}

    # =========================== PORTAL: my events ========================
    def _fid(user: dict) -> str:
        fid = (user or {}).get("franchisee_id")
        if not fid:
            raise HTTPException(403, detail="Franchisee account required")
        return fid

    @router.get("/portal/calendar/my-events")
    async def list_my_events(user: dict = Depends(require_role("franchisee"))):
        fid = _fid(user)
        items: list[dict] = []
        async for d in db.calendar_franchisee_events.find(
            {"franchisee_id": fid}, {"_id": 0},
        ).sort("start", 1):
            items.append(_shape_franchisee(d))
        return {"items": items, "total": len(items)}

    @router.post("/portal/calendar/my-events")
    async def create_my_event(
        body: FranchiseeEventIn, user: dict = Depends(require_role("franchisee")),
    ):
        fid = _fid(user)
        # Normalise to YYYY-MM-DD for all-day so FullCalendar renders them
        # as a single tile instead of a 24h spanning block.
        start = body.start[:10] if body.all_day else body.start
        end = body.end[:10] if body.all_day else body.end
        doc = {
            "id": str(uuid.uuid4()),
            "franchisee_id": fid,
            "title": body.title.strip(),
            "start": start,
            "end": end,
            "all_day": body.all_day,
            "location": (body.location or "").strip() or None,
            "notes": (body.notes or "").strip() or None,
            "created_at": _now_iso(),
            "created_by": user.get("email"),
        }
        await db.calendar_franchisee_events.insert_one(doc)
        return _shape_franchisee(doc)

    @router.patch("/portal/calendar/my-events/{event_id}")
    async def update_my_event(
        event_id: str,
        body: dict,
        user: dict = Depends(require_role("franchisee")),
    ):
        fid = _fid(user)
        update: dict = {}
        if "title" in body and body["title"]:
            update["title"] = str(body["title"]).strip()[:300]
        if "start" in body and body["start"]:
            update["start"] = body["start"][:10] if body.get("all_day") else body["start"]
        if "end" in body and body["end"]:
            update["end"] = body["end"][:10] if body.get("all_day") else body["end"]
        if "all_day" in body:
            update["all_day"] = bool(body["all_day"])
        if "location" in body:
            update["location"] = (body["location"] or "").strip() or None
        if "notes" in body:
            update["notes"] = (body["notes"] or "").strip() or None
        if not update:
            raise HTTPException(400, detail="Nothing to update")
        r = await db.calendar_franchisee_events.update_one(
            {"id": event_id, "franchisee_id": fid},
            {"$set": update},
        )
        if not r.matched_count:
            raise HTTPException(404, detail="Event not found")
        doc = await db.calendar_franchisee_events.find_one(
            {"id": event_id, "franchisee_id": fid}, {"_id": 0},
        )
        return _shape_franchisee(doc or {})

    @router.delete("/portal/calendar/my-events/{event_id}")
    async def delete_my_event(
        event_id: str, user: dict = Depends(require_role("franchisee")),
    ):
        fid = _fid(user)
        r = await db.calendar_franchisee_events.delete_one(
            {"id": event_id, "franchisee_id": fid},
        )
        if not r.deleted_count:
            raise HTTPException(404, detail="Event not found")
        return {"ok": True}

    return router
