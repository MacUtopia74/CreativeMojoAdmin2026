"""Territory atlas cache — Phase 2 optimisation.

The Territory Builder / franchisee dashboard map used to rebuild the
entire multi-franchisee overlay (shapely unions, adjacency graph,
Welsh-Powell colour assignment, per-franchisee dissolved fill +
outline) on every single request. For a network of 50+ franchisees
this is ~3 seconds; at 100+ franchisees production reports 30 s.

The atlas is a pure function of ``franchisees.territory_sectors`` and
``postcode_sector_polygons``, so we cache the fully-baked payload in a
single MongoDB document. A short "fingerprint" query (project just
``{id, territory_sectors}`` per franchisee, hash the sorted result)
tells us whether the cache is stale in ~10-20 ms — much cheaper than
rebuilding from scratch.

Cache row structure:
    {
      _id: "current",
      fingerprint: "sha1…",
      computed_at: "ISO datetime",
      payload: {…},           # kept for exclude-filter & introspection
      payload_json: <bytes>,   # pre-serialised JSON for zero-copy response
    }

Phase 3 will additionally invalidate the cache actively when a
franchisee saves a territory, so most reads hit the fast path without
even paying the fingerprint check.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger(__name__)


CACHE_ID = "current"
COLLECTION = "territory_atlas_cache"

# Single lock to coalesce parallel rebuild requests — if 10 requests
# arrive simultaneously with a cold cache we still only run the build
# once. Later readers await the same result.
_build_lock = asyncio.Lock()


async def fingerprint(db) -> str:
    """Compute a cheap hash representing the current territory truth.

    Query is a projection over the same franchisee set the atlas
    considers, sorted by id for determinism. Typical timing:
    5-30 ms even at 500 franchisees.
    """
    cursor = db.franchisees.find(
        {
            "tags": "Franchisee",
            "lifecycle_status": {"$ne": "ex_franchisee"},
            "territory_sectors": {"$exists": True, "$ne": []},
        },
        {"_id": 0, "id": 1, "territory_sectors": 1, "organisation": 1,
         "postcode": 1, "franchise_number": 1, "first_name": 1,
         "last_name": 1, "full_name": 1},
    )
    rows: list[dict] = []
    async for f in cursor:
        rows.append(f)
    rows.sort(key=lambda r: r.get("id") or "")
    h = hashlib.sha1()
    for r in rows:
        sectors = sorted(r.get("territory_sectors") or [])
        h.update((r.get("id") or "").encode())
        h.update(b"|")
        h.update(",".join(sectors).encode())
        h.update(b"|")
        h.update((r.get("organisation") or "").encode())
        h.update(b"|")
        h.update((r.get("postcode") or "").encode())
        h.update(b"|")
        h.update(str(r.get("franchise_number") or "").encode())
        h.update(b"|")
        h.update((r.get("full_name") or "").encode())
        h.update(b"\n")
    return h.hexdigest()


async def load(db, build_fn) -> tuple[dict, dict]:
    """Return the atlas payload, rebuilding lazily if the cache is stale.

    ``meta`` includes ``payload_json`` (bytes) when we can serve the
    result verbatim without re-serialising the multi-MB dict.
    """
    started = datetime.now(timezone.utc)
    fp = await fingerprint(db)
    coll = db[COLLECTION]
    cached = await coll.find_one({"_id": CACHE_ID}, {"_id": 0})
    if cached and cached.get("fingerprint") == fp and cached.get("payload"):
        return cached["payload"], {
            "cache_hit": True,
            "fingerprint": fp,
            "computed_at": cached.get("computed_at"),
            "took_ms": int((datetime.now(timezone.utc) - started).total_seconds() * 1000),
            "payload_json": cached.get("payload_json"),
        }

    async with _build_lock:
        cached = await coll.find_one({"_id": CACHE_ID}, {"_id": 0})
        if cached and cached.get("fingerprint") == fp and cached.get("payload"):
            return cached["payload"], {
                "cache_hit": True,
                "fingerprint": fp,
                "computed_at": cached.get("computed_at"),
                "took_ms": int((datetime.now(timezone.utc) - started).total_seconds() * 1000),
                "payload_json": cached.get("payload_json"),
            }

        logger.info("territory-atlas: cache miss/stale, rebuilding…")
        build_started = datetime.now(timezone.utc)
        payload = await build_fn()
        now = datetime.now(timezone.utc)
        # Embed cache metadata directly in the payload so downstream
        # consumers get it from any code path (fast-serve OR slow-path
        # filter). Cheap: 3 small keys.
        payload["_cache"] = {
            "computed_at": now.isoformat(),
            "fingerprint": fp,
        }
        # Pre-serialise so subsequent cache-hit responses can skip the
        # 200-500 ms JSON encoding cost on ~5 MB dicts.
        payload_json = json.dumps(payload).encode()
        await coll.update_one(
            {"_id": CACHE_ID},
            {"$set": {
                "fingerprint": fp,
                "computed_at": now.isoformat(),
                "payload": payload,
                "payload_json": payload_json,
            }},
            upsert=True,
        )
        took_ms = int((now - build_started).total_seconds() * 1000)
        logger.info(
            "territory-atlas: rebuilt in %d ms (franchisees=%d, features=%d)",
            took_ms,
            payload.get("count", 0),
            len(payload.get("geojson", {}).get("features") or []),
        )
        return payload, {
            "cache_hit": False,
            "fingerprint": fp,
            "computed_at": now.isoformat(),
            "took_ms": int((now - started).total_seconds() * 1000),
            "payload_json": payload_json,
        }


async def invalidate(db, reason: str = "") -> None:
    """Drop the cached atlas so the next ``load`` rebuilds it."""
    logger.info("territory-atlas: invalidate (%s)", reason or "no reason given")
    await db[COLLECTION].delete_one({"_id": CACHE_ID})


async def refresh(db, build_fn, reason: str = "") -> dict:
    """Force-invalidate then rebuild."""
    await invalidate(db, reason=reason)
    payload, meta = await load(db, build_fn)
    return {"ok": True, "meta": meta, "count": payload.get("count", 0)}


def filter_exclude(payload: dict, exclude_id: Optional[str]) -> dict:
    """Return a shallow-filtered atlas payload with ``exclude_id`` removed."""
    if not exclude_id:
        return payload
    franchisees = [f for f in (payload.get("franchisees") or []) if f.get("id") != exclude_id]
    fills = [
        f for f in (payload.get("geojson", {}).get("features") or [])
        if (f.get("properties") or {}).get("franchisee_id") != exclude_id
    ]
    outlines = [
        f for f in (payload.get("outlines", {}).get("features") or [])
        if (f.get("properties") or {}).get("franchisee_id") != exclude_id
    ]
    return {
        "franchisees": franchisees,
        "geojson": {"type": "FeatureCollection", "features": fills},
        "outlines": {"type": "FeatureCollection", "features": outlines},
        "count": len(franchisees),
        "_cache": payload.get("_cache") or {},
    }
