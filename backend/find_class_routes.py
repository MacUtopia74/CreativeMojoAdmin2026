"""Find-a-Class — public API for the creativemojo.com WordPress embed.

Lookup: visitor types a UK postcode → API returns the matching franchisee's
public-facing details + a dissolved territory polygon, OR a "no match"
response that triggers the HQ-fallback popup on the embed.

No authentication. Rate-limited per IP to deter scraping. Each search is
logged (postcode + match/miss + IP-derived region only — never the IP
itself) so the admin can see lookup analytics on the Dashboard.
"""
from __future__ import annotations

import logging
import os
import re
import time
from collections import defaultdict
from datetime import datetime, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel

logger = logging.getLogger("creative-mojo-admin.find_class")

# ---------- in-memory IP rate limiter -----------------------------------------
# Lightweight; resets on backend restart. 30 lookups per IP per 10 min is more
# than any genuine visitor needs and snuffs out trivial scrape attempts.
_RATE_BUCKET: dict[str, list[float]] = defaultdict(list)
_RATE_LIMIT = 30
_RATE_WINDOW_SECS = 10 * 60


def _rate_check(ip: str) -> None:
    now = time.time()
    window = _RATE_BUCKET[ip]
    cutoff = now - _RATE_WINDOW_SECS
    # purge old hits
    window[:] = [t for t in window if t > cutoff]
    if len(window) >= _RATE_LIMIT:
        raise HTTPException(429, detail="Too many lookups — please wait a minute.")
    window.append(now)


# ---------- postcode parsing --------------------------------------------------
_PC_RE = re.compile(
    r"^\s*([A-Z]{1,2}\d[A-Z\d]?)\s*(\d)([A-Z]{2})\s*$",
    re.IGNORECASE,
)


def parse_uk_postcode(raw: str) -> tuple[Optional[str], Optional[str]]:
    """Return (normalised_full, sector). e.g. 'rg12dg' → ('RG1 2DG', 'RG1 2')."""
    if not raw:
        return None, None
    m = _PC_RE.match(raw.strip().upper().replace("  ", " "))
    if not m:
        # Tolerate "RG1" (district only) → no full lookup possible but we can
        # still surface a sector match if the user typed just the outward + 1
        slim = re.match(r"^\s*([A-Z]{1,2}\d[A-Z\d]?)\s+(\d)\s*$", raw.strip().upper())
        if slim:
            outward, sector_d = slim.groups()
            return None, f"{outward} {sector_d}"
        return None, None
    outward, sector_digit, inward_letters = m.groups()
    full = f"{outward} {sector_digit}{inward_letters}"
    sector = f"{outward} {sector_digit}"
    return full, sector


# ---------- response models ---------------------------------------------------
class FindClassResult(BaseModel):
    match: bool
    postcode: str
    sector: Optional[str]
    pin: Optional[dict] = None  # { lat, lng } of the searched postcode
    franchisee: Optional[dict] = None  # { name, area, photo, phone, email, facebook, wp_page_url }
    territory: Optional[dict] = None   # GeoJSON Feature (Polygon/MultiPolygon)
    fallback: Optional[dict] = None    # HQ contact (when match is False)


# ----------------------------------------------------------------------------
def attach(api, db, require_role):
    router = APIRouter()

    # ----------- HQ fallback contact (admin-editable single doc) ---------
    HQ_FALLBACK_ID = "hq_fallback"

    DEFAULT_HQ = {
        "_id": HQ_FALLBACK_ID,
        "name": "Sandra Caldeira-Dunkerley",
        "phone": "01884 303606",
        "email": "sandra@creativemojo.co.uk",
        "wp_page_url": "https://www.creativemojo.com/blog/franchise/hq/",
        "photo_url": None,
        "message": (
            "Unfortunately, we have no regional representative running in this area. "
            "Delivered art kits will be available however as an alternative until the area has a representative."
        ),
        "updated_at": datetime.now(timezone.utc),
    }

    async def _get_hq() -> dict:
        doc = await db.public_site_settings.find_one({"_id": HQ_FALLBACK_ID})
        if not doc:
            await db.public_site_settings.insert_one(DEFAULT_HQ.copy())
            doc = DEFAULT_HQ.copy()
        doc.pop("_id", None)
        return doc

    @router.get("/public/find-class/hq")
    async def public_hq():
        """Public — the HQ fallback details for the WP embed when nobody covers a postcode."""
        return await _get_hq()

    @router.get("/find-class/hq")
    async def admin_get_hq(_user: dict = Depends(require_role("admin"))):
        return await _get_hq()

    class HqUpdate(BaseModel):
        name: Optional[str] = None
        phone: Optional[str] = None
        email: Optional[str] = None
        wp_page_url: Optional[str] = None
        photo_url: Optional[str] = None
        message: Optional[str] = None

    @router.put("/find-class/hq")
    async def admin_update_hq(body: HqUpdate, user: dict = Depends(require_role("admin"))):
        update = {k: v for k, v in body.model_dump().items() if v is not None}
        if not update:
            raise HTTPException(400, detail="Nothing to update")
        update["updated_at"] = datetime.now(timezone.utc)
        update["updated_by"] = user.get("email")
        await db.public_site_settings.update_one(
            {"_id": HQ_FALLBACK_ID},
            {"$set": update},
            upsert=True,
        )
        return await _get_hq()

    # -------------------- The main lookup -------------------------------------
    @router.get("/public/find-class", response_model=FindClassResult)
    async def find_class(
        request: Request,
        postcode: str = Query(..., min_length=2, max_length=10),
    ):
        # Best-effort client IP (X-Forwarded-For when behind ingress).
        ip = request.headers.get("x-forwarded-for", request.client.host if request.client else "?")
        ip = ip.split(",")[0].strip() if ip else "?"
        _rate_check(ip)

        full, sector = parse_uk_postcode(postcode)
        if not sector:
            raise HTTPException(400, detail="Please enter a valid UK postcode (e.g. RG1 2DG).")

        # Geocode the postcode (lat/lng for the pin). Skip when only sector
        # was provided — pin will be omitted.
        pin = None
        if full:
            cached = await db.postcodes_cache.find_one({"_id": full}, {"_id": 0, "latitude": 1, "longitude": 1})
            if cached and cached.get("latitude") is not None:
                pin = {"lat": cached["latitude"], "lng": cached["longitude"]}
            else:
                try:
                    async with httpx.AsyncClient(timeout=8.0) as client:
                        r = await client.get(f"https://api.postcodes.io/postcodes/{full.replace(' ', '%20')}")
                    if r.status_code == 200:
                        res = (r.json().get("result") or {})
                        if res.get("latitude") is not None:
                            pin = {"lat": res["latitude"], "lng": res["longitude"]}
                            # Cache for next time
                            await db.postcodes_cache.update_one(
                                {"_id": full},
                                {"$set": {
                                    "_id": full,
                                    "postcode": full,
                                    "sector": sector,
                                    "latitude": pin["lat"],
                                    "longitude": pin["lng"],
                                    "cached_at": datetime.now(timezone.utc),
                                }},
                                upsert=True,
                            )
                except Exception:  # noqa: BLE001
                    pass

        # Find a franchisee whose territory_sectors includes this sector.
        # Active only — anyone with a "Franchisee" tag and not deactivated.
        franchisee = await db.franchisees.find_one(
            {
                "territory_sectors": sector,
                "tags": "Franchisee",
                "lifecycle_status": {"$ne": "ex"},
            },
            {
                "_id": 0, "id": 1, "first_name": 1, "last_name": 1,
                "organisation": 1, "wp_title": 1,
                "email": 1, "mojo_email": 1,
                "mobile_phone": 1, "telephone": 1, "home_phone": 1,
                "photos": 1, "photo_url": 1,
                "facebook": 1, "wp_page_url": 1, "territory_sectors": 1,
                "franchise_number": 1,
            },
        )

        territory_feature = None
        franchisee_payload = None
        match = False

        if franchisee:
            match = True
            # Build the dissolved-territory polygon for the map overlay.
            sectors_list = franchisee.get("territory_sectors") or []
            if sectors_list:
                polys = await db.postcode_sector_polygons.find(
                    {"sector": {"$in": sectors_list}},
                    {"_id": 0, "geometry": 1},
                ).to_list(2000)
                if polys:
                    try:
                        from shapely.geometry import shape, mapping
                        from shapely.ops import unary_union
                        geoms = [shape(p["geometry"]) for p in polys if p.get("geometry")]
                        if geoms:
                            dissolved = unary_union(geoms).buffer(0)
                            territory_feature = {
                                "type": "Feature",
                                "properties": {"sector_count": len(sectors_list)},
                                "geometry": mapping(dissolved),
                            }
                    except Exception as exc:  # noqa: BLE001
                        logger.warning("Failed to dissolve territory: %s", exc)

            # Build the public-facing card. Strip internal fields.
            full_name = " ".join(filter(None, [franchisee.get("first_name"), franchisee.get("last_name")])).strip() or None
            # Prefer the (cleaner) WordPress title for the popup heading; fall
            # back to the verbose `organisation` if it's missing.
            area = (franchisee.get("wp_title") or franchisee.get("organisation") or "").strip()
            for prefix in ("Creative Mojo - ", "Creative Mojo "):
                if area.lower().startswith(prefix.lower()):
                    area = area[len(prefix):]
                    break
            photo_url = None
            if franchisee.get("photos"):
                photo_url = (franchisee["photos"][0] or {}).get("url") if isinstance(franchisee["photos"], list) else None
            photo_url = photo_url or franchisee.get("photo_url")
            # Photos are served from this admin app (relative `/api/uploads/...`).
            # The embed runs on creativemojo.com so we need to return absolute
            # URLs prefixed with the public origin of this API.
            if photo_url and photo_url.startswith("/"):
                public_origin = (request.headers.get("x-forwarded-host")
                                 or request.headers.get("host"))
                scheme = request.headers.get("x-forwarded-proto", "https")
                if public_origin:
                    photo_url = f"{scheme}://{public_origin}{photo_url}"
            # Phone — Airtable migration sometimes stored UK mobiles as ints,
            # stripping the leading 0. Re-add it where it's missing.
            phone = (franchisee.get("mobile_phone") or franchisee.get("telephone") or franchisee.get("home_phone") or "")
            phone_str = str(phone).strip()
            if phone_str and not phone_str.startswith("+") and not phone_str.startswith("0"):
                phone_str = "0" + phone_str
            franchisee_payload = {
                "id": franchisee.get("id"),
                "area": area,
                "name": full_name,
                "phone": phone_str or None,
                # Prefer the @creativemojo.co.uk address (the one shown on the
                # public site); fall back to their personal email otherwise.
                "email": franchisee.get("mojo_email") or franchisee.get("email"),
                "facebook": franchisee.get("facebook"),
                "photo_url": photo_url,
                "wp_page_url": franchisee.get("wp_page_url"),
            }

        # ---------- log the lookup for analytics (no PII) -----------------
        try:
            await db.find_class_lookups.insert_one({
                "postcode": full or sector,
                "sector": sector,
                "match": match,
                "franchisee_id": (franchisee or {}).get("id"),
                "franchisee_name": (franchisee_payload or {}).get("area"),
                "ts": datetime.now(timezone.utc),
                # ip kept hashed-ish — first two octets only, for region-only
                # debugging without storing personal data.
                "ip_region": ".".join(ip.split(".")[:2]) if ip and ip != "?" else None,
            })
        except Exception as exc:  # noqa: BLE001
            logger.warning("Lookup log insert failed (non-fatal): %s", exc)

        if match:
            return FindClassResult(
                match=True,
                postcode=full or sector,
                sector=sector,
                pin=pin,
                franchisee=franchisee_payload,
                territory=territory_feature,
            )

        return FindClassResult(
            match=False,
            postcode=full or sector,
            sector=sector,
            pin=pin,
            fallback=await _get_hq(),
        )

    # -------------------- admin analytics -------------------------------------
    @router.get("/find-class/analytics")
    async def analytics(_user: dict = Depends(require_role("admin"))):
        """Returns overview cards + top postcodes (hits vs misses) for the
        admin Dashboard."""
        from datetime import timedelta
        now = datetime.now(timezone.utc)
        last_7 = now - timedelta(days=7)
        last_30 = now - timedelta(days=30)

        total_7 = await db.find_class_lookups.count_documents({"ts": {"$gte": last_7}})
        total_30 = await db.find_class_lookups.count_documents({"ts": {"$gte": last_30}})
        misses_7 = await db.find_class_lookups.count_documents({"ts": {"$gte": last_7}, "match": False})
        misses_30 = await db.find_class_lookups.count_documents({"ts": {"$gte": last_30}, "match": False})

        # Top missed postcode districts (last 30 days) — most likely candidates
        # for territory expansion / new franchise recruitment.
        top_misses_pipe = [
            {"$match": {"ts": {"$gte": last_30}, "match": False}},
            {"$group": {"_id": "$sector", "n": {"$sum": 1}}},
            {"$sort": {"n": -1}},
            {"$limit": 15},
        ]
        top_misses = [
            {"sector": r["_id"], "count": r["n"]}
            for r in await db.find_class_lookups.aggregate(top_misses_pipe).to_list(15)
            if r.get("_id")
        ]

        # Most-found franchisees (last 30 days) — popularity signal.
        top_hits_pipe = [
            {"$match": {"ts": {"$gte": last_30}, "match": True}},
            {"$group": {"_id": "$franchisee_name", "n": {"$sum": 1}}},
            {"$sort": {"n": -1}},
            {"$limit": 10},
        ]
        top_hits = [
            {"area": r["_id"], "count": r["n"]}
            for r in await db.find_class_lookups.aggregate(top_hits_pipe).to_list(10)
            if r.get("_id")
        ]

        # Recent lookups feed (last 25, newest first).
        recent = await db.find_class_lookups.find(
            {},
            {"_id": 0, "postcode": 1, "match": 1, "franchisee_name": 1, "ts": 1},
        ).sort("ts", -1).limit(25).to_list(25)

        return {
            "totals": {
                "last_7_days": total_7,
                "last_30_days": total_30,
                "misses_7_days": misses_7,
                "misses_30_days": misses_30,
                "miss_rate_7": (misses_7 / total_7) if total_7 else 0,
                "miss_rate_30": (misses_30 / total_30) if total_30 else 0,
            },
            "top_missed_sectors": top_misses,
            "top_hit_areas": top_hits,
            "recent": recent,
        }

    @router.get("/find-class/embed.html")
    async def get_embed(_user: dict = Depends(require_role("admin"))):
        """Return the WordPress embed HTML for the admin to copy-paste into
        the Find-a-Class page on creativemojo.com."""
        from pathlib import Path
        from fastapi.responses import Response
        embed_path = Path(__file__).parent / "static" / "find_class_embed.html"
        if not embed_path.exists():
            raise HTTPException(404, detail="Embed file missing")
        return Response(content=embed_path.read_text(), media_type="text/html; charset=utf-8")

    return router
