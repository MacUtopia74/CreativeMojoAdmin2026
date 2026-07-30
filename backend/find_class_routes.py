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
from datetime import datetime, timedelta, timezone
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


# ---------- cross-franchisee contact-leak kill switch -------------------------
# See tests/test_website_profile_audit.py for the leak scenario (Monica's
# popup surfacing Bel's admin email on production, Feb 2026).

def _digits(v) -> str:
    return "".join(ch for ch in str(v or "") if ch.isdigit())


async def _load_other_admin_contacts(db, exclude_franchisee_id: Optional[str]):
    """Return ``(emails, phones, strong_name_locals, weak_name_locals)``.

    * ``strong_name_locals``: full-name variants — ``firstlast``,
      ``first.last``, ``flast``, ``first.l``. These are high-confidence
      because the combination is unique across ~90 franchisees.
    * ``weak_name_locals``: first-name-only and last-name-only. Low
      confidence — multiple franchisees may share these (Jane, Sam,
      Chris etc.), so the guard still suppresses but the audit will
      list every candidate owner for HQ to review.

    Both indexes map local-part → LIST of owner summaries (not a single
    owner) so ambiguity is visible rather than hidden.
    """
    emails: set[str] = set()
    phones: set[str] = set()
    strong: dict[str, list[dict]] = {}
    weak: dict[str, list[dict]] = {}

    def _register_name(f):
        first = str(f.get("first_name") or "").strip().lower()
        last = str(f.get("last_name") or "").strip().lower()
        strong_variants: set[str] = set()
        weak_variants: set[str] = set()
        if first and len(first) >= 3:
            weak_variants.add(first)
            weak_variants.add(first.replace(" ", ""))
        if last and len(last) >= 3:
            weak_variants.add(last)
            weak_variants.add(last.replace(" ", ""))
        if first and last:
            for v in (f"{first}.{last}", f"{first}{last}",
                      f"{first[0]}{last}", f"{first}.{last[0]}"):
                if v and len(v) >= 4:
                    strong_variants.add(v)
        summary = {
            "id": f.get("id"),
            "name": f"{f.get('first_name') or ''} {f.get('last_name') or ''}".strip(),
            "franchise_number": f.get("franchise_number"),
        }
        for v in strong_variants:
            strong.setdefault(v, []).append(summary)
        for v in weak_variants:
            # Only add to weak if not already a strong variant for this
            # franchisee (avoids double-listing owners).
            if v not in strong_variants:
                weak.setdefault(v, []).append(summary)

    async for other in db.franchisees.find(
        {"id": {"$ne": exclude_franchisee_id}} if exclude_franchisee_id else {},
        {"_id": 0, "id": 1, "first_name": 1, "last_name": 1,
         "franchise_number": 1, "email": 1, "phone": 1, "mobile": 1},
    ):
        if other.get("email"):
            emails.add(str(other["email"]).strip().lower())
        for k in ("phone", "mobile"):
            d = _digits(other.get(k))
            if d:
                phones.add(d)
        _register_name(other)

    try:
        async for u in db.users.find(
            {}, {"_id": 0, "email": 1, "franchisee_id": 1},
        ):
            if u.get("email") and u.get("franchisee_id") != exclude_franchisee_id:
                emails.add(str(u["email"]).strip().lower())
    except Exception:  # noqa: BLE001
        pass

    return emails, phones, strong, weak


def _apply_cross_leak_guard(franchisee: dict, other_emails: set, other_phones: set,
                            strong_name_locals: dict | None = None,
                            weak_name_locals: dict | None = None):
    """Suppress `website_email` / `website_phone` when it matches
    another franchisee's admin contact OR another franchisee's name
    (strong OR weak). Weak matches (shared first names) still trigger
    suppression at runtime because emitting the wrong email is far
    worse than emitting no email — the audit will surface the
    ambiguity for HQ review.
    """
    strong_name_locals = strong_name_locals or {}
    weak_name_locals = weak_name_locals or {}
    own_locals: set[str] = set()
    fn = str(franchisee.get("first_name") or "").strip().lower()
    ln = str(franchisee.get("last_name") or "").strip().lower()
    if fn:
        own_locals.update({fn, fn.replace(" ", "")})
    if ln:
        own_locals.update({ln, ln.replace(" ", "")})
    if fn and ln:
        own_locals.update({f"{fn}.{ln}", f"{fn}{ln}",
                           f"{fn[0]}{ln}", f"{fn}.{ln[0]}"})

    phone_str = None
    if franchisee.get("show_website_phone") and franchisee.get("website_phone"):
        candidate = str(franchisee["website_phone"]).strip() or None
        if candidate and not candidate.startswith("+") and not candidate.startswith("0"):
            candidate = "0" + candidate
        if candidate and _digits(candidate) in other_phones:
            logger.error(
                "[cross-leak] franchisee_id=%s website_phone=%r suppressed — "
                "matches another franchisee's admin phone",
                franchisee.get("id"), candidate,
            )
        else:
            phone_str = candidate

    email_public = None
    if franchisee.get("show_website_email") and franchisee.get("website_email"):
        candidate = str(franchisee["website_email"]).strip() or None
        if candidate:
            low = candidate.lower()
            local = low.split("@", 1)[0]
            local_stripped = local.replace(".", "").replace("_", "").replace("-", "")
            if low in other_emails:
                logger.error(
                    "[cross-leak] franchisee_id=%s website_email=%r suppressed — "
                    "matches another franchisee's admin email",
                    franchisee.get("id"), candidate,
                )
            elif (local in strong_name_locals or local_stripped in strong_name_locals) \
                    and local not in own_locals and local_stripped not in own_locals:
                owners = strong_name_locals.get(local) or strong_name_locals.get(local_stripped)
                logger.error(
                    "[cross-leak-by-name/strong] franchisee_id=%s "
                    "website_email=%r suppressed — full-name match to: %s",
                    franchisee.get("id"), candidate,
                    ", ".join(f"{o.get('name')} #{o.get('franchise_number')}" for o in owners),
                )
            elif (local in weak_name_locals or local_stripped in weak_name_locals) \
                    and local not in own_locals and local_stripped not in own_locals:
                owners = weak_name_locals.get(local) or weak_name_locals.get(local_stripped)
                logger.error(
                    "[cross-leak-by-name/weak] franchisee_id=%s "
                    "website_email=%r suppressed — first-name match (%d candidate owner(s)): %s",
                    franchisee.get("id"), candidate, len(owners),
                    ", ".join(f"{o.get('name')} #{o.get('franchise_number')}" for o in owners),
                )
            else:
                email_public = candidate

    return phone_str, email_public


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
    # Loose UK-postcode regex. If the input doesn't match, we treat the
    # value as a town/city name and ask postcodes.io's `/places` to
    # resolve it to coordinates, then reverse-geocode to a postcode.
    _UK_PCODE = re.compile(
        r"^\s*[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\s*$"
        r"|^\s*[A-Z]{1,2}\d[A-Z\d]?\s*\d?\s*$",
        re.IGNORECASE,
    )

    async def _resolve_place_to_postcode(place: str) -> Optional[tuple[str, str, dict]]:
        """Free-text place → (postcode_full, sector, pin). Returns None
        when nothing matches. We pick postcodes.io's first place result
        then reverse-geocode that lat/lng to the closest postcode."""
        async with httpx.AsyncClient(timeout=8.0) as client:
            try:
                rp = await client.get("https://api.postcodes.io/places",
                                       params={"q": place, "limit": 5})
                places = (rp.json() or {}).get("result") if rp.status_code == 200 else None
                if not places:
                    return None
                p = places[0]
                lat = p.get("latitude")
                lon = p.get("longitude")
                if lat is None or lon is None:
                    return None
                rr = await client.get("https://api.postcodes.io/postcodes",
                                       params={"lat": lat, "lon": lon,
                                               "limit": 1, "radius": 2000})
                nearest = ((rr.json() or {}).get("result") or [None])[0]
                if not nearest:
                    return None
                full, sec = parse_uk_postcode(nearest.get("postcode") or "")
                return (full, sec, {"lat": nearest.get("latitude"),
                                    "lng": nearest.get("longitude")})
            except (httpx.HTTPError, ValueError):
                return None

    @router.get("/public/find-class", response_model=FindClassResult)
    async def find_class(
        request: Request,
        postcode: str = Query(..., min_length=2, max_length=120),
    ):
        # Best-effort client IP (X-Forwarded-For when behind ingress).
        ip = request.headers.get("x-forwarded-for", request.client.host if request.client else "?")
        ip = ip.split(",")[0].strip() if ip else "?"
        _rate_check(ip)

        raw = postcode.strip()
        pin = None
        if _UK_PCODE.match(raw):
            full, sector = parse_uk_postcode(raw)
            if not sector:
                raise HTTPException(400, detail="Please enter a valid UK postcode or town/city.")
        else:
            # Free-text place name path.
            resolved = await _resolve_place_to_postcode(raw)
            if not resolved:
                raise HTTPException(
                    400,
                    detail=f"Couldn’t find “{raw}”. Try a UK town, city or postcode.",
                )
            full, sector, pin = resolved

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
                "photos": 1, "photo_url": 1,
                "facebook": 1, "facebook_page": 1, "facebook_url": 1,
                "territory_sectors": 1,
                "franchise_number": 1,
                # Franchisee-curated website profile — governs what actually
                # reaches the public map popup. Admin `email` / phone are
                # intentionally NOT projected here so they can never leak
                # into the response.
                "website_email": 1, "website_phone": 1, "website_bio": 1,
                "show_website_email": 1, "show_website_phone": 1, "show_website_bio": 1,
                # Jul-2026 popup overhaul: four additional show-flags so
                # the franchisee also gates territory-name, their name,
                # their profile photo and the Facebook link. No fallback
                # to internal admin data — if a flag is unticked the
                # field is completely omitted from the response.
                "show_website_territory_name": 1, "show_website_franchisee_name": 1,
                "show_website_photo": 1, "show_website_facebook": 1,
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

            # Build the public-facing card. Every field is gated by the
            # franchisee's own `show_website_*` opt-in checkbox. When
            # any flag is unticked (or the underlying value is blank),
            # the field is completely omitted from the response — no
            # fallback to `users`, admin contact fields, `wp_title`,
            # `wp_page_url` or any other internal data.
            #
            # For the four Jul-2026 show flags (territory / name /
            # photo / facebook), a MISSING flag defaults to True so
            # the popup carries on rendering franchisees who haven't
            # yet opened their portal to explicitly opt in. An
            # explicit False always wins.
            def _flag_default_true(key: str) -> bool:
                v = franchisee.get(key)
                return True if v is None else bool(v)

            full_name = None
            if _flag_default_true("show_website_franchisee_name"):
                full_name = " ".join(filter(None, [franchisee.get("first_name"), franchisee.get("last_name")])).strip() or None

            area = None
            if _flag_default_true("show_website_territory_name"):
                raw_area = (franchisee.get("organisation") or "").strip()
                for prefix in ("Creative Mojo - ", "Creative Mojo "):
                    if raw_area.lower().startswith(prefix.lower()):
                        raw_area = raw_area[len(prefix):]
                        break
                area = raw_area or None

            photo_url = None
            if _flag_default_true("show_website_photo"):
                if franchisee.get("photos") and isinstance(franchisee["photos"], list):
                    photo_url = (franchisee["photos"][0] or {}).get("url")
                photo_url = photo_url or franchisee.get("photo_url") or None
                # Photos are served from this admin app (relative
                # `/api/uploads/...`). The embed runs on
                # creativemojo.com so we need to return absolute URLs
                # prefixed with the public origin of this API.
                if photo_url and photo_url.startswith("/"):
                    public_origin = (request.headers.get("x-forwarded-host")
                                     or request.headers.get("host"))
                    scheme = request.headers.get("x-forwarded-proto", "https")
                    if public_origin:
                        photo_url = f"{scheme}://{public_origin}{photo_url}"
            # Franchisee-curated public profile fields. Only surface a
            # value when the franchisee has explicitly opted in on their
            # "My Franchise" portal page. This fixed the Jul-2026 issue
            # where admin-record emails/phones (private) were leaking to
            # the public map popup for every franchisee.
            #
            # Feb-2026 additional safeguard: even when a franchisee has
            # opted in, refuse to emit a value that matches ANOTHER
            # franchisee's admin email or phone. This defends against
            # legacy data-import bugs that copied one franchisee's
            # contact details into another's `website_*` field. The
            # check is O(N) per lookup on ~90 franchisees — negligible.
            other_admin_emails, other_admin_phones, strong_name_locals, weak_name_locals = await _load_other_admin_contacts(
                db, franchisee.get("id")
            )

            phone_str, email_public = _apply_cross_leak_guard(
                franchisee, other_admin_emails, other_admin_phones,
                strong_name_locals, weak_name_locals,
            )
            bio_public = None
            bio_preview = None
            bio_truncated = False
            if franchisee.get("show_website_bio") and franchisee.get("website_bio"):
                bio_public = str(franchisee["website_bio"]).strip() or None
            if bio_public:
                # Preview = the first paragraph if it fits within ~2
                # lines (~200 chars), otherwise a clipped snippet. When
                # the first paragraph is short but there ARE more
                # paragraphs to reveal on "Read more", flag as
                # truncated so the popup renders the toggle.
                PREVIEW_LIMIT = 200
                first_para = bio_public.split("\n\n", 1)[0].replace("\n", " ").strip()
                full_flat = bio_public.replace("\n\n", " ").replace("\n", " ").strip()
                if len(first_para) <= PREVIEW_LIMIT:
                    # First paragraph fits — use it as-is. Truncated
                    # only when the full bio contains more content
                    # beyond this paragraph.
                    bio_preview = first_para
                    bio_truncated = first_para != full_flat
                else:
                    snippet = first_para[:PREVIEW_LIMIT]
                    tail = snippet.rfind(". ")
                    if tail > PREVIEW_LIMIT - 60:
                        bio_preview = snippet[:tail + 1]
                    else:
                        cut = snippet.rfind(" ")
                        bio_preview = snippet[:cut] if cut > 0 else snippet
                        bio_preview = bio_preview.rstrip(",;:-—") + "…"
                    bio_truncated = True
            franchisee_payload = {
                "id": franchisee.get("id"),
                "area": area,
                "name": full_name,
                "phone": phone_str,
                "email": email_public,
                # ``bio`` = full text (for the expanded/"read more" state).
                # ``bio_preview`` = 2-line snippet the WP popup shows by
                # default; when ``bio_truncated`` is true, WP should
                # render a "Read more…" link that swaps to ``bio``.
                "bio": bio_public,
                "bio_preview": bio_preview,
                "bio_truncated": bio_truncated,
                "facebook": (
                    (franchisee.get("facebook_page")
                     or franchisee.get("facebook_url")
                     or franchisee.get("facebook"))
                    if _flag_default_true("show_website_facebook") else None
                ),
                "photo_url": photo_url,
            }

        # ---------- log the lookup for analytics (no PII) -----------------
        try:
            await db.find_class_lookups.insert_one({
                "postcode": full or sector,
                "sector": sector,
                "match": match,
                "franchisee_id": (franchisee or {}).get("id"),
                "franchisee_name": (franchisee_payload or {}).get("area"),
                # lat/lng of the searched postcode so the admin "Recent
                # Lookups" map can plot every lookup as a pin without a
                # follow-up geocoding round-trip. Written here at the
                # same point we've already got the resolved geocode.
                "lat": (pin or {}).get("lat"),
                "lng": (pin or {}).get("lng"),
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

    @router.get("/find-class/lookups/map")
    async def lookups_map(days: int = 90, _user: dict = Depends(require_role("admin"))):
        """Return every logged postcode lookup within the window with
        lat/lng so the admin Overview can plot them on the franchise
        map. Reads from `find_class_lookups`; hydrates lat/lng from
        `postcodes_cache` for older rows that predate the map feature.
        """
        cutoff = datetime.now(timezone.utc) - timedelta(days=max(1, days))
        cur = db.find_class_lookups.find(
            {"ts": {"$gte": cutoff}},
            {"_id": 0, "postcode": 1, "sector": 1, "match": 1,
             "franchisee_name": 1, "franchisee_id": 1, "lat": 1, "lng": 1, "ts": 1},
        ).sort("ts", -1).limit(5000)
        rows = await cur.to_list(5000)

        # Backfill lat/lng from postcodes_cache for rows written before
        # we started stamping the coords at insert time.
        missing_pcs = list({r["postcode"] for r in rows if r.get("postcode") and r.get("lat") is None})
        cache_by_pc: dict[str, dict] = {}
        if missing_pcs:
            async for c in db.postcodes_cache.find(
                {"_id": {"$in": missing_pcs}},
                {"_id": 1, "latitude": 1, "longitude": 1},
            ):
                cache_by_pc[c["_id"]] = c

        for r in rows:
            if r.get("lat") is None and r.get("postcode") in cache_by_pc:
                c = cache_by_pc[r["postcode"]]
                r["lat"] = c.get("latitude")
                r["lng"] = c.get("longitude")
            if isinstance(r.get("ts"), datetime):
                r["ts"] = r["ts"].isoformat()

        plotted = [r for r in rows if r.get("lat") is not None and r.get("lng") is not None]
        return {
            "window_days": days,
            "total": len(rows),
            "plotted": len(plotted),
            "lookups": plotted,
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
