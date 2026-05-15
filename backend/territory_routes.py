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
        """Returns CQC postcode sectors whose centroid lies within `radius_km`
        of the provided lat/lon, each with its CQC home count and an
        approximate centre point (sampled from postcodes.io).

        Implementation uses a coarse bounding-box filter over a sample of
        postcodes within each sector — we don't store geometry for sectors
        themselves, so we approximate each sector's location by sampling
        one of its CQC home postcodes (cached via postcodes_cache).
        """
        # Convert radius to degrees. 1° lat ≈ 111 km always, 1° lon depends on lat.
        import math
        deg_lat = radius_km / 111.0
        deg_lon = radius_km / (111.0 * max(0.1, math.cos(math.radians(lat))))
        # Find any cached postcodes in the bounding box, group by sector
        box_query = {
            "latitude": {"$gte": lat - deg_lat, "$lte": lat + deg_lat},
            "longitude": {"$gte": lon - deg_lon, "$lte": lon + deg_lon},
        }
        cached_pcs = await db.postcodes_cache.find(box_query, {"_id": 0}).to_list(2000)
        seen_sectors = {pc["sector"] for pc in cached_pcs if pc.get("sector")}
        # Cold-start: if we don't yet have many cached postcodes in this area,
        # geocode a sample of CQC homes whose districts match cached districts.
        sample_districts = list({pc.get("district") for pc in cached_pcs if pc.get("district")})
        # Even colder: if the cache is completely empty in this area, fall back
        # to looking up districts geographically by sampling all CQC districts
        # — we'll attempt a few unique sectors and see which fall in the bbox.
        if not sample_districts:
            # Take 200 random CQC sectors and geocode their first postcode.
            random_sectors = await db.cqc_locations.aggregate([
                {"$sample": {"size": 250}},
                {"$group": {"_id": "$postcode_sector"}},
            ]).to_list(250)
            candidate_seed = [s["_id"] for s in random_sectors if s["_id"]]
        else:
            candidate_seed = await db.cqc_locations.distinct(
                "postcode_sector", {"postcode_district": {"$in": sample_districts}},
            )
        # For sectors we don't have a centroid for yet, geocode one sample
        missing = [s for s in candidate_seed if s and s not in seen_sectors]
        for sec in missing[:120]:  # cap geocoding per request
            sample = await db.cqc_locations.find_one(
                {"postcode_sector": sec}, {"_id": 0, "postcode": 1},
            )
            if not sample or not sample.get("postcode"):
                continue
            try:
                async with httpx.AsyncClient(timeout=5.0) as client:
                    r = await client.get(
                        f"https://api.postcodes.io/postcodes/"
                        f"{sample['postcode'].replace(' ', '%20')}",
                    )
                    if r.status_code == 200:
                        res = r.json().get("result") or {}
                        if res.get("latitude") and res.get("longitude"):
                            pc_doc = {
                                "_id": sample["postcode"],
                                "postcode": sample["postcode"],
                                "sector": sec,
                                "district": sec.split(" ")[0],
                                "latitude": res["latitude"],
                                "longitude": res["longitude"],
                                "cached_at": datetime.now(timezone.utc),
                            }
                            await db.postcodes_cache.update_one(
                                {"_id": sample["postcode"]},
                                {"$set": pc_doc},
                                upsert=True,
                            )
                            cached_pcs.append(pc_doc)
            except Exception as exc:  # noqa: BLE001
                logger.warning("Postcodes.io lookup failed for %s: %s", sec, exc)
        # Now group: one centroid per sector, plus home count
        sector_map: dict[str, dict] = {}
        for pc in cached_pcs:
            sec = pc.get("sector")
            if not sec:
                continue
            d_lat = pc.get("latitude")
            d_lon = pc.get("longitude")
            if d_lat is None or d_lon is None:
                continue
            # Distance check (simple equirectangular approximation)
            import math
            dx = (d_lon - lon) * math.cos(math.radians(lat)) * 111.0
            dy = (d_lat - lat) * 111.0
            dist = math.sqrt(dx * dx + dy * dy)
            if dist > radius_km:
                continue
            if sec not in sector_map or dist < sector_map[sec]["distance_km"]:
                sector_map[sec] = {
                    "sector": sec,
                    "latitude": d_lat,
                    "longitude": d_lon,
                    "distance_km": round(dist, 2),
                }
        # Home counts
        if sector_map:
            counts = await db.cqc_locations.aggregate([
                {"$match": {"postcode_sector": {"$in": list(sector_map.keys())}}},
                {"$group": {"_id": "$postcode_sector", "n": {"$sum": 1}}},
            ]).to_list(5000)
            for c in counts:
                if c["_id"] in sector_map:
                    sector_map[c["_id"]]["home_count"] = c["n"]
        # Attach Voronoi polygon geometries (one per sector)
        if sector_map:
            geoms = await db.sector_geometries.find(
                {"sector": {"$in": list(sector_map.keys())}},
                {"_id": 0, "sector": 1, "geometry": 1},
            ).to_list(5000)
            for g in geoms:
                if g["sector"] in sector_map:
                    sector_map[g["sector"]]["geometry"] = g["geometry"]
        result = sorted(sector_map.values(), key=lambda x: x["distance_km"])
        for r in result:
            r.setdefault("home_count", 0)
        return {"sectors": result, "count": len(result)}

    @router.get("/territory/sector-geometries")
    async def sector_geometries(
        sectors: str = Query(..., description="Comma-separated sector codes"),
        _user: dict = Depends(require_role("admin", "franchisee")),
    ):
        codes = [s.strip().upper() for s in sectors.split(",") if s.strip()]
        if not codes:
            return {"sectors": []}
        geoms = await db.sector_geometries.find(
            {"sector": {"$in": codes}}, {"_id": 0},
        ).to_list(5000)
        pcs = await db.postcodes_cache.find(
            {"sector": {"$in": codes}}, {"_id": 0, "sector": 1, "latitude": 1, "longitude": 1},
        ).to_list(5000)
        pc_map = {p["sector"]: p for p in pcs}
        counts = await db.cqc_locations.aggregate([
            {"$match": {"postcode_sector": {"$in": codes}}},
            {"$group": {"_id": "$postcode_sector", "n": {"$sum": 1}}},
        ]).to_list(5000)
        c_map = {c["_id"]: c["n"] for c in counts}
        out = []
        for g in geoms:
            sec = g["sector"]
            centre = pc_map.get(sec, {})
            out.append({
                "sector": sec,
                "geometry": g.get("geometry"),
                "latitude": centre.get("latitude"),
                "longitude": centre.get("longitude"),
                "home_count": c_map.get(sec, 0),
            })
        return {"sectors": out, "count": len(out)}

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
        cur = db.cqc_locations.find(
            {"postcode_sector": {"$in": sector_list}},
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
        per = await db.cqc_locations.aggregate([
            {"$match": {"postcode_sector": {"$in": sector_list}}},
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
            homes = await db.cqc_locations.count_documents({"postcode_sector": {"$in": good}})
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
        # Refresh authoritative home count from CQC index
        homes = 0
        if seen:
            homes = await db.cqc_locations.count_documents({"postcode_sector": {"$in": seen}})
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
        # Home count
        count = 0
        if sectors:
            count = await db.cqc_locations.count_documents(
                {"postcode_sector": {"$in": sectors}},
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
