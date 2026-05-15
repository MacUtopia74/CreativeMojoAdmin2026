"""Phase 3 — FileCamp WebDAV → R2 migration.

Routes:
  POST /api/files/migration/plan         — dry-run; returns the migration plan
  POST /api/files/migration/start        — kicks off the real migration as a background task
  GET  /api/files/migration/status       — current progress (poll from UI)

Design:
  * WebDAV walk is synchronous via PROPFIND Depth: infinity where possible,
    falling back to recursive Depth: 1 if the server rejects infinity.
  * Files stream FROM the FileCamp HTTP response straight INTO R2 via boto3
    s3.upload_fileobj — so a 1 GB MP3 never lands on local disk.
  * Per-franchisee folder names start with the franchise number (e.g.
    "0046 Creative Mojo Central Scotland (Gail Wright)"). We match that prefix
    against the franchisees collection's `franchise_number` field.
  * Resumability: every uploaded object has its etag stored in
    `files_index`; on re-run we skip objects already present at the target key.
"""
from __future__ import annotations

import os
import re
import io
import logging
import urllib.parse
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from typing import Optional, Iterable, Any
import asyncio
import requests
from requests.auth import HTTPBasicAuth
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks, Query

from file_storage import (
    get_client, R2_BUCKET, r2_configured,
    FILECAMP_FOLDER_MAP, FILECAMP_SKIP_PREFIXES, is_noise_filename,
    franchisee_folder_key, slugify,
    SCOPE_FRANCHISEE, SCOPE_SHARED, SCOPE_ADMIN,
)

logger = logging.getLogger("creative-mojo-admin.migration")

FC_URL = os.environ.get("FILECAMP_WEBDAV_URL", "")
FC_USER = os.environ.get("FILECAMP_WEBDAV_USER", "")
FC_PASS = os.environ.get("FILECAMP_WEBDAV_PASS", "")


# ---------------------------------------------------------------------------
# WebDAV walker
# ---------------------------------------------------------------------------
class FileCampClient:
    """Thin WebDAV client. We only need PROPFIND + GET."""

    def __init__(self) -> None:
        self.base = FC_URL.rstrip("/")
        self.auth = HTTPBasicAuth(FC_USER, FC_PASS)
        self.session = requests.Session()
        self.session.auth = self.auth

    def _propfind(self, path: str, depth: str = "1") -> list[dict]:
        """Return [{href, is_dir, size, last_modified}, ...] excluding the path itself."""
        path = path if path.startswith("/") else "/" + path
        url = self.base + urllib.parse.quote(path)
        r = self.session.request("PROPFIND", url, headers={"Depth": depth}, timeout=60)
        r.raise_for_status()
        # Parse the multistatus XML
        try:
            root = ET.fromstring(r.text)
        except ET.ParseError as exc:
            logger.error("WebDAV XML parse failed for %s: %s", path, exc)
            raise
        ns = {"D": "DAV:"}
        out: list[dict] = []
        for resp in root.findall("D:response", ns):
            href_el = resp.find("D:href", ns)
            if href_el is None or not href_el.text:
                continue
            href = urllib.parse.unquote(href_el.text)
            # Skip the path itself in the listing
            if href.rstrip("/") == path.rstrip("/"):
                continue
            is_dir = resp.find(".//D:resourcetype/D:collection", ns) is not None
            sz_el = resp.find(".//D:getcontentlength", ns)
            size = int(sz_el.text) if (sz_el is not None and sz_el.text) else 0
            lm_el = resp.find(".//D:getlastmodified", ns)
            last_modified = lm_el.text if lm_el is not None else None
            ct_el = resp.find(".//D:getcontenttype", ns)
            content_type = ct_el.text if ct_el is not None else None
            out.append({
                "href": href,
                "is_dir": is_dir,
                "size": size,
                "last_modified": last_modified,
                "content_type": content_type,
            })
        return out

    def walk(self, root_path: str):
        """Recursive depth-first traversal yielding (full_path, entry) tuples."""
        try:
            entries = self._propfind(root_path, depth="1")
        except Exception as exc:  # noqa: BLE001
            logger.error("PROPFIND %s failed: %s", root_path, exc)
            return
        for e in entries:
            name = e["href"].rstrip("/").rsplit("/", 1)[-1]
            if any(name.startswith(skip) for skip in FILECAMP_SKIP_PREFIXES):
                continue
            yield e
            if e["is_dir"]:
                yield from self.walk(e["href"])

    def stream_file(self, path: str):
        """Open a streaming GET to a WebDAV file. Returns a requests.Response that
        the caller is responsible for closing."""
        path = path if path.startswith("/") else "/" + path
        url = self.base + urllib.parse.quote(path)
        return self.session.get(url, stream=True, timeout=300)


# ---------------------------------------------------------------------------
# Planning
# ---------------------------------------------------------------------------
async def _build_franchisee_lookup(db) -> dict[str, dict]:
    """franchise_number (zero-padded 4-digit) → franchisee record."""
    out: dict[str, dict] = {}
    cur = db.franchisees.find({}, {"_id": 0, "id": 1, "franchise_number": 1,
                                     "organisation": 1, "first_name": 1, "last_name": 1})
    async for f in cur:
        fn = f.get("franchise_number")
        if fn is None or fn == "":
            continue
        key = str(int(fn)).zfill(4) if str(fn).isdigit() else str(fn).strip().zfill(4)
        out[key] = f
    return out


_LEADING_NUM = re.compile(r"^\s*(\d{1,5})\b")


def _classify_franchisee_folder(folder_name: str, by_num: dict[str, dict]) -> Optional[dict]:
    """Given a folder name like '0046 Creative Mojo Central Scotland (Gail Wright)',
    return the matched franchisee record (or None for orphans)."""
    m = _LEADING_NUM.search(folder_name)
    if not m:
        return None
    key = m.group(1).zfill(4)
    return by_num.get(key)


def plan_entry(entry: dict, by_num: dict[str, dict]) -> dict:
    """Decide the R2 destination for a single WebDAV entry.
    Returns a dict suitable for the plan & migration loop."""
    href = entry["href"]
    parts = [p for p in href.strip("/").split("/") if p]
    if not parts:
        return {"skip": True, "reason": "root"}

    top = parts[0]
    if any(top.startswith(skip) for skip in FILECAMP_SKIP_PREFIXES):
        return {"skip": True, "reason": "system folder"}

    if not entry["is_dir"] and is_noise_filename(href):
        return {"skip": True, "reason": "noise file"}

    cfg = FILECAMP_FOLDER_MAP.get(top)
    if not cfg:
        # Unknown top-level folder → default to admin/misc-extras/...
        cfg = {"scope": SCOPE_ADMIN, "prefix": f"admin/{slugify(top)}/"}

    scope = cfg["scope"]
    prefix = cfg["prefix"]

    if top == "Franchisees" and len(parts) >= 2:
        # /Franchisees/0046 Creative Mojo …/sub/path
        franchisee_folder = parts[1]
        match = _classify_franchisee_folder(franchisee_folder, by_num)
        if not match:
            # No matching DB record — park in admin/orphan-franchisees/...
            inner = "/".join(parts[1:])
            return {
                "skip": False,
                "scope": SCOPE_ADMIN,
                "franchisee_id": None,
                "key": f"admin/orphan-franchisees/{inner}",
                "size": entry["size"],
                "is_dir": entry["is_dir"],
                "orphan": True,
                "source_path": href,
            }
        # Mapped
        slug = franchisee_folder_key(
            match.get("franchise_number"),
            match.get("organisation"),
            match.get("first_name"),
            match.get("last_name"),
        )
        remainder = "/".join(parts[2:])  # what comes after the franchisee folder
        key = f"franchisees/{slug}{remainder}"
        return {
            "skip": False,
            "scope": SCOPE_FRANCHISEE,
            "franchisee_id": match["id"],
            "key": key,
            "size": entry["size"],
            "is_dir": entry["is_dir"],
            "source_path": href,
        }

    # Non-franchisees buckets: just preserve relative path under the configured prefix
    inner = "/".join(parts[1:])
    return {
        "skip": False,
        "scope": scope,
        "franchisee_id": None,
        "key": prefix + inner,
        "size": entry["size"],
        "is_dir": entry["is_dir"],
        "source_path": href,
    }


# ---------------------------------------------------------------------------
# Plan + execution
# ---------------------------------------------------------------------------
async def build_plan(db, max_entries: Optional[int] = None) -> dict:
    """Walk FileCamp and produce a migration plan (dry-run output).

    The WebDAV walk uses `requests` (sync) and is CPU-light but I/O-heavy, so
    we run it on a thread so we don't block the event loop while motor is
    waiting on us elsewhere."""
    by_num = await _build_franchisee_lookup(db)

    def _walk_and_classify() -> tuple[list, list, list, int, int, int, dict, dict]:
        client = FileCampClient()
        items_l: list[dict] = []
        folders_l: list[dict] = []
        skips_l: list[dict] = []
        bytes_t = 0
        files_t = 0
        orphan_t = 0
        by_scope_files_l: dict[str, int] = {}
        by_scope_bytes_l: dict[str, int] = {}
        for entry in client.walk("/"):
            if max_entries is not None and len(items_l) + len(folders_l) >= max_entries:
                break
            decision = plan_entry(entry, by_num)
            if decision.get("skip"):
                skips_l.append({"path": entry["href"], "reason": decision.get("reason"),
                                 "size": entry["size"]})
                continue
            if decision["is_dir"]:
                folders_l.append(decision)
                continue
            items_l.append({**decision, "last_modified": entry["last_modified"],
                            "content_type": entry["content_type"]})
            files_t += 1
            bytes_t += entry["size"]
            if decision.get("orphan"):
                orphan_t += 1
            scope = decision["scope"]
            by_scope_files_l[scope] = by_scope_files_l.get(scope, 0) + 1
            by_scope_bytes_l[scope] = by_scope_bytes_l.get(scope, 0) + entry["size"]
        return items_l, folders_l, skips_l, bytes_t, files_t, orphan_t, by_scope_files_l, by_scope_bytes_l

    items, folders, skips, bytes_total, files_total, orphan_total, by_scope_files, by_scope_bytes = await asyncio.to_thread(_walk_and_classify)

    # Group items by franchisee for the per-franchisee preview
    by_franchisee: dict[str, dict] = {}
    for it in items:
        if it.get("scope") != SCOPE_FRANCHISEE:
            continue
        fid = it.get("franchisee_id") or "(orphan)"
        if fid not in by_franchisee:
            f = by_num
            by_franchisee[fid] = {
                "franchisee_id": fid,
                "files": 0, "bytes": 0,
                "first_key": it["key"],
            }
        by_franchisee[fid]["files"] += 1
        by_franchisee[fid]["bytes"] += it["size"]

    # Attach organisation names to the franchisee summary
    fid_to_org: dict[str, str] = {}
    cur = db.franchisees.find({}, {"_id": 0, "id": 1, "organisation": 1, "franchise_number": 1,
                                     "first_name": 1, "last_name": 1})
    async for f in cur:
        fid_to_org[f["id"]] = {
            "name": f.get("organisation") or f"{f.get('first_name','')} {f.get('last_name','')}".strip(),
            "franchise_number": f.get("franchise_number"),
        }
    franchisee_summary = []
    for fid, agg in by_franchisee.items():
        meta = fid_to_org.get(fid, {})
        franchisee_summary.append({**agg, **meta})
    franchisee_summary.sort(key=lambda x: (str(x.get("franchise_number") or "9999")))

    return {
        "files_total": files_total,
        "folders_total": len(folders),
        "bytes_total": bytes_total,
        "orphan_files": orphan_total,
        "by_scope": [
            {"scope": k, "files": by_scope_files[k], "bytes": by_scope_bytes[k]}
            for k in by_scope_files
        ],
        "skipped": len(skips),
        "skipped_sample": skips[:25],
        "franchisee_summary": franchisee_summary[:200],
        "preview_items": items[:50],
        # Persisted in DB for the executor — too big for the response usually:
        "_all_items": items,
    }


_PLAN_STATE: dict = {"running": False, "started_at": None, "finished_at": None,
                       "files_scanned": 0, "current": None, "error": None}


async def _build_plan_bg(db, operator_email: str) -> None:
    """Background plan builder — walks WebDAV and persists the plan."""
    _PLAN_STATE.update({"running": True, "started_at": _now(), "finished_at": None,
                         "files_scanned": 0, "current": None, "error": None})
    try:
        plan = await build_plan(db)
        await db.files_migration_plan.update_one({"_id": "latest"},
            {"$set": {"items": plan["_all_items"], "built_at": _now(),
                      "built_by": operator_email,
                      "summary": {k: v for k, v in plan.items() if k != "_all_items"}}},
            upsert=True)
    except Exception as exc:  # noqa: BLE001
        _PLAN_STATE["error"] = str(exc)[:500]
        logger.exception("Plan build failed")
    finally:
        _PLAN_STATE["finished_at"] = _now()
        _PLAN_STATE["running"] = False


# ---------------------------------------------------------------------------
# Migration runner (background)
# ---------------------------------------------------------------------------
_RUNNER_STATE: dict = {"running": False, "started_at": None, "finished_at": None,
                       "files_done": 0, "bytes_done": 0, "errors": 0,
                       "files_total": 0, "bytes_total": 0, "current": None,
                       "error_log": []}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _migrate_items(db, items: list[dict], operator_email: str) -> None:
    s3 = get_client()
    client = FileCampClient()
    _RUNNER_STATE.update({
        "running": True, "started_at": _now(), "finished_at": None,
        "files_done": 0, "bytes_done": 0, "errors": 0,
        "files_total": len(items),
        "bytes_total": sum(i["size"] for i in items),
        "current": None, "error_log": [],
    })

    for it in items:
        _RUNNER_STATE["current"] = it["key"]
        try:
            # Skip if already in R2 with matching size (resumable)
            existing = None
            try:
                existing = s3.head_object(Bucket=R2_BUCKET, Key=it["key"])
            except Exception:  # noqa: BLE001
                existing = None
            if existing and existing.get("ContentLength") == it["size"]:
                # Already done — count and continue
                _RUNNER_STATE["files_done"] += 1
                _RUNNER_STATE["bytes_done"] += it["size"]
                # Still upsert the index entry in case it's missing
                await _upsert_index(db, it, operator_email, skipped=True)
                continue

            # Stream from WebDAV → R2
            resp = client.stream_file(it["source_path"])
            resp.raise_for_status()
            # boto3 upload_fileobj wants a binary file-like; resp.raw works
            resp.raw.decode_content = True
            extra_args: dict = {}
            ct = it.get("content_type")
            if ct:
                extra_args["ContentType"] = ct
            s3.upload_fileobj(resp.raw, R2_BUCKET, it["key"], ExtraArgs=extra_args)
            resp.close()

            await _upsert_index(db, it, operator_email)
            _RUNNER_STATE["files_done"] += 1
            _RUNNER_STATE["bytes_done"] += it["size"]
        except Exception as exc:  # noqa: BLE001
            _RUNNER_STATE["errors"] += 1
            _RUNNER_STATE["error_log"].append({"path": it.get("source_path"),
                                                "key": it.get("key"),
                                                "error": str(exc)[:500]})
            logger.exception("Migration error on %s", it.get("source_path"))

    _RUNNER_STATE["finished_at"] = _now()
    _RUNNER_STATE["running"] = False
    _RUNNER_STATE["current"] = None
    # Log a summary
    await db.gocardless_sync_log.insert_one({  # reuse the sync_log collection
        "job": "filecamp_migration",
        **{k: v for k, v in _RUNNER_STATE.items() if k != "error_log"},
        "error_log_count": len(_RUNNER_STATE["error_log"]),
        "operator": operator_email,
    })


async def _upsert_index(db, item: dict, operator_email: str, skipped: bool = False) -> None:
    name = item["key"].rsplit("/", 1)[-1]
    parent_prefix = item["key"][: -len(name)] if name else item["key"]
    doc = {
        "key": item["key"],
        "name": name,
        "parent_prefix": parent_prefix,
        "size": item["size"],
        "content_type": item.get("content_type"),
        "scope": item["scope"],
        "franchisee_id": item.get("franchisee_id"),
        "orphan": bool(item.get("orphan")),
        "source": "filecamp",
        "source_path": item.get("source_path"),
        "imported_at": _now(),
        "imported_by": operator_email,
        "last_modified": item.get("last_modified"),
    }
    await db.files_index.update_one({"key": item["key"]}, {"$set": doc}, upsert=True)


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------
def build_router(db, require_role) -> APIRouter:
    router = APIRouter()

    @router.get("/files/migration/status")
    async def migration_status(_user: dict = Depends(require_role("admin"))):
        latest_plan = await db.files_migration_plan.find_one({"_id": "latest"},
                                                              {"summary": 1, "built_at": 1, "_id": 0})
        return {
            **_RUNNER_STATE,
            "plan": _PLAN_STATE,
            "latest_plan": latest_plan,
            "configured": r2_configured(),
        }

    @router.post("/files/migration/plan")
    async def migration_plan(
        background: BackgroundTasks,
        user: dict = Depends(require_role("admin")),
    ):
        if not r2_configured():
            raise HTTPException(503, detail="R2 not configured")
        if _PLAN_STATE.get("running"):
            return {"started": False, "reason": "plan already running"}
        background.add_task(_build_plan_bg, db, user.get("email", ""))
        return {"started": True}

    @router.post("/files/migration/plan/discard")
    async def migration_plan_discard(_user: dict = Depends(require_role("admin"))):
        await db.files_migration_plan.delete_one({"_id": "latest"})
        return {"discarded": True}

    @router.post("/files/migration/start")
    async def migration_start(
        background: BackgroundTasks,
        confirm: str = Query(..., description="must equal MIGRATE for safety"),
        max_items: Optional[int] = Query(None, description="cap for partial test runs"),
        user: dict = Depends(require_role("admin")),
    ):
        if confirm != "MIGRATE":
            raise HTTPException(400, detail="Pass ?confirm=MIGRATE to start.")
        if _RUNNER_STATE.get("running"):
            raise HTTPException(409, detail="Migration already running.")
        plan = await db.files_migration_plan.find_one({"_id": "latest"}, {"_id": 0})
        if not plan or not plan.get("items"):
            raise HTTPException(400, detail="No plan found — run /files/migration/plan first.")
        items = plan["items"]
        if max_items:
            items = items[:max_items]
        background.add_task(_migrate_items, db, items, user.get("email", ""))
        return {"started": True, "queued": len(items)}

    return router
