"""Immutable territory-map snapshots for contracts.

A territory snapshot is a frozen copy of a franchisee's territory
tiles taken at contract-draft time. Its purpose is to guarantee that
the ``[[TERRITORY_MAP_URL]]`` link inside an issued PDF continues to
resolve to *the exact territory agreed at signing*, regardless of any
later edits the franchisee makes to their live territory.

Design:

    * A snapshot is created by ``POST /admin/contracts/{id}/freeze-territory``
      (see ``contracts_routes.py``) — never directly. It captures the
      full list of territory-tile documents by value plus a
      ``secure_token`` (URL-safe, 32 chars, cryptographically random).
    * The public read endpoint requires BOTH the snapshot ID and the
      secure token to succeed — the token guarantees links inside PDFs
      cannot be enumerated. The page is read-only.
    * Snapshots are immutable — no PATCH / DELETE endpoints. A
      superseded contract simply gets a new snapshot for its new
      draft; the old snapshot stays alive forever so the old contract
      keeps opening its own agreed territory.
    * The destination URL baked into the PDF is
      ``{CONTRACT_LINK_BASE_URL}/agreed-territory/{snapshot_id}/{secure_token}``
      — the FRONTEND page that renders this snapshot is Turn D work.
      Turn A only guarantees the backend read path and immutability.
"""
from __future__ import annotations

import base64
import hashlib
import os
import secrets
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import Depends, HTTPException


SNAPSHOTS_COLLECTION = "territory_snapshots"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_secure_token() -> str:
    # 32 chars of urlsafe base64 → 24 bytes of entropy. Not guessable.
    return base64.urlsafe_b64encode(secrets.token_bytes(24)).decode("ascii").rstrip("=")


def _sha256(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def _strip_mongo(doc: Dict[str, Any]) -> Dict[str, Any]:
    if not doc:
        return doc
    doc = dict(doc)
    doc.pop("_id", None)
    return doc


def _link_base_url() -> str:
    base = os.environ.get("CONTRACT_LINK_BASE_URL", "").rstrip("/")
    if not base:
        raise RuntimeError(
            "CONTRACT_LINK_BASE_URL is not set. "
            "Territory-snapshot links cannot be minted."
        )
    return base


def _build_snapshot_url(snapshot_id: str, secure_token: str) -> str:
    return f"{_link_base_url()}/agreed-territory/{snapshot_id}/{secure_token}"


async def create_snapshot(
    db,
    *,
    contract_id: str,
    franchisee_id: str,
    territory_ids: List[str],
    created_by: str,
    territory_sectors: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Create an immutable snapshot of the franchisee's current
    territory tiles. Called by ``contracts_routes.freeze_territory``.

    ``territory_ids`` refers to documents in the ``territories``
    collection (Territory Builder tiles). ``territory_sectors`` is
    the flat list of postcode-sector strings stored directly on the
    franchisee record — used when the franchisee has an agreed
    territory (via the sector-based flow) but no matching
    Territory-Builder tile rows. Either is accepted; the caller is
    responsible for guaranteeing at least one is non-empty.

    Returns the persisted snapshot document (public view).
    """
    # Snapshot the tile documents BY VALUE — future edits to the live
    # territories collection must not affect this record.
    territory_docs: List[Dict[str, Any]] = []
    if territory_ids:
        cur = db["territories"].find({"id": {"$in": territory_ids}})
        async for t in cur:
            t.pop("_id", None)
            territory_docs.append(t)

    # Sectors are stored by value too — a copy of the strings, so a
    # later edit to franchisee.territory_sectors cannot alter the
    # snapshot. Deduplicate + preserve order for determinism.
    sectors_snapshot: List[str] = []
    seen: set = set()
    for s in (territory_sectors or []):
        if not s:
            continue
        s2 = str(s).strip()
        if not s2 or s2 in seen:
            continue
        seen.add(s2)
        sectors_snapshot.append(s2)

    snapshot_id = uuid.uuid4().hex
    secure_token = _new_secure_token()
    url = _build_snapshot_url(snapshot_id, secure_token)
    url_sha = _sha256(url)
    now = _now_iso()

    doc = {
        "id": snapshot_id,
        "contract_id": contract_id,
        "franchisee_id": franchisee_id,
        "source_territory_ids_at_snapshot": list(territory_ids),
        "source_territory_sectors_at_snapshot": list(sectors_snapshot),
        "territory_docs": territory_docs,
        "territory_sectors": sectors_snapshot,
        # ``tile_count`` is the operator-facing "how big is this
        # territory" number. Prefer tile docs (they carry postcode +
        # county metadata) but fall back to the sector count so
        # sector-only snapshots still report a meaningful size.
        "tile_count": len(territory_docs) or len(sectors_snapshot),
        "secure_token": secure_token,
        "url": url,
        "url_sha256": url_sha,
        "created_at": now,
        "created_by": created_by,
        # Snapshots are immutable — no updated_at field on purpose.
    }
    await db[SNAPSHOTS_COLLECTION].insert_one(doc)
    return _strip_mongo(doc)


def attach(api, db, require_role):
    """Register public + admin snapshot routes.

    The public read endpoint is intentionally NOT gated by admin auth —
    a franchisee (or their solicitor) must be able to follow the link
    inside their issued PDF without logging in. Security relies on the
    unguessable ``secure_token`` in the path.
    """

    @api.get("/territory-snapshots/{snapshot_id}/{secure_token}")
    async def read_snapshot_public(snapshot_id: str, secure_token: str):
        doc = await db[SNAPSHOTS_COLLECTION].find_one({"id": snapshot_id})
        if not doc or doc.get("secure_token") != secure_token:
            # Do NOT differentiate between "not found" and "wrong token"
            # — otherwise an attacker could enumerate valid IDs.
            raise HTTPException(404, detail="Snapshot not found or token invalid.")
        # Public view — hides the token and other internals we don't
        # need to leak. The Turn D frontend page consumes this.
        return {
            "snapshot_id": doc["id"],
            "contract_id": doc.get("contract_id"),
            "franchisee_id": doc.get("franchisee_id"),
            "tile_count": doc.get("tile_count", 0),
            "territory_tiles": [
                {
                    "id": t.get("id"),
                    "postcode": t.get("postcode"),
                    "county": t.get("county"),
                    "airtable_id": t.get("airtable_id"),
                }
                for t in (doc.get("territory_docs") or [])
            ],
            # Sector-only snapshots (agreed by postcode sector but with
            # no Territory-Builder tile rows) surface here so the public
            # /agreed-territory page can still render "your agreed
            # territory covers EX15 1, EX15 2, ...".
            "territory_sectors": list(doc.get("territory_sectors") or []),
            "created_at": doc.get("created_at"),
        }

    @api.get("/admin/territory-snapshots/{snapshot_id}")
    async def read_snapshot_admin(
        snapshot_id: str,
        _: dict = Depends(require_role("admin")),
    ):
        doc = await db[SNAPSHOTS_COLLECTION].find_one({"id": snapshot_id})
        if not doc:
            raise HTTPException(404, detail="Snapshot not found")
        return _strip_mongo(doc)

    @api.get("/admin/territory-snapshots")
    async def list_snapshots(
        contract_id: Optional[str] = None,
        franchisee_id: Optional[str] = None,
        _: dict = Depends(require_role("admin")),
    ):
        q: Dict[str, Any] = {}
        if contract_id:
            q["contract_id"] = contract_id
        if franchisee_id:
            q["franchisee_id"] = franchisee_id
        cur = db[SNAPSHOTS_COLLECTION].find(q).sort([("created_at", -1)])
        # Do NOT return secure_token in list — HQ can fetch by ID for that
        items = []
        async for d in cur:
            d.pop("_id", None)
            d.pop("territory_docs", None)  # keep the list light
            items.append(d)
        return {"items": items, "total": len(items)}

    return api
