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
from calendar import monthrange
from datetime import datetime, timedelta, timezone
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
    # Optional recurrence — when set, the create endpoint clones the
    # base event N times in the DB so each occurrence is editable /
    # deletable on its own. All clones share a ``series_id`` so we can
    # implement a "delete the whole series" action later if needed.
    repeat: Optional[str] = Field(
        None,
        description='"weekly" | "fortnightly" | "monthly"',
    )
    repeat_until: Optional[str] = Field(
        None, description="YYYY-MM-DD — last occurrence date (inclusive)",
    )


_REPEAT_DAY_STEPS = {"weekly": 7, "fortnightly": 14}


def _expand_occurrences(base_start: datetime, base_end: datetime,
                        repeat: str, repeat_until: datetime) -> list[tuple[datetime, datetime]]:
    """Yield ``(start, end)`` tuples for every occurrence from the
    first repeat onwards (the base event is inserted separately).
    Caps at 200 occurrences so a runaway repeat-until can't fill the DB.
    """
    out: list[tuple[datetime, datetime]] = []
    cur_start = base_start
    cur_end = base_end
    for _ in range(200):
        if repeat in _REPEAT_DAY_STEPS:
            days = _REPEAT_DAY_STEPS[repeat]
            cur_start = cur_start + timedelta(days=days)
            cur_end = cur_end + timedelta(days=days)
        elif repeat == "monthly":
            # Bump month by 1, clamp day to month length.
            y, m, d = cur_start.year, cur_start.month + 1, cur_start.day
            if m == 13:
                y, m = y + 1, 1
            last_day = monthrange(y, m)[1]
            day = min(d, last_day)
            delta = datetime(y, m, day, cur_start.hour, cur_start.minute) - cur_start.replace(tzinfo=None)
            cur_start = cur_start + delta
            cur_end = cur_end + delta
        else:
            break
        if cur_start.date() > repeat_until.date():
            break
        out.append((cur_start, cur_end))
    return out


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
        "series_id": doc.get("series_id"),
        "repeat": doc.get("repeat"),
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
        repeat = (body.repeat or "").lower().strip() or None
        if repeat and repeat not in {"weekly", "fortnightly", "monthly"}:
            raise HTTPException(400, detail="repeat must be weekly, fortnightly or monthly")
        # Determine the recurrence horizon. Defaults to 12 months out
        # so franchisees don't have to think about an end-date for
        # routine "weekly visit to such-and-such care home".
        repeat_until_iso = (body.repeat_until or "").strip() or None
        series_id: str | None = None
        # Insert the base event.
        now = _now_iso()
        base_id = str(uuid.uuid4())
        if repeat:
            series_id = str(uuid.uuid4())
        base_doc = {
            "id": base_id,
            "franchisee_id": fid,
            "title": body.title.strip(),
            "start": start,
            "end": end,
            "all_day": body.all_day,
            "location": (body.location or "").strip() or None,
            "notes": (body.notes or "").strip() or None,
            "created_at": now,
            "created_by": user.get("email"),
            "series_id": series_id,
            "repeat": repeat,
        }
        await db.calendar_franchisee_events.insert_one(base_doc)
        # Strip the auto-injected ``_id`` so the next inserts don't
        # collide on the same id. We've already kept our own uuid in
        # ``id``; Mongo will pick a new ObjectId for each insert.
        base_doc.pop("_id", None)

        # Expand occurrences. We need real datetimes for date math, so
        # parse the base start/end into UTC-aware datetimes.
        if repeat:
            try:
                if body.all_day:
                    base_start_dt = datetime.strptime(start, "%Y-%m-%d").replace(tzinfo=timezone.utc)
                    base_end_dt = datetime.strptime(end, "%Y-%m-%d").replace(tzinfo=timezone.utc)
                else:
                    base_start_dt = datetime.fromisoformat(start.replace("Z", "+00:00"))
                    base_end_dt = datetime.fromisoformat(end.replace("Z", "+00:00"))
            except ValueError:
                raise HTTPException(400, detail="start/end must be ISO 8601") from None
            if repeat_until_iso:
                try:
                    repeat_until_dt = datetime.strptime(repeat_until_iso[:10], "%Y-%m-%d").replace(tzinfo=timezone.utc)
                except ValueError as exc:
                    raise HTTPException(400, detail="repeat_until must be YYYY-MM-DD") from exc
            else:
                # Default horizon: 12 months ahead of the base event.
                repeat_until_dt = base_start_dt + timedelta(days=365)
            occurrences = _expand_occurrences(base_start_dt, base_end_dt, repeat, repeat_until_dt)
            for occ_start, occ_end in occurrences:
                clone = {
                    **base_doc,
                    "id": str(uuid.uuid4()),
                    "start": occ_start.strftime("%Y-%m-%d") if body.all_day
                             else occ_start.isoformat(),
                    "end": occ_end.strftime("%Y-%m-%d") if body.all_day
                           else occ_end.isoformat(),
                }
                await db.calendar_franchisee_events.insert_one(clone)
        return _shape_franchisee(base_doc)

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
        event_id: str,
        series: bool = False,
        user: dict = Depends(require_role("franchisee")),
    ):
        fid = _fid(user)
        # When ``?series=true`` we delete this event AND every other
        # event sharing the same series_id — handy for "cancel all
        # remaining occurrences of my weekly drop-in".
        if series:
            doc = await db.calendar_franchisee_events.find_one(
                {"id": event_id, "franchisee_id": fid}, {"_id": 0, "series_id": 1},
            )
            if not doc:
                raise HTTPException(404, detail="Event not found")
            sid = doc.get("series_id")
            if not sid:
                # Not part of a series — fall back to single delete.
                r = await db.calendar_franchisee_events.delete_one(
                    {"id": event_id, "franchisee_id": fid},
                )
                return {"ok": True, "deleted": r.deleted_count}
            r = await db.calendar_franchisee_events.delete_many(
                {"series_id": sid, "franchisee_id": fid},
            )
            return {"ok": True, "deleted": r.deleted_count}
        r = await db.calendar_franchisee_events.delete_one(
            {"id": event_id, "franchisee_id": fid},
        )
        if not r.deleted_count:
            raise HTTPException(404, detail="Event not found")
        return {"ok": True}

    return router
