"""Phase A + Phase C — read-only duplicate diagnostics + dry-run
merge/group plans. Every endpoint:

  * requires admin auth
  * performs ZERO database writes (no lazy back-fill, no cache write)
  * returns a common safety envelope: ``write_performed: false``,
    ``environment``, ``generated_at``, ``query``, ``diagnostic_version``
  * is a distinct route from any future write path — no `commit`
    parameter appears anywhere in this module.

Writes are OUT OF SCOPE for Phase A/C. Any future merge/repair
endpoint MUST live in a separate router so this file's read-only
guarantee stays trivially auditable.
"""
from __future__ import annotations

import os
import re
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, Query

from site_identity import (
    DIAGNOSTIC_VERSION, derived_site_key, evidence_between,
    normalise_address, normalise_name, normalise_postcode,
)


def _envelope(query: dict, *, environment: str) -> dict:
    return {
        "write_performed": False,
        "environment": environment,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "query": query,
        "diagnostic_version": DIAGNOSTIC_VERSION,
    }


def _env_name() -> str:
    return (
        os.environ.get("EMERGENT_ENVIRONMENT")
        or os.environ.get("APP_ENV")
        or ("production" if "hub.creativemojo.co.uk" in (os.environ.get("PUBLIC_BASE_URL") or "") else "preview")
    )


def build_router(db, require_role) -> APIRouter:
    router = APIRouter()

    # ------------------------------------------------------------------
    # A1. Homes-list duplicates.
    # Returns every CQC location matching a search + all other CQC
    # locations that plausibly share a physical site with them.
    @router.get("/admin/diagnostics/homes-list-duplicates")
    async def homes_list_duplicates(
        home_name: Optional[str] = Query(None),
        postcode: Optional[str] = Query(None),
        location_id: Optional[str] = Query(None),
        limit: int = Query(50, ge=1, le=200),
        _user: dict = Depends(require_role("admin")),
    ):
        assert home_name or postcode or location_id, "one of home_name, postcode or location_id is required"
        q_or: list[dict] = []
        if location_id:
            q_or.append({"location_id": location_id})
        if postcode:
            q_or.append({"postcode": {"$regex": f"^{re.escape(normalise_postcode(postcode))}$", "$options": "i"}})
        if home_name:
            rx = re.compile(re.escape(home_name), re.IGNORECASE)
            q_or.append({"name": rx})
        seed_rows = await db.cqc_locations.find({"$or": q_or}, {"_id": 0}).limit(limit).to_list(limit)

        # For each seed row, gather candidates on the same postcode +
        # any coord-close neighbours (cheap: same postcode district).
        seen_ids: set[str] = set()
        candidates: list[dict] = []
        for seed in seed_rows:
            if seed.get("location_id") in seen_ids:
                continue
            seen_ids.add(seed.get("location_id"))
            candidates.append(seed)
            pc = normalise_postcode(seed.get("postcode"))
            if not pc:
                continue
            cur = db.cqc_locations.find(
                {"postcode": {"$regex": f"^{re.escape(pc)}$", "$options": "i"},
                 "location_id": {"$ne": seed.get("location_id")}},
                {"_id": 0},
            ).limit(20)
            async for other in cur:
                if other.get("location_id") in seen_ids:
                    continue
                seen_ids.add(other.get("location_id"))
                candidates.append(other)

        # Group candidates into proposed sites using derived_site_key
        # + pairwise evidence. Ambiguous rows stay in their own group
        # of size 1 and are flagged for review.
        groups: dict[str, dict] = {}
        for row in candidates:
            key = derived_site_key(
                name=row.get("name"), address=row.get("address"), postcode=row.get("postcode"),
            )
            g = groups.setdefault(key, {"canonical_site_id": key, "members": []})
            g["members"].append(row)

        # Hydrate each group with per-member link info + evidence
        # against the group's "anchor" (first member).
        out_groups: list[dict] = []
        for key, g in groups.items():
            members = g["members"]
            anchor = members[0]
            hydrated_members: list[dict] = []
            for m in members:
                lid = m.get("location_id")
                # Franchisees whose territory sectors include this postcode sector
                pc_sector = (m.get("postcode_sector") or (normalise_postcode(m.get("postcode")).split(" ")[0] if m.get("postcode") else ""))
                territory_franchisees = await db.franchisees.find(
                    {"territory_sectors": pc_sector},
                    {"_id": 0, "id": 1, "franchise_number": 1, "organisation": 1},
                ).to_list(20)
                # My Client rows linked to this exact location_id
                clients = await db.franchisee_clients.find(
                    {"home_id": lid, "source": {"$in": ["cqc", None]}},
                    {"_id": 0, "id": 1, "franchisee_id": 1, "name": 1, "created_at": 1},
                ).to_list(50)
                # HQ notes currently keyed on this underlying identity
                notes = await db.hq_home_note_entries.count_documents({"source": "cqc", "home_id": lid})
                hydrated_members.append({
                    "cqc_location_id": lid,
                    "provider_id": m.get("provider_id"),
                    "name": m.get("name"),
                    "address": m.get("address"),
                    "postcode": m.get("postcode"),
                    "postcode_sector": m.get("postcode_sector"),
                    "coordinates": {"lat": m.get("lat"), "lng": m.get("lng")},
                    "registration_status": m.get("registration_status"),
                    "service_types": m.get("service_types"),
                    "specialisms": m.get("specialisms"),
                    "bed_count": m.get("bed_count"),
                    "provider_name": m.get("provider_name"),
                    "evidence_vs_anchor": evidence_between(anchor, m) if m is not anchor else {"anchor": True},
                    "franchisees_with_territory": territory_franchisees,
                    "my_client_records": clients,
                    "hq_note_count": notes,
                })
            # Overall grouping confidence = min pairwise vs anchor.
            confs = [h.get("evidence_vs_anchor", {}).get("confidence", "none") for h in hydrated_members if not h.get("evidence_vs_anchor", {}).get("anchor")]
            group_conf = "high" if confs and all(c == "high" for c in confs) else ("medium" if confs and all(c in ("high", "medium") for c in confs) else ("low" if confs else "n/a"))
            classification = _classify_group(members)
            out_groups.append({
                "canonical_site_id": key,
                "member_count": len(members),
                "group_confidence": group_conf,
                "classification": classification,
                "requires_human_review": (group_conf != "high") or classification.startswith("ambiguous"),
                "members": hydrated_members,
            })

        return {
            **_envelope(
                {"home_name": home_name, "postcode": postcode, "location_id": location_id, "limit": limit},
                environment=_env_name(),
            ),
            "group_count": len(out_groups),
            "groups": out_groups,
        }

    # ------------------------------------------------------------------
    # A2. My Client duplicate groups.
    @router.get("/admin/diagnostics/clients/duplicates")
    async def client_duplicates(
        franchisee_id: Optional[str] = Query(None),
        client_name: Optional[str] = Query(None),
        limit: int = Query(200, ge=1, le=500),
        _user: dict = Depends(require_role("admin")),
    ):
        q: dict = {}
        if franchisee_id:
            q["franchisee_id"] = franchisee_id
        if client_name:
            q["name"] = re.compile(re.escape(client_name), re.IGNORECASE)
        rows = await db.franchisee_clients.find(q, {"_id": 0}).limit(limit).to_list(limit)

        # Group by (franchisee_id, home_id) first — that's the strongest signal;
        # else fall back to (franchisee_id, normalised_name + postcode).
        by_home: dict[tuple, list[dict]] = {}
        by_fuzzy: dict[tuple, list[dict]] = {}
        for r in rows:
            fid = r.get("franchisee_id")
            hid = r.get("home_id")
            if fid and hid:
                by_home.setdefault((fid, hid), []).append(r)
            elif fid:
                key = (fid, normalise_name(r.get("name")), normalise_postcode(r.get("postcode")))
                if all(key):
                    by_fuzzy.setdefault(key, []).append(r)

        groups: list[dict] = []
        for (fid, hid), members in by_home.items():
            if len(members) < 2:
                continue
            groups.append(await _hydrate_client_group(
                db, members,
                rule="franchisee_id + home_id",
                canonical_source={"franchisee_id": fid, "home_id": hid},
            ))
        for (fid, nn, pc), members in by_fuzzy.items():
            if len(members) < 2:
                continue
            groups.append(await _hydrate_client_group(
                db, members,
                rule="franchisee_id + normalised_name + normalised_postcode (no home_id)",
                canonical_source={"franchisee_id": fid, "normalised_name": nn, "normalised_postcode": pc},
            ))

        return {
            **_envelope(
                {"franchisee_id": franchisee_id, "client_name": client_name, "limit": limit},
                environment=_env_name(),
            ),
            "group_count": len(groups),
            "groups": groups,
        }

    # ------------------------------------------------------------------
    # A3. Identity resolution for a single My Client record. Does NOT
    # persist anything. Returns matched / ambiguous / unmatched.
    @router.get("/admin/diagnostics/clients/{client_id}/resolve-identity")
    async def resolve_client_identity(
        client_id: str,
        _user: dict = Depends(require_role("admin")),
    ):
        client = await db.franchisee_clients.find_one({"id": client_id}, {"_id": 0})
        if not client:
            return {**_envelope({"client_id": client_id}, environment=_env_name()),
                    "status": "unmatched", "reason": "client record not found"}
        # Direct source relationship
        direct = None
        if client.get("home_id") and client.get("source") == "cqc":
            direct = await db.cqc_locations.find_one({"location_id": client["home_id"]}, {"_id": 0})
        candidates: list[dict] = []
        # Fuzzy candidates by name + postcode
        pc = normalise_postcode(client.get("postcode"))
        rx = re.compile(re.escape(client.get("name") or ""), re.IGNORECASE)
        cur = db.cqc_locations.find({
            "$or": [
                {"postcode": pc} if pc else {"_never": True},
                {"name": rx},
            ]
        }, {"_id": 0}).limit(15)
        async for row in cur:
            if not direct or row.get("location_id") != direct.get("location_id"):
                candidates.append({
                    "cqc_location_id": row.get("location_id"),
                    "name": row.get("name"),
                    "address": row.get("address"),
                    "postcode": row.get("postcode"),
                    "evidence": evidence_between(client, row),
                })
        strong = [c for c in candidates if c["evidence"]["confidence"] == "high"]
        if direct:
            status = "matched"
        elif len(strong) == 1:
            status = "matched"
        elif len(strong) > 1 or any(c["evidence"]["confidence"] == "medium" for c in candidates):
            status = "ambiguous"
        elif candidates:
            status = "ambiguous"
        else:
            status = "unmatched"
        return {
            **_envelope({"client_id": client_id}, environment=_env_name()),
            "status": status,
            "client_record_id": client_id,
            "franchisee_id": client.get("franchisee_id"),
            "source_collection": "cqc_locations" if client.get("source") == "cqc" else "manual",
            "source_home_id": client.get("home_id"),
            "source_cqc_location": direct and {
                "cqc_location_id": direct.get("location_id"),
                "name": direct.get("name"),
                "address": direct.get("address"),
                "postcode": direct.get("postcode"),
            },
            "candidates": candidates,
        }

    # ------------------------------------------------------------------
    # A4. Recent activity for a specific user (Sam).
    @router.get("/admin/diagnostics/user-activity")
    async def user_activity(
        email: Optional[str] = Query(None),
        franchisee_id: Optional[str] = Query(None),
        days: int = Query(7, ge=1, le=30),
        _user: dict = Depends(require_role("admin")),
    ):
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)
        cutoff_iso = cutoff.isoformat()
        user_row = None
        if email:
            user_row = await db.users.find_one({"email": email.lower()}, {"_id": 0, "id": 1, "email": 1, "name": 1})
        fr = None
        if franchisee_id:
            fr = await db.franchisees.find_one({"id": franchisee_id}, {"_id": 0, "id": 1, "first_name": 1, "last_name": 1, "organisation": 1})

        clients_touched, hq_notes, correspondence = [], [], []
        # My Client rows that Sam owns, updated in window
        if franchisee_id:
            async for c in db.franchisee_clients.find(
                {"franchisee_id": franchisee_id, "updated_at": {"$gte": cutoff_iso}},
                {"_id": 0},
            ):
                clients_touched.append({
                    "client_record_id": c.get("id"),
                    "name": c.get("name"),
                    "postcode": c.get("postcode"),
                    "created_at": c.get("created_at"),
                    "updated_at": c.get("updated_at"),
                    "home_id": c.get("home_id"),
                    "source": c.get("source"),
                    "note_field_current": c.get("notes"),
                    "field_level_audit_available": False,
                })
        # HQ notes authored/updated in window
        if user_row or franchisee_id:
            q = {"$or": [{"created_at": {"$gte": cutoff_iso}}, {"updated_at": {"$gte": cutoff_iso}}]}
            if franchisee_id:
                q = {"$and": [q, {"franchisee_id": franchisee_id}]}
            async for h in db.hq_home_note_entries.find(q, {"_id": 0}).limit(200):
                hq_notes.append({
                    "entry_id": h.get("id"),
                    "franchisee_id": h.get("franchisee_id"),
                    "source": h.get("source"),
                    "home_id": h.get("home_id"),
                    "created_at": h.get("created_at"),
                    "updated_at": h.get("updated_at"),
                    "created_by": h.get("created_by"),
                    "text_preview": (h.get("note") or "")[:200],
                })

        return {
            **_envelope(
                {"email": email, "franchisee_id": franchisee_id, "days": days},
                environment=_env_name(),
            ),
            "user": user_row,
            "franchisee": fr,
            "cutoff": cutoff_iso,
            "field_level_audit_available": False,
            "clients_touched": clients_touched,
            "hq_notes": hq_notes,
            "correspondence": correspondence,
            "notes": (
                "Field-level audit rows are NOT available for these collections. "
                "Values shown are the current record contents plus created/updated timestamps only; "
                "do NOT describe them as verified field-level changes."
            ),
        }

    # ------------------------------------------------------------------
    # C1. Dry-run merge plan for a My Client duplicate group.
    @router.post("/admin/diagnostics/dry-run/client-merge")
    async def dry_run_client_merge(
        body: dict,
        _user: dict = Depends(require_role("admin")),
    ):
        record_ids = list((body or {}).get("record_ids") or [])
        assert len(record_ids) >= 2, "at least two record_ids required"
        rows = await db.franchisee_clients.find({"id": {"$in": record_ids}}, {"_id": 0}).to_list(len(record_ids))
        assert len(rows) == len(record_ids), "one or more record_ids not found"

        # Rank candidates for canonical survivor.
        def score(r: dict) -> tuple:
            has_source = 1 if (r.get("source") == "cqc" and r.get("home_id")) else 0
            notes_len = len((r.get("notes") or ""))
            contacts_n = len(r.get("contacts") or [])
            updated = r.get("updated_at") or ""
            return (has_source, contacts_n, notes_len, updated)
        rows_ranked = sorted(rows, key=score, reverse=True)
        survivor = rows_ranked[0]
        archived = rows_ranked[1:]

        # Field-by-field plan.
        conflicts: list[dict] = []
        retained: dict = {}
        copied: dict = {}
        combined: dict = {}
        all_keys = {k for r in rows for k in r.keys()} - {"id", "_id"}
        for key in sorted(all_keys):
            s_val = survivor.get(key)
            others = [(r["id"], r.get(key)) for r in archived]
            non_empty_others = [(rid, v) for rid, v in others if v not in (None, "", [], {})]
            if not non_empty_others:
                retained[key] = s_val
                continue
            if key in ("notes",):
                # Text fields → propose combining with separator
                parts = [s_val] + [v for _, v in non_empty_others]
                combined[key] = {"strategy": "append_with_separator", "parts": [p for p in parts if p]}
                continue
            if key == "contacts":
                combined[key] = {"strategy": "union_by_email_or_phone",
                                 "survivor_count": len(s_val or []),
                                 "additions_from": [rid for rid, _ in non_empty_others]}
                continue
            if s_val in (None, "", [], {}):
                # Survivor is empty for this field → copy the first non-empty other, flag if >1 differ
                distinct = {v for _, v in non_empty_others if v is not None}
                if len(distinct) == 1:
                    copied[key] = {"from_record_id": non_empty_others[0][0], "value": non_empty_others[0][1]}
                else:
                    conflicts.append({"field": key, "candidates": non_empty_others, "requires_human_decision": True})
                continue
            # Survivor has a value; if others differ non-emptily → conflict, never silently overwrite
            differing = [(rid, v) for rid, v in non_empty_others if v != s_val]
            if differing:
                conflicts.append({
                    "field": key,
                    "survivor_value": s_val, "other_values": differing,
                    "requires_human_decision": True,
                })
            else:
                retained[key] = s_val

        return {
            **_envelope({"record_ids": record_ids}, environment=_env_name()),
            "proposed_survivor_id": survivor["id"],
            "reason_for_selection": [
                "record has direct source relationship (source=cqc + home_id)" if (survivor.get("source") == "cqc" and survivor.get("home_id")) else None,
                f"contacts_count={len(survivor.get('contacts') or [])}",
                f"notes_length={len(survivor.get('notes') or '')}",
                f"updated_at={survivor.get('updated_at')}",
            ],
            "proposed_archived_ids": [r["id"] for r in archived],
            "fields_retained": retained,
            "fields_copied": copied,
            "fields_combined": combined,
            "conflicts_requiring_human_decision": conflicts,
            "foreign_references_to_update": [
                {"collection": "hq_home_note_entries", "field": "home_id",
                 "note": "HQ notes reference source home_id, NOT client_record_id — merging clients does not affect them."},
            ],
            "pre_merge_snapshots": rows,
            "proposed_audit_entry": {
                "collection": "clients_merge_audit",
                "surviving_record_id": survivor["id"],
                "archived_record_ids": [r["id"] for r in archived],
                "pre_merge_snapshots": rows,
                "fields_retained_keys": sorted(retained.keys()),
                "fields_copied_keys": sorted(copied.keys()),
                "fields_combined_keys": sorted(combined.keys()),
                "conflict_fields": [c["field"] for c in conflicts],
                "merge_timestamp": "<set at commit time>",
                "admin_performing_merge": "<set at commit time>",
            },
        }

    # ------------------------------------------------------------------
    # C2. Dry-run site grouping for the Homes list (visual only).
    @router.post("/admin/diagnostics/dry-run/site-group")
    async def dry_run_site_group(
        body: dict,
        _user: dict = Depends(require_role("admin")),
    ):
        loc_ids = list((body or {}).get("cqc_location_ids") or [])
        assert len(loc_ids) >= 2, "at least two cqc_location_ids required"
        members = await db.cqc_locations.find({"location_id": {"$in": loc_ids}}, {"_id": 0}).to_list(len(loc_ids))
        assert len(members) == len(loc_ids), "one or more location_ids not found"
        anchor = members[0]
        evidence = [{"cqc_location_id": m["location_id"], "evidence_vs_anchor": evidence_between(anchor, m) if m is not anchor else {"anchor": True}} for m in members]
        # Conflicts across the group
        conflicts = {}
        for key in ("name", "address", "postcode", "provider_id", "provider_name"):
            distinct = {m.get(key) for m in members if m.get(key)}
            if len(distinct) > 1:
                conflicts[key] = sorted(str(v) for v in distinct)
        return {
            **_envelope({"cqc_location_ids": loc_ids}, environment=_env_name()),
            "proposed_canonical_site_id": derived_site_key(
                name=anchor.get("name"), address=anchor.get("address"), postcode=anchor.get("postcode"),
            ),
            "action": "visual_grouping_only",
            "primary_display": {
                "name": anchor.get("name"), "address": anchor.get("address"), "postcode": anchor.get("postcode"),
            },
            "registrations": [
                {"cqc_location_id": m["location_id"], "name": m.get("name"), "address": m.get("address"),
                 "service_types": m.get("service_types"), "bed_count": m.get("bed_count"),
                 "registration_status": m.get("registration_status")}
                for m in members
            ],
            "evidence": evidence,
            "conflicts_across_registrations": conflicts,
            "presentation_notes": {
                "bed_count": "Do NOT sum across registrations without human review — same beds may be counted twice.",
                "service_types": "Show per-registration; do not union without human review.",
                "expandable_row": "Grouped site row must remain expandable to reveal each cqc_location_id separately.",
            },
        }

    return router


# ------------------------------------------------------------------
async def _hydrate_client_group(db, members: list[dict], *, rule: str, canonical_source: dict) -> dict:
    hydrated = []
    for m in members:
        source_resolves_to = None
        if m.get("home_id") and m.get("source") == "cqc":
            found = await db.cqc_locations.find_one(
                {"location_id": m["home_id"]},
                {"_id": 0, "location_id": 1, "name": 1, "address": 1, "postcode": 1},
            )
            source_resolves_to = found or {"status": "orphaned — home_id no longer matches any cqc_locations row"}
        # HQ notes keyed on (franchisee_id, source, home_id)
        note_query = {"franchisee_id": m.get("franchisee_id"), "source": m.get("source"), "home_id": m.get("home_id")}
        note_ids = []
        async for h in db.hq_home_note_entries.find(note_query, {"_id": 0, "id": 1, "created_at": 1}):
            note_ids.append(h)
        hydrated.append({
            "client_record_id": m.get("id"),
            "franchisee_id": m.get("franchisee_id"),
            "source_collection": "franchisee_clients",
            "source_home_id": m.get("home_id"),
            "source_home_id_resolves_to": source_resolves_to,
            "name": m.get("name"),
            "address": m.get("address"),
            "postcode": m.get("postcode"),
            "normalised_name": normalise_name(m.get("name")),
            "normalised_address": normalise_address(m.get("address")),
            "normalised_postcode": normalise_postcode(m.get("postcode")),
            "created_at": m.get("created_at"),
            "updated_at": m.get("updated_at"),
            "created_by": m.get("created_by"),
            "last_edited_by": m.get("updated_by"),
            "client_status": m.get("status"),
            "archive_status": m.get("archived"),
            "notes": m.get("notes"),
            "contacts": m.get("contacts") or [],
            "hq_note_entry_ids": note_ids,
            "hq_note_reference": "keyed_by (franchisee_id, source, home_id) — NOT client_record_id",
        })
    conflicts = _conflicts_across_records(members)
    return {
        "grouping_rule": rule,
        "canonical_source": canonical_source,
        "record_count": len(members),
        "records": hydrated,
        "conflicts_across_records": conflicts,
    }


def _conflicts_across_records(members: list[dict]) -> dict:
    out: dict = {}
    for key in ("name", "postcode", "address", "phone", "email", "manager", "website"):
        distinct = {m.get(key) for m in members if m.get(key)}
        if len(distinct) > 1:
            out[key] = sorted(str(v) for v in distinct)
    return out


def _classify_group(members: list[dict]) -> str:
    """Distinguish (a) same DB row rendered twice, (b) two CQC
    registrations at one site, (c) duplicated CQC import, (d) two
    genuinely separate services with similar names/addresses."""
    if len({m.get("location_id") for m in members}) < len(members):
        return "duplicate_render_same_record"
    prov = {m.get("provider_id") for m in members if m.get("provider_id")}
    addrs = {normalise_address(m.get("address")) for m in members}
    names = {normalise_name(m.get("name")) for m in members}
    if len(addrs) == 1 and len(prov) == 1 and len(names) == 1:
        return "duplicated_cqc_import"
    if len(addrs) == 1 and len(names) <= 2 and len(prov) <= 2:
        return "two_cqc_registrations_at_one_site"
    if len(addrs) > 1 and (len(names) > 1 or len(prov) > 1):
        return "ambiguous_possibly_distinct_services"
    return "ambiguous_requires_review"
