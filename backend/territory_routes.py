"""Phase 4 — Territory mapping APIs.

Powers the admin Territory Builder and the franchisee dashboard map.

Endpoints:
  GET  /api/territory/postcode-lookup?postcode=...   — postcodes.io proxy
                                                       returns lat/lng + sector
  GET  /api/territory/sectors-near?lat=&lon=&radius= — list of CQC sectors with
                                                       home counts within the
                                                       bounding circle
  GET  /api/territory/homes?sectors=A,B,C            — homes inside the sectors
  GET  /api/territory/franchisee-summary?id=         — sector list owned by a
                                                       franchisee (for map)
  POST /api/territory-plans                          — save prospect plan
  GET  /api/territory-plans?contact_id=              — load plan(s)
  PATCH /api/territory-plans/{id}
  DELETE /api/territory-plans/{id}

Postcode sector derivation matches `cqc_import.parse_postcode` so the
home counter lines up exactly with imported data.
"""
from __future__ import annotations

import logging
import re
import uuid
from datetime import datetime, timezone
from typing import Optional, List

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from geo_postcode import is_scottish_postcode  # shared (avoids cqc ↔ scotland cycle)
# Rule + filter helpers come from dedicated leaf modules — neither router
# imports the other, eliminating the circular import code review flagged.
from cqc_definition import CqcDefinition, definition_to_mongo_filter, DEFAULT_DEFINITION_ID
from scotland_definition import (
    ScotlandDefinition,
    definition_to_mongo_filter as scot_definition_to_mongo_filter,
    DEFAULT_DEFINITION_ID as SCOT_DEFINITION_ID,
)
from ni_definition import (
    NiDefinition,
    definition_to_mongo_filter as ni_definition_to_mongo_filter,
    DEFAULT_DEFINITION_ID as NI_DEFINITION_ID,
)


def _is_ni_postcode(code: Optional[str]) -> bool:
    """NI postcodes / sectors / districts all start with ``BT`` followed
    by a digit. Defensive against bare ``BT`` (no district number)."""
    if not code:
        return False
    s = re.sub(r"\s+", "", str(code).upper())
    return s.startswith("BT") and len(s) > 2 and s[2].isdigit()

logger = logging.getLogger("creative-mojo-admin.territory")

_POSTCODE_RE = re.compile(r"^\s*([A-Z]{1,2}\d[A-Z\d]?)\s*(\d)([A-Z]{2})\s*$", re.I)


def parse_postcode(raw: Optional[str]) -> tuple[Optional[str], Optional[str], Optional[str]]:
    if not raw or not isinstance(raw, str):
        return None, None, None
    m = _POSTCODE_RE.match(raw.upper())
    if not m:
        return None, None, None
    out, sec_digit, unit = m.group(1), m.group(2), m.group(3)
    return f"{out} {sec_digit}{unit}", f"{out} {sec_digit}", out


def _normalise_sector(raw: str) -> Optional[str]:
    """Normalise a raw sector string into "OUTCODE D" form (single space).
    Returns None for unparseable input.

    Examples:  "co7 0" → "CO7 0",  "ex151" → "EX15 1",  "AB10 1" → "AB10 1".
    """
    if not raw:
        return None
    s = re.sub(r"\s+", "", raw.upper())
    m = re.match(r"^([A-Z]{1,2}\d[A-Z\d]?)(\d)$", s)
    if not m:
        return None
    return f"{m.group(1)} {m.group(2)}"


class TerritoryPlanIn(BaseModel):
    contact_id: Optional[str] = None
    franchisee_id: Optional[str] = None
    name: Optional[str] = None
    centre_postcode: Optional[str] = None
    centre_lat: Optional[float] = None
    centre_lng: Optional[float] = None
    sectors: List[str] = Field(default_factory=list)
    home_count: Optional[int] = None
    notes: Optional[str] = None


class FranchiseeTerritoryIn(BaseModel):
    sectors: List[str] = Field(default_factory=list)


def build_territory_router(db, require_role):  # noqa: D401
    router = APIRouter()

    async def _homes_filter() -> dict:
        """Returns the current `cqc_homes` query filter merging the
        admin-defined inclusion/exclusion rule. Live collection is
        preferred when populated, falling back to the legacy spreadsheet
        import."""
        doc = await db.cqc_definition.find_one({"_id": DEFAULT_DEFINITION_ID}, {"_id": 0})
        d = CqcDefinition(**doc) if doc else CqcDefinition()
        return definition_to_mongo_filter(d)

    async def _homes_collection():
        # Prefer live CQC collection once any sync has populated it.
        if await db.cqc_locations_live.count_documents({}, limit=1):
            return db.cqc_locations_live
        return db.cqc_locations

    async def _scotland_filter() -> dict:
        doc = await db.scotland_definition.find_one({"_id": SCOT_DEFINITION_ID}, {"_id": 0})
        d = ScotlandDefinition(**doc) if doc else ScotlandDefinition()
        return scot_definition_to_mongo_filter(d)

    async def _ni_filter() -> dict:
        doc = await db.ni_definition.find_one({"_id": NI_DEFINITION_ID}, {"_id": 0})
        d = NiDefinition(**doc) if doc else NiDefinition()
        return ni_definition_to_mongo_filter(d)

    def _split_sectors_by_country(sectors: list[str]) -> tuple[list[str], list[str], list[str]]:
        """Partition sector codes into (Scottish, NI, rest-of-UK) lists so
        the right data source can be queried for each."""
        scot: list[str] = []
        ni: list[str] = []
        rest: list[str] = []
        for s in sectors:
            if _is_ni_postcode(s):
                ni.append(s)
            elif is_scottish_postcode(s):
                scot.append(s)
            else:
                rest.append(s)
        return scot, ni, rest

    async def _count_homes_per_sector(sectors: list[str]) -> dict:
        """Total homes per sector across CQC + Scotland + NI sources."""
        if not sectors:
            return {}
        scot, ni, rest = _split_sectors_by_country(sectors)
        merged: dict[str, int] = {}
        if rest:
            homes_coll = await _homes_collection()
            base = await _homes_filter()
            cur = homes_coll.aggregate([
                {"$match": {**base, "postcode_sector": {"$in": rest}}},
                {"$group": {"_id": "$postcode_sector", "n": {"$sum": 1}}},
            ])
            for r in await cur.to_list(5000):
                merged[r["_id"]] = merged.get(r["_id"], 0) + r["n"]
        if scot:
            base = await _scotland_filter()
            cur = db.scotland_care_services.aggregate([
                {"$match": {**base, "postcode_sector": {"$in": scot}}},
                {"$group": {"_id": "$postcode_sector", "n": {"$sum": 1}}},
            ])
            for r in await cur.to_list(5000):
                merged[r["_id"]] = merged.get(r["_id"], 0) + r["n"]
        if ni:
            base = await _ni_filter()
            cur = db.ni_care_services.aggregate([
                {"$match": {**base, "postcode_sector": {"$in": ni}}},
                {"$group": {"_id": "$postcode_sector", "n": {"$sum": 1}}},
            ])
            for r in await cur.to_list(5000):
                merged[r["_id"]] = merged.get(r["_id"], 0) + r["n"]
        return merged

    async def _count_total_homes(sectors: list[str]) -> int:
        """Sum of home counts across CQC + Scotland + NI sources for the
        supplied sector list. Single call into ``_count_homes_per_sector``
        so the country-routing logic is in one place."""
        if not sectors:
            return 0
        per = await _count_homes_per_sector(sectors)
        return sum(per.values())

    async def _list_homes(sectors: list[str], limit: int) -> list[dict]:
        """Return raw home documents for the sector list, normalising
        Scottish records into the same shape the frontend expects from
        CQC docs (id / name / postcode / careHome flag).

        Provider-name enrichment: the live CQC sync stores ``providerId``
        but not ``providerName`` (the location-level CQC endpoint doesn't
        return it). The legacy ``cqc_locations`` Excel import does carry
        ``provider_name`` keyed by the same ``provider_id``. We join that
        in here so the Care Groups filter on My Territory+ can group homes
        by their parent provider/care group.
        """
        if not sectors:
            return []
        scot, ni, rest = _split_sectors_by_country(sectors)
        out: list[dict] = []
        if rest:
            homes_coll = await _homes_collection()
            base = await _homes_filter()
            cur = homes_coll.find(
                {**base, "postcode_sector": {"$in": rest}}, {"_id": 0},
            ).limit(limit)
            out.extend(await cur.to_list(limit))
        # Scottish docs surface as the same lightweight shape — frontend
        # treats them as CQC-like but tagged with country.
        if scot and len(out) < limit:
            base = await _scotland_filter()
            remaining = limit - len(out)
            cur = db.scotland_care_services.find(
                {**base, "postcode_sector": {"$in": scot}}, {"_id": 0},
            ).limit(remaining)
            for r in await cur.to_list(remaining):
                out.append({
                    "locationId": r.get("csNumber"),
                    "name": r.get("name"),
                    "postalCode": r.get("postalCode"),
                    "postcode_sector": r.get("postcode_sector"),
                    "town": r.get("town"),
                    "careHome": "Y" if r.get("careHomeMainArea") else "N",
                    "numberOfBeds": r.get("totalBeds"),
                    "gacServiceTypes": [{"name": r.get("careService")}] if r.get("careService") else [],
                    "specialisms": [{"name": r.get("clientGroup")}] if r.get("clientGroup") else [],
                    "currentRatings": {"overall": {"rating": f"Grade {r.get('minGrade')}–{r.get('maxGrade')}"}} if r.get("minGrade") else {},
                    "country": "Scotland",
                    "councilArea": r.get("councilArea"),
                    "healthBoard": r.get("healthBoard"),
                    "providerName": r.get("providerName"),
                })
        # NI docs — same normalised shape, tagged country=Northern Ireland.
        if ni and len(out) < limit:
            base = await _ni_filter()
            remaining = limit - len(out)
            cur = db.ni_care_services.find(
                {**base, "postcode_sector": {"$in": ni}}, {"_id": 0},
            ).limit(remaining)
            for r in await cur.to_list(remaining):
                out.append({
                    "locationId": r.get("serviceId"),
                    "name": r.get("name"),
                    "postalCode": r.get("postalCode"),
                    "postcode_sector": r.get("postcode_sector"),
                    "town": r.get("town"),
                    # RQIA classifies many services as "homes" but we don't
                    # have a clean Y/N flag — infer it from the service type.
                    "careHome": "Y" if ("nursing" in (r.get("serviceType") or "").lower()
                                         or "residential" in (r.get("serviceType") or "").lower())
                                else "N",
                    "numberOfBeds": r.get("maxApprovedPlaces"),
                    "gacServiceTypes": [{"name": r.get("serviceType")}] if r.get("serviceType") else [],
                    "specialisms": [{"name": c} for c in (r.get("categoriesOfCare") or [])],
                    "currentRatings": {},
                    "country": "Northern Ireland",
                    "providerName": r.get("provider"),
                    "phoneNumber": r.get("phone"),
                    "lastInspectionDate": r.get("lastInspectedDate"),
                })

        # ------ providerName enrichment from legacy cqc_locations -------
        # Collect distinct providerIds across the result that are missing
        # a providerName. Single bulk read into a {pid: name} map, then
        # patch each home doc in place. Negligible cost for ≤2000 homes.
        missing_pids: set[str] = set()
        for h in out:
            if not (h.get("providerName") or "").strip():
                pid = h.get("providerId")
                if pid:
                    missing_pids.add(pid)
        if missing_pids:
            pmap: dict = {}
            cur = db.cqc_locations.find(
                {"provider_id": {"$in": list(missing_pids)},
                 "provider_name": {"$nin": [None, ""]}},
                {"_id": 0, "provider_id": 1, "provider_name": 1},
            )
            for d in await cur.to_list(len(missing_pids) * 8):
                pid = d.get("provider_id")
                if pid and pid not in pmap:
                    pmap[pid] = d.get("provider_name")
            if pmap:
                for h in out:
                    if not (h.get("providerName") or "").strip():
                        name = pmap.get(h.get("providerId"))
                        if name:
                            h["providerName"] = name
        return out

    # ------------------------------------------------------------- geocoding
    @router.get("/territory/postcode-lookup")
    async def postcode_lookup(
        postcode: str = Query(..., min_length=2),
        _user: dict = Depends(require_role("admin", "franchisee")),
    ):
        norm_full, sector, district = parse_postcode(postcode)
        if not sector:
            raise HTTPException(400, detail="Could not parse UK postcode")
        # Local cache first
        cached = await db.postcodes_cache.find_one({"_id": norm_full}, {"_id": 0})
        if cached:
            return cached
        # Call postcodes.io (free, no key)
        url = f"https://api.postcodes.io/postcodes/{norm_full.replace(' ', '%20')}"
        async with httpx.AsyncClient(timeout=10.0) as client:
            try:
                r = await client.get(url)
                if r.status_code == 200:
                    res = r.json().get("result") or {}
                    doc = {
                        "postcode": norm_full,
                        "sector": sector,
                        "district": district,
                        "latitude": res.get("latitude"),
                        "longitude": res.get("longitude"),
                        "admin_district": res.get("admin_district"),
                        "region": res.get("region"),
                        "country": res.get("country"),
                    }
                    await db.postcodes_cache.update_one(
                        {"_id": norm_full},
                        {"$set": doc | {"_id": norm_full, "cached_at": datetime.now(timezone.utc)}},
                        upsert=True,
                    )
                    return doc
                if r.status_code == 404:
                    raise HTTPException(404, detail="Postcode not found")
                raise HTTPException(502, detail=f"postcodes.io error: {r.status_code}")
            except httpx.HTTPError as exc:
                raise HTTPException(502, detail=f"postcodes.io call failed: {exc}") from exc

    # ----------------------------------------------------------- sectors-near
    @router.get("/territory/sectors-near")
    async def sectors_near(
        lat: float = Query(...),
        lon: float = Query(...),
        radius_km: float = Query(10.0, ge=0.5, le=80.0),
        _user: dict = Depends(require_role("admin", "franchisee")),
    ):
        """Returns every postcode sector whose ONS polygon intersects a
        circle of `radius_km` around (lat, lon), with each sector's real
        boundary geometry and current CQC home count.

        Source data: `postcode_sector_polygons` (GeoLytix/ONS 2012, imported
        via ``scripts/import_postcode_sectors.py``). The 2dsphere index on
        `geometry` makes this a millisecond-scale spatial query — no
        per-postcode geocoding, no Voronoi.
        """
        import math
        # Build a circle (polygon) for $geoIntersects. MongoDB requires a
        # closed polygon ring; we approximate the great-circle disc with 36
        # vertices, which is more than enough at any UK scale.
        deg_lat = radius_km / 111.0
        deg_lon = radius_km / (111.0 * max(0.1, math.cos(math.radians(lat))))
        ring = []
        for i in range(36):
            a = 2 * math.pi * i / 36
            ring.append([lon + deg_lon * math.cos(a), lat + deg_lat * math.sin(a)])
        ring.append(ring[0])
        circle = {"type": "Polygon", "coordinates": [ring]}

        docs = await db.postcode_sector_polygons.find(
            {"geometry": {"$geoIntersects": {"$geometry": circle}}},
            {"_id": 0, "sector": 1, "district": 1, "geometry": 1, "ref_postcode": 1},
        ).to_list(2000)
        if not docs:
            return {"sectors": [], "count": 0}

        sector_codes = [d["sector"] for d in docs]
        # Home counts from live CQC + active definition (auto-routing
        # Scottish sectors to scotland_care_services).
        c_map = await _count_homes_per_sector(sector_codes)

        # Distance from request centre to each sector's reference postcode
        # (approximate — used purely for sorting & display, not selection).
        ref_pcs = [d["ref_postcode"] for d in docs if d.get("ref_postcode")]
        pc_lookup = {}
        if ref_pcs:
            pcs = await db.postcodes_cache.find(
                {"_id": {"$in": ref_pcs}},
                {"_id": 1, "latitude": 1, "longitude": 1},
            ).to_list(5000)
            pc_lookup = {p["_id"]: p for p in pcs}

        out = []
        for d in docs:
            ref = pc_lookup.get(d.get("ref_postcode") or "", {})
            d_lat = ref.get("latitude")
            d_lon = ref.get("longitude")
            if d_lat is None or d_lon is None:
                # Approximate sector centroid from the first ring vertex
                try:
                    if d["geometry"]["type"] == "Polygon":
                        coords = d["geometry"]["coordinates"][0][0]
                    else:
                        coords = d["geometry"]["coordinates"][0][0][0]
                    d_lon, d_lat = coords[0], coords[1]
                except Exception:  # noqa: BLE001
                    d_lat = d_lon = None
            if d_lat is not None:
                dx = (d_lon - lon) * math.cos(math.radians(lat)) * 111.0
                dy = (d_lat - lat) * 111.0
                dist = round(math.sqrt(dx * dx + dy * dy), 2)
            else:
                dist = 0.0
            out.append({
                "sector": d["sector"],
                "geometry": d["geometry"],
                "latitude": d_lat,
                "longitude": d_lon,
                "distance_km": dist,
                "home_count": c_map.get(d["sector"], 0),
            })
        out.sort(key=lambda x: x["distance_km"])
        return {"sectors": out, "count": len(out)}

    @router.get("/territory/sector-polygons")
    async def sector_polygons(
        sectors: str = Query(..., description="Comma-separated sector codes"),
        _user: dict = Depends(require_role("admin", "franchisee")),
    ):
        """Return real ONS boundary polygons for the requested sectors plus
        their live CQC home counts. Replaces the legacy
        ``/territory/sector-geometries`` Voronoi endpoint."""
        codes = [_normalise_sector(s) for s in sectors.split(",") if s.strip()]
        codes = [c for c in codes if c]
        if not codes:
            return {"sectors": [], "count": 0}
        docs = await db.postcode_sector_polygons.find(
            {"sector": {"$in": codes}},
            {"_id": 0, "sector": 1, "geometry": 1, "district": 1},
        ).to_list(5000)
        c_map = await _count_homes_per_sector(codes)
        out = [
            {
                "sector": d["sector"],
                "geometry": d["geometry"],
                "district": d.get("district"),
                "home_count": c_map.get(d["sector"], 0),
            }
            for d in docs
        ]
        # Sectors with no polygon (e.g. NI postcodes — not in GB dataset) are
        # still returned with a null geometry so the UI can flag them.
        found = {d["sector"] for d in docs}
        for c in codes:
            if c not in found:
                out.append({"sector": c, "geometry": None, "district": c.split(" ")[0], "home_count": c_map.get(c, 0)})
        return {"sectors": out, "count": len(out)}

    # Back-compat alias for any old frontend caches still hitting the
    # legacy endpoint name — same payload, just reads from the new collection.
    @router.get("/territory/sector-geometries")
    async def sector_geometries_alias(
        sectors: str = Query(...),
        _user: dict = Depends(require_role("admin", "franchisee")),
    ):
        return await sector_polygons(sectors=sectors, _user=_user)  # type: ignore[arg-type]

    # ------------------------------------------------------------------ homes
    @router.get("/territory/homes")
    async def homes_in_sectors(
        sectors: str = Query(..., description="Comma-separated sector codes"),
        limit: int = Query(500, le=2000),
        _user: dict = Depends(require_role("admin", "franchisee")),
    ):
        sector_list = [s.strip().upper() for s in sectors.split(",") if s.strip()]
        if not sector_list:
            return {"homes": [], "count": 0}
        homes = await _list_homes(sector_list, limit)
        return {"homes": homes, "count": len(homes)}

    @router.get("/territory/homes-count")
    async def homes_count(
        sectors: str = Query(...),
        _user: dict = Depends(require_role("admin", "franchisee")),
    ):
        sector_list = [s.strip().upper() for s in sectors.split(",") if s.strip()]
        if not sector_list:
            return {"count": 0, "per_sector": {}}
        per_map = await _count_homes_per_sector(sector_list)
        return {"count": sum(per_map.values()), "per_sector": per_map}

    # --------------------------------------------------------- plans (CRUD)
    @router.post("/territory-plans")
    async def create_plan(
        body: TerritoryPlanIn,
        user: dict = Depends(require_role("admin")),
    ):
        doc = body.model_dump()
        doc.update({
            "id": str(uuid.uuid4()),
            "created_at": datetime.now(timezone.utc),
            "created_by": user.get("email"),
        })
        await db.territory_plans.insert_one(doc)
        doc.pop("_id", None)
        return doc

    @router.get("/territory-plans")
    async def list_plans(
        contact_id: Optional[str] = None,
        franchisee_id: Optional[str] = None,
        _user: dict = Depends(require_role("admin")),
    ):
        q: dict = {}
        if contact_id:
            q["contact_id"] = contact_id
        if franchisee_id:
            q["franchisee_id"] = franchisee_id
        plans = await db.territory_plans.find(q, {"_id": 0}).sort("created_at", -1).to_list(200)
        # Attach contact name (where applicable) so the UI can label plans
        # with the prospect's name without a second round-trip. Contacts
        # may live in either ``contacts`` (legacy Airtable) or
        # ``web_form_contacts`` (newer Gravity-Forms / web intake), so we
        # query both and union the lookup.
        contact_ids = [p["contact_id"] for p in plans if p.get("contact_id")]
        if contact_ids:
            proj = {"_id": 0, "id": 1, "first_name": 1, "last_name": 1, "organisation": 1}
            legacy = await db.contacts.find({"id": {"$in": contact_ids}}, proj).to_list(500)
            webform = await db.web_form_contacts.find({"id": {"$in": contact_ids}}, proj).to_list(500)
            name_map = {c["id"]: c for c in legacy}
            for c in webform:
                name_map.setdefault(c["id"], c)
            for p in plans:
                cid = p.get("contact_id")
                if cid and cid in name_map:
                    c = name_map[cid]
                    p["contact_name"] = (
                        c.get("organisation")
                        or " ".join([c.get("first_name") or "", c.get("last_name") or ""]).strip()
                        or None
                    )
        return {"plans": plans, "count": len(plans)}

    @router.patch("/territory-plans/{plan_id}")
    async def update_plan(
        plan_id: str,
        body: TerritoryPlanIn,
        _user: dict = Depends(require_role("admin")),
    ):
        update = {k: v for k, v in body.model_dump().items() if v is not None}
        if not update:
            raise HTTPException(400, detail="Nothing to update")
        update["updated_at"] = datetime.now(timezone.utc)
        res = await db.territory_plans.update_one({"id": plan_id}, {"$set": update})
        if not res.matched_count:
            raise HTTPException(404, detail="Plan not found")
        plan = await db.territory_plans.find_one({"id": plan_id}, {"_id": 0})
        return plan

    @router.post("/territory-plans/{plan_id}/link-contact")
    async def link_plan_to_contact(
        plan_id: str,
        body: dict,
        _user: dict = Depends(require_role("admin")),
    ):
        """Associate (or dissociate) a draft territory plan with a contact.
        Body: ``{contact_id: "<id>"}`` to link, ``{contact_id: null}`` to unlink.
        Lets admins attach pre-built draft territories to a contact that came
        in later, without having to recreate the plan from scratch."""
        plan = await db.territory_plans.find_one({"id": plan_id}, {"_id": 0})
        if not plan:
            raise HTTPException(404, detail="Plan not found")
        cid = (body or {}).get("contact_id")
        if cid:
            # Validate that contact exists in either collection
            existing = await db.contacts.find_one({"id": cid}, {"_id": 0, "id": 1})
            if not existing:
                existing = await db.web_form_contacts.find_one({"id": cid}, {"_id": 0, "id": 1})
            if not existing:
                raise HTTPException(404, detail="Contact not found")
            await db.territory_plans.update_one(
                {"id": plan_id},
                {"$set": {"contact_id": cid, "updated_at": datetime.now(timezone.utc)}},
            )
        else:
            await db.territory_plans.update_one(
                {"id": plan_id},
                {"$unset": {"contact_id": ""}, "$set": {"updated_at": datetime.now(timezone.utc)}},
            )
        out = await db.territory_plans.find_one({"id": plan_id}, {"_id": 0})
        return out

    @router.delete("/territory-plans/{plan_id}")
    async def delete_plan(
        plan_id: str,
        _user: dict = Depends(require_role("admin")),
    ):
        res = await db.territory_plans.delete_one({"id": plan_id})
        if not res.deleted_count:
            raise HTTPException(404, detail="Plan not found")
        return {"ok": True}

    # ---------------------------------- share link (admin-controlled toggle)
    @router.post("/territory-plans/{plan_id}/share")
    async def share_plan(
        plan_id: str,
        _user: dict = Depends(require_role("admin")),
    ):
        """Mint (or reuse) a public share token for this plan. Anyone with
        the link can view the read-only map. Admin can revoke via DELETE."""
        plan = await db.territory_plans.find_one({"id": plan_id}, {"_id": 0})
        if not plan:
            raise HTTPException(404, detail="Plan not found")
        token = plan.get("share_token") or uuid.uuid4().hex
        await db.territory_plans.update_one(
            {"id": plan_id},
            {"$set": {
                "share_token": token,
                "is_shared": True,
                "shared_at": datetime.now(timezone.utc),
            }},
        )
        return {"share_token": token, "is_shared": True}

    @router.delete("/territory-plans/{plan_id}/share")
    async def unshare_plan(
        plan_id: str,
        _user: dict = Depends(require_role("admin")),
    ):
        """Revoke the share — the existing link will return 404."""
        res = await db.territory_plans.update_one(
            {"id": plan_id},
            {"$set": {"is_shared": False},
             "$unset": {"share_token": ""}},
        )
        if not res.matched_count:
            raise HTTPException(404, detail="Plan not found")
        return {"is_shared": False}

    # ---------------------------------- public viewer (no auth, by token)
    @router.get("/public/territory-plans/{share_token}")
    async def public_plan(share_token: str):
        """Read-only payload for the public share page. Returns the plan's
        sectors with polygon geometry + home count + centre. Excludes PII
        (contact id/name, internal notes, audit fields).
        Also records a non-PII view counter."""
        plan = await db.territory_plans.find_one(
            {"share_token": share_token, "is_shared": True},
            {"_id": 0},
        )
        if not plan:
            raise HTTPException(404, detail="This share link is no longer active.")
        sectors = plan.get("sectors") or []
        polys = []
        if sectors:
            polys = await db.postcode_sector_polygons.find(
                {"sector": {"$in": sectors}},
                {"_id": 0, "sector": 1, "geometry": 1},
            ).to_list(5000)
        home_count = 0
        per_sector: dict = {}
        if sectors:
            per_sector = await _count_homes_per_sector(sectors)
            home_count = sum(per_sector.values())
        # Bump a view counter (best-effort, no PII).
        try:
            await db.territory_plans.update_one(
                {"share_token": share_token},
                {"$inc": {"view_count": 1},
                 "$set": {"last_viewed_at": datetime.now(timezone.utc)}},
            )
        except Exception:  # noqa: BLE001
            pass
        return {
            "name": plan.get("name") or "Proposed territory",
            "sectors": [
                {"sector": p["sector"], "geometry": p.get("geometry"),
                 "home_count": per_sector.get(p["sector"], 0)}
                for p in polys
            ],
            "sector_codes": sectors,
            "home_count": home_count,
            "centre": (
                {"lat": plan.get("centre_lat"), "lng": plan.get("centre_lng")}
                if plan.get("centre_lat") is not None else None
            ),
            "centre_postcode": plan.get("centre_postcode"),
        }

    @router.post("/franchisees/{franchisee_id}/territory/parse")
    async def parse_territory_paste(
        franchisee_id: str,
        body: dict,
        _user: dict = Depends(require_role("admin")),
    ):
        """Accepts free-form text (comma-, newline- or space-separated) and
        normalises it into UK postcode sector codes. Reports which lines
        couldn't be parsed and the live home count."""
        raw = (body.get("text") or "")
        tokens = [t.strip() for t in re.split(r"[\n,;]+", raw) if t.strip()]
        good: List[str] = []
        bad: List[str] = []
        # Match patterns like "EX15 1", "EX151", "ex15 1 ab", "EX 15 1"
        sector_pat = re.compile(r"([A-Z]{1,2}\d[A-Z\d]?)\s*(\d)", re.I)
        for tok in tokens:
            m = sector_pat.match(tok.replace(" ", "")) or sector_pat.match(tok)
            if not m:
                bad.append(tok)
                continue
            sec = f"{m.group(1).upper()} {m.group(2)}"
            if sec not in good:
                good.append(sec)
        homes = 0
        if good:
            homes = await _count_total_homes(good)
        return {"sectors": good, "unrecognised": bad, "home_count": homes}

    # --------------------------- franchisee territory save (admin lock-down)
    @router.put("/franchisees/{franchisee_id}/territory")
    async def save_franchisee_territory(
        franchisee_id: str,
        body: FranchiseeTerritoryIn,
        user: dict = Depends(require_role("admin")),
    ):
        # Normalise: uppercase, single-space, dedupe
        seen: List[str] = []
        for s in body.sectors:
            v = " ".join(s.upper().split())
            if v and v not in seen:
                seen.append(v)
        # Refresh authoritative home count from CQC live data + definition
        homes = 0
        if seen:
            homes = await _count_total_homes(seen)

        # ------- snapshot BEFORE overwriting (rollback safety) -------
        # Capture the current persisted state so any save (manual,
        # accidental, or scripted) is reversible. We store the actor +
        # incoming sectors too so the audit log reads like a diff list.
        prev = await db.franchisees.find_one(
            {"id": franchisee_id},
            {"_id": 0, "territory_sectors": 1, "territory_home_count": 1,
             "territory_updated_at": 1, "territory_updated_by": 1,
             "organisation": 1},
        )
        if prev:
            await db.territory_history.insert_one({
                "id": str(uuid.uuid4()),
                "franchisee_id": franchisee_id,
                "organisation": prev.get("organisation"),
                # State BEFORE this save — what we'd restore to on rollback.
                "previous_sectors": prev.get("territory_sectors") or [],
                "previous_home_count": prev.get("territory_home_count"),
                "previous_updated_at": prev.get("territory_updated_at"),
                "previous_updated_by": prev.get("territory_updated_by"),
                # State AFTER this save — what's about to be written.
                "new_sectors": seen,
                "new_home_count": homes,
                "changed_at": datetime.now(timezone.utc),
                "changed_by": user.get("email"),
                # Quick diff metrics for the history list UI.
                "added_count": len(set(seen) - set(prev.get("territory_sectors") or [])),
                "removed_count": len(set(prev.get("territory_sectors") or []) - set(seen)),
            })

        res = await db.franchisees.update_one(
            {"id": franchisee_id},
            {"$set": {
                "territory_sectors": seen,
                "territory_home_count": homes,
                "territory_updated_at": datetime.now(timezone.utc),
                "territory_updated_by": user.get("email"),
            }},
        )
        if not res.matched_count:
            raise HTTPException(404, detail="Franchisee not found")
        return {"sectors": seen, "home_count": homes}

    # --------------------------- territory rollback (audit + restore)
    @router.get("/franchisees/{franchisee_id}/territory/history")
    async def list_territory_history(
        franchisee_id: str,
        _user: dict = Depends(require_role("admin")),
    ):
        """Most recent saves first. Each snapshot captures both the
        previous and new sector list so the admin can compare AND roll
        back to any past state with a single click."""
        cur = db.territory_history.find(
            {"franchisee_id": franchisee_id}, {"_id": 0},
        ).sort("changed_at", -1).limit(50)
        items = await cur.to_list(50)
        return {"items": items, "count": len(items)}

    @router.post("/franchisees/{franchisee_id}/territory/rollback/{history_id}")
    async def rollback_territory(
        franchisee_id: str,
        history_id: str,
        user: dict = Depends(require_role("admin")),
    ):
        """Restore the franchisee's territory to the ``previous_sectors``
        captured by the named history snapshot. The rollback itself is
        recorded as a fresh history row so the trail stays complete."""
        snap = await db.territory_history.find_one(
            {"id": history_id, "franchisee_id": franchisee_id}, {"_id": 0},
        )
        if not snap:
            raise HTTPException(404, detail="History snapshot not found")
        target_sectors = snap.get("previous_sectors") or []

        # Recalculate home count for the restored sector set so the
        # franchisee record is consistent rather than relying on the
        # cached count baked into the snapshot (CQC data may have moved).
        homes = 0
        if target_sectors:
            homes = await _count_total_homes(target_sectors)

        # Record the rollback itself as a fresh history entry.
        prev = await db.franchisees.find_one(
            {"id": franchisee_id},
            {"_id": 0, "territory_sectors": 1, "territory_home_count": 1,
             "territory_updated_at": 1, "territory_updated_by": 1,
             "organisation": 1},
        )
        if prev:
            await db.territory_history.insert_one({
                "id": str(uuid.uuid4()),
                "franchisee_id": franchisee_id,
                "organisation": prev.get("organisation"),
                "previous_sectors": prev.get("territory_sectors") or [],
                "previous_home_count": prev.get("territory_home_count"),
                "previous_updated_at": prev.get("territory_updated_at"),
                "previous_updated_by": prev.get("territory_updated_by"),
                "new_sectors": target_sectors,
                "new_home_count": homes,
                "changed_at": datetime.now(timezone.utc),
                "changed_by": user.get("email"),
                "rollback_from": history_id,
                "added_count": len(set(target_sectors) - set(prev.get("territory_sectors") or [])),
                "removed_count": len(set(prev.get("territory_sectors") or []) - set(target_sectors)),
            })

        res = await db.franchisees.update_one(
            {"id": franchisee_id},
            {"$set": {
                "territory_sectors": target_sectors,
                "territory_home_count": homes,
                "territory_updated_at": datetime.now(timezone.utc),
                "territory_updated_by": user.get("email"),
            }},
        )
        if not res.matched_count:
            raise HTTPException(404, detail="Franchisee not found")
        return {"sectors": target_sectors, "home_count": homes}

    @router.get("/franchisees/{franchisee_id}/territory")
    async def get_franchisee_territory(
        franchisee_id: str,
        _user: dict = Depends(require_role("admin")),
    ):
        f = await db.franchisees.find_one(
            {"id": franchisee_id},
            {"_id": 0, "id": 1, "postcode": 1, "territory_sectors": 1,
             "territory_home_count": 1, "territory_updated_at": 1,
             "territory_updated_by": 1, "organisation": 1, "franchise_number": 1},
        )
        if not f:
            raise HTTPException(404, detail="Franchisee not found")
        return f

    # --------------------------------------- all live franchisees overlay
    # Admin Territory Builder shows every active franchisee's locked area on
    # one map so prospects can be drawn against existing boundaries without
    # accidentally overlapping. Each franchisee gets a deterministic colour
    # (palette indexed by franchise_number) plus a clickable HQ pin.
    @router.get("/territory/all-franchisees")
    async def all_franchisees_territories(
        exclude_id: Optional[str] = None,
        _user: dict = Depends(require_role("admin")),
    ):
        # Active franchisees only — anyone tagged "Franchisee" and not flagged
        # as ex-franchisee. Excludes prospects/contacts.
        q: dict = {
            "tags": "Franchisee",
            "lifecycle_status": {"$ne": "ex_franchisee"},
            "territory_sectors": {"$exists": True, "$ne": []},
        }
        if exclude_id:
            q["id"] = {"$ne": exclude_id}
        franchisees = await db.franchisees.find(
            q,
            {"_id": 0, "id": 1, "organisation": 1, "franchise_number": 1,
             "postcode": 1, "territory_sectors": 1, "first_name": 1,
             "last_name": 1, "full_name": 1},
        ).sort("franchise_number", 1).to_list(500)

        # 24-colour high-contrast palette — distinguishable side-by-side on a
        # light-style basemap (Mapbox light-v11) and friendly to colour-blind
        # users (no adjacent reds/greens). Order is deterministic so refreshing
        # the page keeps each franchisee's colour stable.
        PALETTE = [
            "#EF4444", "#F97316", "#F59E0B", "#84CC16", "#10B981", "#06B6D4",
            "#3B82F6", "#6366F1", "#8B5CF6", "#EC4899", "#14B8A6", "#22C55E",
            "#0EA5E9", "#A855F7", "#F43F5E", "#65A30D", "#0891B2", "#7C3AED",
            "#DC2626", "#CA8A04", "#15803D", "#1D4ED8", "#BE185D", "#9333EA",
        ]

        # Bulk-load every owned sector polygon in one query
        all_sectors: list[str] = []
        for f in franchisees:
            all_sectors.extend(f.get("territory_sectors") or [])
        poly_map: dict = {}
        if all_sectors:
            polys = await db.postcode_sector_polygons.find(
                {"sector": {"$in": list(set(all_sectors))}},
                {"_id": 0, "sector": 1, "geometry": 1},
            ).to_list(20000)
            poly_map = {p["sector"]: p["geometry"] for p in polys}

        # Bulk-resolve any HQ postcodes not yet in `postcodes_cache` via
        # postcodes.io (100 per call). Keeps the overlay's HQ pins populated
        # even for franchisees whose postcode has never been individually
        # looked up before, and warms the cache for future calls.
        wanted: dict = {}  # normalised pc -> [fids]
        for f in franchisees:
            if not f.get("postcode"):
                continue
            n, _, _ = parse_postcode(f["postcode"])
            if n:
                wanted.setdefault(n, []).append(f["id"])
        cached_docs = {}
        if wanted:
            cur = db.postcodes_cache.find(
                {"_id": {"$in": list(wanted.keys())}},
                {"_id": 1, "latitude": 1, "longitude": 1},
            )
            async for c in cur:
                cached_docs[c["_id"]] = c
            missing = [pc for pc in wanted if pc not in cached_docs]
            if missing:
                try:
                    async with httpx.AsyncClient(timeout=8.0) as client:
                        for chunk_start in range(0, len(missing), 100):
                            chunk = missing[chunk_start:chunk_start + 100]
                            r = await client.post(
                                "https://api.postcodes.io/postcodes",
                                json={"postcodes": chunk},
                            )
                            if r.status_code != 200:
                                continue
                            for item in (r.json().get("result") or []):
                                q = item.get("query")
                                res = item.get("result") or {}
                                if not q or res.get("latitude") is None:
                                    continue
                                doc = {
                                    "postcode": q,
                                    "latitude": res.get("latitude"),
                                    "longitude": res.get("longitude"),
                                    "admin_district": res.get("admin_district"),
                                    "region": res.get("region"),
                                    "country": res.get("country"),
                                }
                                await db.postcodes_cache.update_one(
                                    {"_id": q},
                                    {"$set": doc | {"_id": q, "cached_at": datetime.now(timezone.utc)}},
                                    upsert=True,
                                )
                                cached_docs[q] = doc
                except httpx.HTTPError:
                    pass  # overlay is non-critical — soldier on

        franchisee_meta: list[dict] = []
        features: list[dict] = []
        # Build a shapely union per franchisee so we can (a) detect which pairs
        # share a border and (b) emit a single dissolved outline per franchisee
        # for a much clearer "edge of territory" line on the map.
        from shapely.geometry import shape, mapping
        from shapely.ops import unary_union

        unions: dict = {}  # franchisee_id -> shapely geom
        ordered: list = []  # [(fid, name, sectors, raw_franchisee)]
        for f in franchisees:
            sectors = f.get("territory_sectors") or []
            if not sectors:
                continue
            geoms = [shape(poly_map[s]) for s in sectors if s in poly_map]
            if not geoms:
                continue
            try:
                u = unary_union(geoms).buffer(0)  # buffer(0) cleans invalid geos
            except Exception:  # noqa: BLE001
                u = None
            unions[f["id"]] = u
            ordered.append(f)

        # ---------- Welsh-Powell greedy coloring ----------
        # Adjacency: a pair touches (shares a border) OR intersects (rare for
        # ONS sectors but possible after buffer-cleaning).
        adjacency: dict = {f["id"]: set() for f in ordered}
        fids = list(adjacency.keys())
        # Pre-compute bounding boxes for a fast reject before the costly geom op
        bboxes = {fid: (u.bounds if u else None) for fid, u in unions.items()}
        def _bbox_overlap(a, b):
            if not a or not b:
                return False
            return not (a[2] < b[0] or b[2] < a[0] or a[3] < b[1] or b[3] < a[1])

        for ia in range(len(fids)):
            for ib in range(ia + 1, len(fids)):
                a, b = fids[ia], fids[ib]
                ua, ub = unions.get(a), unions.get(b)
                if not ua or not ub:
                    continue
                if not _bbox_overlap(bboxes[a], bboxes[b]):
                    continue
                try:
                    # `.intersects()` covers touches (shared edge) and any
                    # overlap. Cheap once bbox-pruned.
                    if ua.intersects(ub):
                        adjacency[a].add(b)
                        adjacency[b].add(a)
                except Exception:  # noqa: BLE001
                    continue

        # Order franchisees by descending adjacency degree (Welsh-Powell). Tie
        # break by franchise_number so colour assignment is stable across
        # refreshes.
        by_fid = {f["id"]: f for f in ordered}
        order = sorted(
            fids,
            key=lambda fid: (-len(adjacency[fid]), by_fid[fid].get("franchise_number") or ""),
        )
        colour_by_fid: dict = {}
        for fid in order:
            used = {colour_by_fid[n] for n in adjacency[fid] if n in colour_by_fid}
            # Pick the lowest palette index not used by a neighbour
            chosen = next((c for c in PALETTE if c not in used), None)
            if chosen is None:
                # Palette exhausted (would need >24 mutually-adjacent
                # franchisees — won't happen in the UK). Fall back to index.
                chosen = PALETTE[len(colour_by_fid) % len(PALETTE)]
            colour_by_fid[fid] = chosen

        outline_features: list = []
        for f in ordered:
            sectors = f.get("territory_sectors") or []
            color = colour_by_fid.get(f["id"], PALETTE[0])
            name = (
                f.get("organisation")
                or f.get("full_name")
                or " ".join([(f.get("first_name") or ""), (f.get("last_name") or "")]).strip()
                or f"#{f.get('franchise_number') or '?'}"
            )
            # Separate "person owning the franchise" so the map can show both
            # the business name and the human being.
            owner_name = (
                f.get("full_name")
                or " ".join([(f.get("first_name") or ""), (f.get("last_name") or "")]).strip()
                or ""
            )
            hq_lat = None
            hq_lng = None
            if f.get("postcode"):
                n, _, _ = parse_postcode(f["postcode"])
                if n and n in cached_docs:
                    hq_lat = cached_docs[n].get("latitude")
                    hq_lng = cached_docs[n].get("longitude")
            franchisee_meta.append({
                "id": f["id"],
                "name": name,
                "owner_name": owner_name,
                "organisation": f.get("organisation"),
                "franchise_number": f.get("franchise_number"),
                "postcode": f.get("postcode"),
                "color": color,
                "sectors": sectors,
                "hq_lat": hq_lat,
                "hq_lng": hq_lng,
            })
            for s in sectors:
                geom = poly_map.get(s)
                if not geom:
                    continue
                features.append({
                    "type": "Feature",
                    "geometry": geom,
                    "properties": {
                        "sector": s,
                        "franchisee_id": f["id"],
                        "name": name,
                        "owner_name": owner_name,
                        "franchise_number": f.get("franchise_number") or "",
                        "color": color,
                    },
                })
            # Dissolved outline for the franchisee — drawn thick on the map so
            # the franchisee's overall edge stands out regardless of fill
            # colour.
            u = unions.get(f["id"])
            if u and not u.is_empty:
                outline_features.append({
                    "type": "Feature",
                    "geometry": mapping(u),
                    "properties": {
                        "franchisee_id": f["id"],
                        "name": name,
                        "color": color,
                    },
                })
        return {
            "franchisees": franchisee_meta,
            "geojson": {"type": "FeatureCollection", "features": features},
            "outlines": {"type": "FeatureCollection", "features": outline_features},
            "count": len(franchisee_meta),
        }

    # ----------------------------------------------- franchisee summary (R/O)
    @router.get("/territory/franchisee-summary")
    async def franchisee_summary(
        franchisee_id: Optional[str] = None,
        user: dict = Depends(require_role("admin", "franchisee")),
    ):
        fid = franchisee_id or user.get("franchisee_id")
        if not fid:
            raise HTTPException(400, detail="franchisee_id required")
        # Franchisees see only their own
        if user.get("role") == "franchisee" and fid != user.get("franchisee_id"):
            raise HTTPException(403, detail="Forbidden")
        f = await db.franchisees.find_one(
            {"id": fid},
            {"_id": 0, "id": 1, "franchise_number": 1, "organisation": 1,
             "postcode": 1, "territory_sectors": 1},
        )
        if not f:
            raise HTTPException(404, detail="Franchisee not found")
        sectors = f.get("territory_sectors") or []
        # Home count via live CQC + Scotland + NI sources via active rules
        count = 0
        if sectors:
            count = await _count_total_homes(sectors)
        # Centre = their HQ postcode if available (exact full postcode,
        # falls back to any postcode in the same sector if we can't resolve
        # the precise one — then warm the cache via postcodes.io).
        centre = None
        if f.get("postcode"):
            norm_full, sec, _ = parse_postcode(f["postcode"])
            if norm_full:
                exact = await db.postcodes_cache.find_one(
                    {"_id": norm_full, "latitude": {"$ne": None}},
                    {"_id": 0, "latitude": 1, "longitude": 1},
                )
                if not exact:
                    # Fetch from postcodes.io and warm the cache so subsequent
                    # loads are instant.
                    try:
                        async with httpx.AsyncClient(timeout=6.0) as client:
                            r = await client.get(
                                f"https://api.postcodes.io/postcodes/{norm_full.replace(' ', '%20')}",
                            )
                            if r.status_code == 200:
                                res = r.json().get("result") or {}
                                if res.get("latitude") is not None:
                                    exact = {
                                        "latitude": res.get("latitude"),
                                        "longitude": res.get("longitude"),
                                    }
                                    await db.postcodes_cache.update_one(
                                        {"_id": norm_full},
                                        {"$set": {
                                            "_id": norm_full,
                                            "postcode": norm_full,
                                            "sector": sec,
                                            "latitude": res.get("latitude"),
                                            "longitude": res.get("longitude"),
                                            "admin_district": res.get("admin_district"),
                                            "region": res.get("region"),
                                            "country": res.get("country"),
                                            "cached_at": datetime.now(timezone.utc),
                                        }},
                                        upsert=True,
                                    )
                    except Exception:
                        pass
                if exact:
                    centre = {"lat": exact["latitude"], "lng": exact["longitude"]}
                elif sec:
                    # Last-resort fallback — sector centroid.
                    pc_doc = await db.postcodes_cache.find_one(
                        {"sector": sec, "latitude": {"$ne": None}},
                        {"_id": 0, "latitude": 1, "longitude": 1},
                    )
                    if pc_doc:
                        centre = {"lat": pc_doc["latitude"], "lng": pc_doc["longitude"]}
        return {
            "franchisee": f,
            "sectors": sectors,
            "home_count": count,
            "centre": centre,
        }

    return router
