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

from cqc_routes import CqcDefinition, definition_to_mongo_filter, DEFAULT_DEFINITION_ID

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
        # Home counts from live CQC + active definition
        homes_coll = await _homes_collection()
        base_filter = await _homes_filter()
        counts = await homes_coll.aggregate([
            {"$match": {**base_filter, "postcode_sector": {"$in": sector_codes}}},
            {"$group": {"_id": "$postcode_sector", "n": {"$sum": 1}}},
        ]).to_list(5000)
        c_map = {c["_id"]: c["n"] for c in counts}

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
        homes_coll = await _homes_collection()
        base_filter = await _homes_filter()
        counts = await homes_coll.aggregate([
            {"$match": {**base_filter, "postcode_sector": {"$in": codes}}},
            {"$group": {"_id": "$postcode_sector", "n": {"$sum": 1}}},
        ]).to_list(5000)
        c_map = {c["_id"]: c["n"] for c in counts}
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
        homes_coll = await _homes_collection()
        base_filter = await _homes_filter()
        cur = homes_coll.find(
            {**base_filter, "postcode_sector": {"$in": sector_list}},
            {"_id": 0},
        ).limit(limit)
        homes = await cur.to_list(limit)
        return {"homes": homes, "count": len(homes)}

    @router.get("/territory/homes-count")
    async def homes_count(
        sectors: str = Query(...),
        _user: dict = Depends(require_role("admin", "franchisee")),
    ):
        sector_list = [s.strip().upper() for s in sectors.split(",") if s.strip()]
        if not sector_list:
            return {"count": 0, "per_sector": {}}
        homes_coll = await _homes_collection()
        base_filter = await _homes_filter()
        per = await homes_coll.aggregate([
            {"$match": {**base_filter, "postcode_sector": {"$in": sector_list}}},
            {"$group": {"_id": "$postcode_sector", "n": {"$sum": 1}}},
        ]).to_list(5000)
        per_map = {p["_id"]: p["n"] for p in per}
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

    @router.delete("/territory-plans/{plan_id}")
    async def delete_plan(
        plan_id: str,
        _user: dict = Depends(require_role("admin")),
    ):
        res = await db.territory_plans.delete_one({"id": plan_id})
        if not res.deleted_count:
            raise HTTPException(404, detail="Plan not found")
        return {"ok": True}

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
            homes_coll = await _homes_collection()
            base_filter = await _homes_filter()
            homes = await homes_coll.count_documents({**base_filter, "postcode_sector": {"$in": good}})
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
            homes_coll = await _homes_collection()
            base_filter = await _homes_filter()
            homes = await homes_coll.count_documents({**base_filter, "postcode_sector": {"$in": seen}})
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
        for i, f in enumerate(franchisees):
            sectors = f.get("territory_sectors") or []
            if not sectors:
                continue
            color = PALETTE[i % len(PALETTE)]
            name = (
                f.get("organisation")
                or f.get("full_name")
                or " ".join([(f.get("first_name") or ""), (f.get("last_name") or "")]).strip()
                or f"#{f.get('franchise_number') or '?'}"
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
                        "color": color,
                    },
                })
        return {
            "franchisees": franchisee_meta,
            "geojson": {"type": "FeatureCollection", "features": features},
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
        # Home count via live CQC + active definition
        count = 0
        if sectors:
            homes_coll = await _homes_collection()
            base_filter = await _homes_filter()
            count = await homes_coll.count_documents(
                {**base_filter, "postcode_sector": {"$in": sectors}},
            )
        # Centre = their HQ postcode if available
        centre = None
        if f.get("postcode"):
            _, sec, _ = parse_postcode(f["postcode"])
            if sec:
                pc_doc = await db.postcodes_cache.find_one(
                    {"sector": sec, "latitude": {"$ne": None}}, {"_id": 0},
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
