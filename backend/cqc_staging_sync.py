"""CQC staging sync (Phase 4C non-destructive repair).

Purpose
-------
The initial May 2026 sync into ``cqc_locations_live`` completed with a
~40% deficit (73,703 of ~122,115 total CQC locations) and never wrote
its completion marker. That silent gap has been suppressing home
counts in franchisee territories (e.g. TW20 9 was showing 0 instead
of counting Rivermede Court).

This module builds an *isolated* full snapshot of the CQC dataset
into ``cqc_locations_staging`` — nothing else in the app reads that
collection — and produces a dry-run comparison report against
``cqc_locations_live``.

Absolute non-destructive guarantees enforced by this module:

* Writes only to ``cqc_locations_staging`` and the two audit
  collections ``cqc_staging_jobs`` (job control / resume state) and
  ``cqc_staging_errors`` (persisted per-ID failures — every one).
* Never touches ``cqc_locations_live``, ``franchisee_clients``,
  ``hq_home_notes``, or any other production collection.
* Idempotent + resumable — a container restart continues from the
  last completed listing page and the last completed ID.
* A staging run is only marked ``status="ok"`` when
  ``len(all_ids) == listing.total`` AND every ID either landed in
  staging or was recorded in ``cqc_staging_errors`` AND Rivermede
  Court (``1-7580341768``) is present in staging.
"""
from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timezone
from typing import Optional

import httpx

from cqc_routes import _shape_location  # reuse the exact same shaping

logger = logging.getLogger("creative-mojo-admin.cqc-staging")

CQC_BASE = "https://api.service.cqc.org.uk/public/v1"
STAGING_COLL = "cqc_locations_staging"
JOBS_COLL = "cqc_staging_jobs"
ERRORS_COLL = "cqc_staging_errors"
SENTINEL_LOCATION_ID = "1-7580341768"  # Rivermede Court — completeness check


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def _ensure_indexes(db) -> None:
    coll = db[STAGING_COLL]
    await coll.create_index("locationId", unique=True)
    await coll.create_index("postcode_sector")
    await coll.create_index("registrationStatus")
    await coll.create_index("gacServiceTypes.name")
    await db[JOBS_COLL].create_index("job_id", unique=True)
    await db[ERRORS_COLL].create_index([("job_id", 1), ("location_id", 1)])
    await db[ERRORS_COLL].create_index([("job_id", 1), ("page", 1)])


async def _fetch_with_retry(
    http: httpx.AsyncClient, url: str, headers: dict, attempts: int = 5,
) -> Optional[dict]:
    last_status = None
    for i in range(attempts):
        try:
            r = await http.get(url, headers=headers, timeout=30.0)
            last_status = r.status_code
            if r.status_code == 200:
                return r.json()
            if r.status_code == 429:
                await asyncio.sleep(2 + i * 3)
                continue
            if r.status_code >= 500:
                await asyncio.sleep(1 + i * 2)
                continue
            return None
        except (httpx.HTTPError, asyncio.TimeoutError):
            await asyncio.sleep(1 + i * 2)
    logger.warning("[cqc-staging] fetch failed after %d attempts (last_status=%s): %s", attempts, last_status, url)
    return None


async def _record_error(db, job_id: str, kind: str, page: Optional[int], location_id: Optional[str], reason: str) -> None:
    await db[ERRORS_COLL].insert_one({
        "job_id": job_id,
        "kind": kind,          # "listing_page" | "detail_fetch" | "upsert"
        "page": page,
        "location_id": location_id,
        "reason": reason,
        "at": _now(),
    })


async def _update_job(db, job_id: str, patch: dict) -> None:
    await db[JOBS_COLL].update_one({"job_id": job_id}, {"$set": patch}, upsert=True)


async def run_staging_sync(db, job_id: str) -> dict:
    """Full non-destructive staging sync. Idempotent + resumable."""
    api_key = os.environ.get("CQC_API_KEY")
    if not api_key:
        await _update_job(db, job_id, {"status": "aborted", "reason": "Missing CQC_API_KEY", "finished_at": _now()})
        return {"status": "aborted", "reason": "Missing CQC_API_KEY"}

    await _ensure_indexes(db)
    headers = {"Ocp-Apim-Subscription-Key": api_key}
    job = await db[JOBS_COLL].find_one({"job_id": job_id}) or {}
    completed_pages = set(job.get("completed_pages") or [])
    started_at = job.get("started_at") or _now()
    await _update_job(db, job_id, {
        "job_id": job_id,
        "status": "running",
        "started_at": started_at,
        "resumed_at": _now(),
    })
    logger.info("[cqc-staging] job=%s start (resumed pages=%d)", job_id, len(completed_pages))

    async with httpx.AsyncClient(http2=False) as http:
        first = await _fetch_with_retry(http, f"{CQC_BASE}/locations?perPage=1000&page=1", headers)
        if not first:
            await _record_error(db, job_id, "listing_page", 1, None, "first page failed after retries")
            await _update_job(db, job_id, {"status": "aborted", "reason": "listing page 1 failed", "finished_at": _now()})
            return {"status": "aborted", "reason": "listing page 1 failed"}
        total = first.get("total") or 0
        total_pages = first.get("totalPages") or 1
        all_ids: list[str] = [loc["locationId"] for loc in first.get("locations", [])]
        completed_pages.add(1)

        failed_pages: list[int] = []
        for page in range(2, total_pages + 1):
            if page in completed_pages:
                continue
            data = await _fetch_with_retry(http, f"{CQC_BASE}/locations?perPage=1000&page={page}", headers)
            if not data:
                await _record_error(db, job_id, "listing_page", page, None, "page failed after retries")
                failed_pages.append(page)
                continue
            all_ids.extend(loc["locationId"] for loc in data.get("locations", []))
            completed_pages.add(page)
            if page % 10 == 0:
                await _update_job(db, job_id, {"completed_pages": sorted(completed_pages), "listing_progress": len(all_ids)})

        if failed_pages:
            for page in failed_pages:
                data = await _fetch_with_retry(http, f"{CQC_BASE}/locations?perPage=1000&page={page}", headers, attempts=6)
                if data:
                    all_ids.extend(loc["locationId"] for loc in data.get("locations", []))
                    completed_pages.add(page)
                else:
                    logger.error("[cqc-staging] listing page %d unrecoverable", page)

        await _update_job(db, job_id, {
            "completed_pages": sorted(completed_pages),
            "listing_total_reported": total,
            "listing_ids_enumerated": len(all_ids),
            "listing_pages_expected": total_pages,
            "listing_failed_pages": [p for p in range(1, total_pages + 1) if p not in completed_pages],
        })

        already = set()
        async for d in db[STAGING_COLL].find({}, {"_id": 0, "locationId": 1}):
            already.add(d.get("locationId"))
        pending = [i for i in all_ids if i and i not in already]
        logger.info("[cqc-staging] enumerated=%d already_in_staging=%d pending=%d", len(all_ids), len(already), len(pending))

        sem = asyncio.Semaphore(8)
        counters = {"inserted": 0, "updated": 0, "failed": 0, "done": 0}

        async def fetch_one(loc_id: str) -> None:
            async with sem:
                doc = await _fetch_with_retry(http, f"{CQC_BASE}/locations/{loc_id}", headers)
                if not doc:
                    counters["failed"] += 1
                    await _record_error(db, job_id, "detail_fetch", None, loc_id, "detail fetch failed after retries")
                    return
                shaped = _shape_location(doc)
                try:
                    res = await db[STAGING_COLL].update_one(
                        {"locationId": shaped["locationId"]},
                        {"$set": shaped},
                        upsert=True,
                    )
                    if res.upserted_id:
                        counters["inserted"] += 1
                    elif res.modified_count:
                        counters["updated"] += 1
                except Exception as exc:  # noqa: BLE001
                    counters["failed"] += 1
                    await _record_error(db, job_id, "upsert", None, loc_id, str(exc))
                counters["done"] += 1
                if counters["done"] % 1000 == 0:
                    await _update_job(db, job_id, {**counters, "progress_at": _now()})

        WAVE = 500
        for i in range(0, len(pending), WAVE):
            tasks = [asyncio.create_task(fetch_one(lid)) for lid in pending[i:i + WAVE]]
            await asyncio.gather(*tasks, return_exceptions=True)
            await _update_job(db, job_id, {**counters, "progress_at": _now()})

        retry_ids = [d["location_id"] async for d in db[ERRORS_COLL].find(
            {"job_id": job_id, "kind": "detail_fetch"}, {"_id": 0, "location_id": 1},
        )]
        if retry_ids:
            logger.info("[cqc-staging] retry pass over %d failed IDs", len(retry_ids))
            for i in range(0, len(retry_ids), WAVE):
                tasks = [asyncio.create_task(fetch_one(lid)) for lid in retry_ids[i:i + WAVE]]
                await asyncio.gather(*tasks, return_exceptions=True)

    final_count = await db[STAGING_COLL].count_documents({})
    has_sentinel = bool(await db[STAGING_COLL].find_one({"locationId": SENTINEL_LOCATION_ID}))
    listing_complete = len(all_ids) >= total and not [p for p in range(1, total_pages + 1) if p not in completed_pages]
    unresolved_ids = [d["location_id"] async for d in db[ERRORS_COLL].find(
        {"job_id": job_id, "kind": "detail_fetch"}, {"_id": 0, "location_id": 1},
    )]

    passed_completeness = listing_complete and has_sentinel and final_count >= (total - len(unresolved_ids))
    status = "ok" if passed_completeness else "incomplete"

    await _update_job(db, job_id, {
        "status": status,
        "finished_at": _now(),
        **counters,
        "final_staging_count": final_count,
        "sentinel_present": has_sentinel,
        "listing_complete": listing_complete,
        "unresolved_ids_count": len(unresolved_ids),
    })

    logger.info("[cqc-staging] job=%s status=%s staging_count=%d sentinel=%s unresolved=%d",
                job_id, status, final_count, has_sentinel, len(unresolved_ids))
    return {"status": status, "staging_count": final_count, "sentinel_present": has_sentinel,
            "unresolved_ids": len(unresolved_ids), **counters}


async def diff_report(db, job_id: Optional[str] = None) -> dict:
    """Non-destructive comparison between staging and live."""
    from cqc_definition import CqcDefinition, definition_to_mongo_filter

    job = None
    if job_id:
        job = await db[JOBS_COLL].find_one({"job_id": job_id}, {"_id": 0})

    staging_total = await db[STAGING_COLL].count_documents({})
    live_total = await db.cqc_locations_live.count_documents({})
    staging_registered = await db[STAGING_COLL].count_documents({"registrationStatus": "Registered"})
    staging_deregistered = await db[STAGING_COLL].count_documents({"registrationStatus": "Deregistered"})

    live_ids = set()
    async for d in db.cqc_locations_live.find({}, {"_id": 0, "locationId": 1}):
        live_ids.add(d.get("locationId"))

    staging_ids = set()
    async for d in db[STAGING_COLL].find({}, {"_id": 0, "locationId": 1}):
        staging_ids.add(d.get("locationId"))

    only_in_staging = staging_ids - live_ids
    only_in_live = live_ids - staging_ids  # these are records live has but staging doesn't — advisory
    both = staging_ids & live_ids

    defn_doc = await db.cqc_definition.find_one({}, {"_id": 0})
    cq = CqcDefinition(**defn_doc) if defn_doc else CqcDefinition()
    global_filter = definition_to_mongo_filter(cq)

    # --- Records currently in LIVE (filter-matching) but reclassified in
    # staging (e.g. Deregistered upstream, or service_types no longer match).
    # Under an upsert-style commit these would flip out of the filtered view.
    # Under an insert-only commit they would remain but be stale. Surfaced
    # here so HQ can decide policy before Phase 3 runs.
    reclassified_docs: list[dict] = []
    live_filter_ids: set[str] = set()
    async for d in db.cqc_locations_live.find(global_filter, {"_id": 0, "locationId": 1}):
        if d.get("locationId"):
            live_filter_ids.add(d["locationId"])
    staging_filter_ids: set[str] = set()
    async for d in db[STAGING_COLL].find(global_filter, {"_id": 0, "locationId": 1}):
        if d.get("locationId"):
            staging_filter_ids.add(d["locationId"])
    reclassified_ids = live_filter_ids - staging_filter_ids
    reclassified_ids = {lid for lid in reclassified_ids if lid in staging_ids}
    if reclassified_ids:
        cursor = db[STAGING_COLL].find(
            {"locationId": {"$in": list(reclassified_ids)}},
            {"_id": 0, "locationId": 1, "name": 1, "postalCode": 1, "postcode_sector": 1,
             "registrationStatus": 1, "gacServiceTypes": 1, "careHome": 1},
        )
        async for d in cursor:
            live_doc = await db.cqc_locations_live.find_one(
                {"locationId": d["locationId"]},
                {"_id": 0, "registrationStatus": 1, "gacServiceTypes": 1},
            ) or {}
            reclassified_docs.append({
                "locationId": d["locationId"],
                "name": d.get("name"),
                "postalCode": d.get("postalCode"),
                "postcode_sector": d.get("postcode_sector"),
                "live_status": live_doc.get("registrationStatus"),
                "live_services": [s.get("name") for s in (live_doc.get("gacServiceTypes") or [])],
                "staging_status": d.get("registrationStatus"),
                "staging_services": [s.get("name") for s in (d.get("gacServiceTypes") or [])],
            })

    missing_registered = 0
    missing_eligible = 0
    missing_by_sector: dict[str, int] = {}
    if only_in_staging:
        cursor = db[STAGING_COLL].find(
            {"locationId": {"$in": list(only_in_staging)}},
            {"_id": 0, "locationId": 1, "registrationStatus": 1, "gacServiceTypes": 1,
             "postcode_sector": 1, "postalCode": 1, "name": 1},
        )
        eligible_ids: list[str] = []
        async for d in cursor:
            if d.get("registrationStatus") == "Registered":
                missing_registered += 1
            svcs = [s.get("name") for s in (d.get("gacServiceTypes") or [])]
            if (d.get("registrationStatus") == "Registered"
                    and any(s in cq.include_service_types for s in svcs)):
                missing_eligible += 1
                sec = d.get("postcode_sector") or "(no sector)"
                missing_by_sector[sec] = missing_by_sector.get(sec, 0) + 1
                eligible_ids.append(d.get("locationId"))

    franchisee_sectors: dict[str, list[dict]] = {}
    active_sectors = set()
    async for fr in db.franchisees.find(
        {"territory_sectors": {"$exists": True, "$ne": []},
         "lifecycle_status": {"$ne": "ex_franchisee"}},
        {"_id": 0, "id": 1, "first_name": 1, "last_name": 1, "organisation": 1,
         "franchise_number": 1, "territory_sectors": 1},
    ):
        for s in fr.get("territory_sectors") or []:
            active_sectors.add(s)
            franchisee_sectors.setdefault(s, []).append({
                "id": fr.get("id"),
                "name": f"{fr.get('first_name','')} {fr.get('last_name','')}".strip(),
                "organisation": fr.get("organisation"),
                "franchise_number": fr.get("franchise_number"),
            })

    missing_eligible_in_active_terr = 0
    by_franchisee: dict[str, dict] = {}
    for sec, add_count in missing_by_sector.items():
        if sec in active_sectors:
            missing_eligible_in_active_terr += add_count
            for fr in franchisee_sectors.get(sec, []):
                key = fr["id"]
                agg = by_franchisee.setdefault(key, {"franchisee": fr, "add_count": 0, "sectors": {}})
                agg["add_count"] += add_count
                agg["sectors"][sec] = add_count

    clementina_report = None
    clem = await db.franchisees.find_one(
        {"first_name": {"$regex": "^Clementina$", "$options": "i"}},
        {"_id": 0, "id": 1, "first_name": 1, "last_name": 1, "territory_sectors": 1},
    )
    if clem:
        clem_secs = clem.get("territory_sectors") or []
        current_live = await db.cqc_locations_live.count_documents(
            {**global_filter, "postcode_sector": {"$in": clem_secs}})
        predicted_after = await db[STAGING_COLL].count_documents(
            {**global_filter, "postcode_sector": {"$in": clem_secs}})
        clementina_report = {
            "id": clem["id"],
            "name": f"{clem.get('first_name')} {clem.get('last_name')}".strip(),
            "sector_count": len(clem_secs),
            "current_home_count_live": current_live,
            "predicted_home_count_after_append": predicted_after,
            "delta": predicted_after - current_live,
        }

    sentinel = await db[STAGING_COLL].find_one(
        {"locationId": SENTINEL_LOCATION_ID},
        {"_id": 0, "locationId": 1, "name": 1, "postalCode": 1, "postcode_sector": 1,
         "registrationStatus": 1, "gacServiceTypes": 1, "careHome": 1},
    )

    manual_link_candidates = []
    manual_review = []
    if only_in_staging:
        missing_docs = [
            d async for d in db[STAGING_COLL].find(
                {"locationId": {"$in": list(only_in_staging)}, "registrationStatus": "Registered"},
                {"_id": 0, "locationId": 1, "name": 1, "postalCode": 1},
            )
        ]
        missing_by_postcode: dict[str, list[dict]] = {}
        for d in missing_docs:
            pc = (d.get("postalCode") or "").upper().replace(" ", "")
            missing_by_postcode.setdefault(pc, []).append(d)

        async for fc in db.franchisee_clients.find({"source": "cqc"}, {"_id": 0}):
            fc_pc = (fc.get("postcode") or "").upper().replace(" ", "")
            fc_home = fc.get("home_id")
            if fc_home in only_in_staging:
                # Manual record ALREADY pointed at a locationId that _live doesn't have.
                match_doc = next((d for d in missing_docs if d["locationId"] == fc_home), None)
                if match_doc:
                    manual_link_candidates.append({
                        "franchisee_client_id": fc.get("id"),
                        "franchisee_id": fc.get("franchisee_id"),
                        "manual_name": fc.get("name"),
                        "manual_postcode": fc.get("postcode"),
                        "cqc_locationId": fc_home,
                        "cqc_name": match_doc.get("name"),
                        "cqc_postcode": match_doc.get("postalCode"),
                        "action": "already_linked_will_appear_after_append",
                    })
                    continue
            for cand in missing_by_postcode.get(fc_pc, []):
                if not fc.get("name") or not cand.get("name"):
                    continue
                a = fc.get("name").lower()
                b = cand.get("name").lower()
                if a in b or b in a or (a.split()[0] in b.split()):
                    manual_review.append({
                        "franchisee_client_id": fc.get("id"),
                        "manual_name": fc.get("name"),
                        "manual_postcode": fc.get("postcode"),
                        "possible_cqc_locationId": cand.get("locationId"),
                        "possible_cqc_name": cand.get("name"),
                        "action": "possible_duplicate_needs_manual_review",
                    })

    return {
        "job": job,
        "effective_filter": {
            "definition": cq.model_dump(),
            "mongo_filter": global_filter,
            "note": (
                "This is the SINGLE filter used everywhere in the app "
                "(Territory Builder counts, MyTerritory+ counts, this "
                "diff-report and any future append). Sourced from the "
                "cqc_definition collection via definition_to_mongo_filter()."
            ),
        },
        "totals": {
            "listing_reported_total": (job or {}).get("listing_total_reported"),
            "staging_count": staging_total,
            "staging_registered": staging_registered,
            "staging_deregistered": staging_deregistered,
            "live_count": live_total,
            "in_both": len(both),
            "only_in_staging_missing_from_live": len(only_in_staging),
            "only_in_live_absent_from_staging": len(only_in_live),
            "unresolved_ids": (job or {}).get("unresolved_ids_count", 0),
        },
        "missing_from_live": {
            "total_ids": len(only_in_staging),
            "registered": missing_registered,
            "match_global_service_types": missing_eligible,
            "in_active_franchisee_territories": missing_eligible_in_active_terr,
            "by_sector_top_20": sorted(missing_by_sector.items(), key=lambda kv: -kv[1])[:20],
            "by_franchisee_top_20": sorted(
                [
                    {"franchisee": v["franchisee"], "add_count": v["add_count"],
                     "sectors": v["sectors"]}
                    for v in by_franchisee.values()
                ],
                key=lambda x: -x["add_count"],
            )[:20],
        },
        "reclassified_records": {
            "count": len(reclassified_docs),
            "note": (
                "Records currently in live that MATCH the filter, but in "
                "staging either flip to Deregistered or drop from the "
                "filter's service types. Under upsert-style commit their "
                "filtered visibility would flip off (accepted CQC upstream "
                "signal). Under insert-only commit they would stay visible "
                "but stale. HQ policy required."
            ),
            "records": reclassified_docs[:200],
        },
        "clementina_prediction": clementina_report,
        "sentinel_rivermede_present_in_staging": sentinel is not None,
        "sentinel_details": sentinel,
        "manual_records": {
            "already_linked_will_light_up_after_append": manual_link_candidates,
            "possible_duplicates_requiring_review": manual_review,
            "note": "This report does NOT modify franchisee_clients. Any manual review action must be performed explicitly by HQ.",
        },
        "non_destructive_guarantees": {
            "existing_live_records_updated": 0,
            "existing_live_records_deleted": 0,
            "franchisee_client_records_touched": 0,
            "hq_home_notes_touched": 0,
            "franchisee_fields_overwritten": 0,
        },
        "proposed_append_count_if_committed": missing_eligible,
        "generated_at": _now().isoformat(),
    }
