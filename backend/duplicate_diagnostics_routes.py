"""Phase A + Phase C — read-only duplicate diagnostics + dry-run
merge/group plans. Every endpoint:

  * requires admin auth
  * performs ZERO database writes (no lazy back-fill, no cache write)
  * returns a common safety envelope: ``write_performed: false``,
    ``environment``, ``generated_at``, ``query``, ``diagnostic_version``,
    ``build_commit``, ``capabilities``
  * is a distinct route from any future write path — no `commit`
    parameter appears anywhere in this module.

Writes are OUT OF SCOPE for Phase A/C. Any future merge/repair
endpoint MUST live in a separate router so this file's read-only
guarantee stays trivially auditable.

Data-source notes (verified against the codebase, Aug 2026):
  * HQ notes live in ``hq_home_notes`` (append-only, one document per
    entry). Identity tuple: ``(franchisee_id, source, home_id)``.
  * Correspondence lives in three collections — ``email_sends`` (out),
    ``email_inbounds`` (in, matched), ``email_inbound_unmatched`` (in,
    unmatched). All three key on ``contact_id`` which points at
    ``contacts`` OR ``web_form_contacts`` — NOT at ``franchisee_clients``.
  * There is NO internal bookings collection in the codebase. The
    ``bookings`` string on the platform refers to a subscription add-on
    flag; ``bookings_url`` is a free-text external URL. This module
    reports that fact honestly rather than inventing a link.
"""
from __future__ import annotations

import os
import re
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, Query

from site_identity import (
    BUILD_COMMIT, DIAGNOSTIC_VERSION, derived_site_key, evidence_between,
    normalise_address, normalise_name, normalise_postcode,
)


HQ_NOTES_COLLECTION = "hq_home_notes"

BOOKINGS_CAPABILITY = {
    "status": "no_internal_bookings_collection_in_codebase",
    "explanation": (
        "The ``bookings`` string in the codebase refers to a subscription "
        "module/add-on flag (``Bookings+``), NOT an implemented internal "
        "booking record system. ``bookings_url`` on marketing campaigns is "
        "a free-text external URL and is NOT counted as a booking record."
    ),
    "code_paths_searched": [
        "server.py", "portal_marketing_routes.py", "territory_plus_routes.py",
        "correspondence_routes.py", "resend_routes.py", "franchisee_admin_routes.py",
    ],
    "database_references_searched": [
        "db.bookings", "db.franchisee_bookings", "db.calendar_bookings",
        "db.care_bookings", "db.client_bookings",
    ],
}

CORRESPONDENCE_CAPABILITY = {
    "outbound_collection": "email_sends",
    "inbound_matched_collection": "email_inbounds",
    "inbound_unmatched_collection": "email_inbound_unmatched",
    "linkage_field": "contact_id → contacts OR web_form_contacts",
    "franchisee_client_direct_link": (
        "NONE — franchisee_clients has no contact_id / reply_token relationship "
        "to the correspondence CRM. Any linkage from a franchisee_clients row "
        "to correspondence is heuristic (email-address match) and must be flagged "
        "as inferred, requires_human_verification=true, safe_for_automatic_merge=false."
    ),
}


def _envelope(query: dict, *, environment: str) -> dict:
    return {
        "write_performed": False,
        "environment": environment,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "query": query,
        "diagnostic_version": DIAGNOSTIC_VERSION,
        "build_commit": BUILD_COMMIT,
        "capabilities": {
            "bookings": BOOKINGS_CAPABILITY,
            "correspondence": CORRESPONDENCE_CAPABILITY,
            "hq_notes_collection": HQ_NOTES_COLLECTION,
        },
    }


def _env_name() -> str:
    return (
        os.environ.get("EMERGENT_ENVIRONMENT")
        or os.environ.get("APP_ENV")
        or ("production" if "hub.creativemojo.co.uk" in (os.environ.get("PUBLIC_BASE_URL") or "") else "preview")
    )


def _norm_email(v) -> str:
    return (str(v or "").strip().lower())


def _hq_note_view(row: dict) -> dict:
    """One HQ-note row → response shape with explicit identity_key.
    Deliberately does NOT include the full ``note`` text — IDs and
    identity are sufficient for a first-level duplicate report."""
    return {
        "entry_id": row.get("id"),
        "franchisee_id": row.get("franchisee_id"),
        "source": row.get("source"),
        "home_id": row.get("home_id"),
        "created_at": row.get("created_at") or row.get("updated_at"),
        "updated_at": row.get("updated_at"),
        "updated_by": row.get("updated_by") or row.get("updated_by_name"),
        "identity_key": {
            "tuple": ["franchisee_id", "source", "home_id"],
            "values": [row.get("franchisee_id"), row.get("source"), row.get("home_id")],
        },
    }


async def _collect_hq_notes_for_home(db, home_id: str) -> list[dict]:
    """Return every HQ note keyed on ``home_id`` across franchisees.
    Sorted newest-first. Read-only."""
    if not home_id:
        return []
    out: list[dict] = []
    async for row in db[HQ_NOTES_COLLECTION].find(
        {"source": "cqc", "home_id": home_id}, {"_id": 0},
    ).sort([("updated_at", -1)]):
        out.append(_hq_note_view(row))
    return out


async def _client_emails(client: dict) -> list[dict]:
    """Extract every email address (with the field-name that produced
    it) from a franchisee_clients row. Used to build heuristic
    correspondence links."""
    out: list[dict] = []
    seen: set[str] = set()

    def _add(email, source):
        e = _norm_email(email)
        if e and e not in seen and "@" in e:
            seen.add(e)
            out.append({"email": e, "client_email_field": source})

    _add(client.get("email"), "email")
    _add((client.get("manager") or {}).get("email") if isinstance(client.get("manager"), dict) else None, "manager.email")
    for i, c in enumerate(client.get("contacts") or []):
        _add((c or {}).get("email"), f"contacts[{i}].email")
    return out


async def _correspondence_for_client(db, client: dict, all_clients_by_email: dict, all_contacts_by_email: dict) -> dict:
    """Build the correspondence_linkage block for one client record.

    * ``direct_link.status`` is always ``"none"`` — the data model does
      not link franchisee_clients rows to correspondence directly.
    * ``inferred_matches`` are exact case-insensitive email hits on
      structured ``to``/``cc``/``bcc``/``from`` fields only (never
      body-text scraping).
    """
    inferred: list[dict] = []
    fid = client.get("franchisee_id")

    for entry in await _client_emails(client):
        e = entry["email"]

        # ---- outbound (email_sends) — recipient side
        async for row in db.email_sends.find({
            "$or": [{"to": e}, {"cc": e}, {"bcc": e}, {"from": e}],
        }, {"_id": 0}).limit(50):
            recipient_side = "to" if e in (row.get("to") or []) else \
                             "cc" if e in (row.get("cc") or []) else \
                             "bcc" if e in (row.get("bcc") or []) else "from"
            contact_id = row.get("contact_id")
            contact_row, contact_coll = await _lookup_contact(db, contact_id)
            other_recipients_count = len([x for x in (row.get("to") or []) if x != e]) + \
                                     len([x for x in (row.get("cc") or []) if x != e])
            inferred.append(_inferred_match(
                collection="email_sends", row=row, direction="outbound",
                matched_email=e, client_email_field=entry["client_email_field"],
                correspondence_email_field=recipient_side,
                contact_row=contact_row, contact_coll=contact_coll,
                client=client, all_clients_by_email=all_clients_by_email,
                all_contacts_by_email=all_contacts_by_email,
                extra_ambiguity={
                    "correspondence_has_other_recipients": other_recipients_count > 0,
                    "other_recipient_count": other_recipients_count,
                    "created_at": row.get("sent_at"),
                    "subject": row.get("subject"),
                    "correspondence_id": row.get("id"),
                },
            ))

        # ---- inbound matched (email_inbounds) — sender or recipient side
        async for row in db.email_inbounds.find({
            "$or": [{"from": {"$regex": re.escape(e), "$options": "i"}},
                    {"to": {"$regex": re.escape(e), "$options": "i"}}],
        }, {"_id": 0}).limit(50):
            side = "from" if e in (row.get("from") or "").lower() else "to"
            contact_id = row.get("contact_id")
            contact_row, contact_coll = await _lookup_contact(db, contact_id)
            inferred.append(_inferred_match(
                collection="email_inbounds", row=row, direction="inbound_matched",
                matched_email=e, client_email_field=entry["client_email_field"],
                correspondence_email_field=side,
                contact_row=contact_row, contact_coll=contact_coll,
                client=client, all_clients_by_email=all_clients_by_email,
                all_contacts_by_email=all_contacts_by_email,
                extra_ambiguity={
                    "correspondence_has_other_recipients": False,
                    "other_recipient_count": 0,
                    "created_at": row.get("received_at"),
                    "subject": row.get("subject"),
                    "correspondence_id": row.get("id"),
                    "match_method": row.get("match_method"),
                },
            ))

    # De-dupe by (collection, correspondence_id)
    seen = set()
    deduped = []
    for m in inferred:
        k = (m["correspondence_collection"], m["correspondence_id"])
        if k in seen:
            continue
        seen.add(k)
        deduped.append(m)

    return {
        "direct_link": {
            "status": "none",
            "reason": ("franchisee_clients has no contact_id or reply_token "
                       "relationship to the correspondence CRM"),
        },
        "inferred_matches": deduped,
        "inferred_matches_count": len(deduped),
        "unmatched_inbound_note": (
            "email_inbound_unmatched is NOT scanned per-client — body-text "
            "email hits are not evidence. Sam's user_activity endpoint "
            "reports structured-header matches only, flagged inferred."
        ),
    }


def _inferred_match(*, collection, row, direction, matched_email, client_email_field,
                    correspondence_email_field, contact_row, contact_coll,
                    client, all_clients_by_email, all_contacts_by_email,
                    extra_ambiguity: dict) -> dict:
    fid_client = client.get("franchisee_id")
    contact_fid = (contact_row or {}).get("franchisee_id")
    clients_sharing_email = all_clients_by_email.get(matched_email, [])
    contacts_sharing_email = all_contacts_by_email.get(matched_email, [])
    ambiguity_flags: list[str] = []
    if len(clients_sharing_email) > 1:
        ambiguity_flags.append("email_shared_by_multiple_client_records")
    if len(contacts_sharing_email) > 1:
        ambiguity_flags.append("email_shared_by_multiple_contacts")
    if extra_ambiguity.get("correspondence_has_other_recipients"):
        ambiguity_flags.append("correspondence_has_multiple_recipients_only_one_matched")
    if contact_fid and fid_client and contact_fid != fid_client:
        ambiguity_flags.append("contact_franchisee_mismatch")
    if contact_row and row.get("contact_id") and contact_row.get("email") and \
       _norm_email(contact_row.get("email")) != matched_email:
        ambiguity_flags.append("email_conflicts_with_contact_id_relationship")
    return {
        "correspondence_id": extra_ambiguity.get("correspondence_id") or row.get("id"),
        "correspondence_collection": collection,
        "direction": direction,
        "subject": extra_ambiguity.get("subject"),
        "created_at": extra_ambiguity.get("created_at"),
        "matched_email": matched_email,
        "client_email_field": client_email_field,
        "correspondence_email_field": correspondence_email_field,
        "contact_id": row.get("contact_id"),
        "contact_collection": contact_coll,
        "contact_franchisee_id": contact_fid,
        "link_type": "heuristic_email_match",
        "confidence": "inferred",
        "requires_human_verification": True,
        "safe_for_automatic_merge": False,
        "ambiguity_flags": ambiguity_flags,
        "match_method": extra_ambiguity.get("match_method"),
    }


async def _lookup_contact(db, contact_id: Optional[str]):
    if not contact_id:
        return None, None
    row = await db.contacts.find_one({"id": contact_id}, {"_id": 0})
    if row:
        return row, "contacts"
    row = await db.web_form_contacts.find_one({"id": contact_id}, {"_id": 0})
    if row:
        return row, "web_form_contacts"
    return None, None


async def _build_email_indexes(db, franchisee_id: Optional[str] = None) -> tuple[dict, dict]:
    """Return two indexes for heuristic-match ambiguity flags:
      * ``clients_by_email`` — every franchisee_clients row that carries
        that email (in ``email``, ``manager.email`` or ``contacts[*].email``)
      * ``contacts_by_email`` — every (contacts + web_form_contacts) row
        that carries that email
    Scoped by ``franchisee_id`` on the clients side when supplied.
    """
    q = {"franchisee_id": franchisee_id} if franchisee_id else {}
    clients_by_email: dict[str, list[dict]] = {}
    async for c in db.franchisee_clients.find(q, {"_id": 0}):
        for entry in await _client_emails(c):
            clients_by_email.setdefault(entry["email"], []).append({
                "client_record_id": c.get("id"), "franchisee_id": c.get("franchisee_id"),
                "field": entry["client_email_field"],
            })
    contacts_by_email: dict[str, list[dict]] = {}
    for coll in ("contacts", "web_form_contacts"):
        async for r in db[coll].find({"email": {"$exists": True, "$ne": None}}, {"_id": 0}):
            e = _norm_email(r.get("email"))
            if e:
                contacts_by_email.setdefault(e, []).append({
                    "contact_id": r.get("id"), "collection": coll,
                    "franchisee_id": r.get("franchisee_id"),
                })
    return clients_by_email, contacts_by_email


def build_router(db, require_role) -> APIRouter:
    router = APIRouter()

    # ------------------------------------------------------------------
    # A1. Homes-list duplicates.
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

        groups: dict[str, dict] = {}
        for row in candidates:
            key = derived_site_key(
                name=row.get("name"), address=row.get("address"), postcode=row.get("postcode"),
            )
            g = groups.setdefault(key, {"canonical_site_id": key, "members": []})
            g["members"].append(row)

        out_groups: list[dict] = []
        for key, g in groups.items():
            members = g["members"]
            anchor = members[0]
            hydrated_members: list[dict] = []
            for m in members:
                lid = m.get("location_id")
                pc_sector = (m.get("postcode_sector") or (normalise_postcode(m.get("postcode")).split(" ")[0] if m.get("postcode") else ""))
                territory_franchisees = await db.franchisees.find(
                    {"territory_sectors": pc_sector},
                    {"_id": 0, "id": 1, "franchise_number": 1, "organisation": 1},
                ).to_list(20)
                clients = await db.franchisee_clients.find(
                    {"home_id": lid, "source": {"$in": ["cqc", None]}},
                    {"_id": 0, "id": 1, "franchisee_id": 1, "name": 1, "created_at": 1},
                ).to_list(50)
                hq_notes = await _collect_hq_notes_for_home(db, lid)
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
                    "hq_notes": hq_notes,
                    "hq_note_count": len(hq_notes),
                    "hq_note_identity_key": {
                        "tuple": ["franchisee_id", "source", "home_id"],
                        "note": "HQ notes are keyed on this tuple in hq_home_notes.",
                    },
                    "bookings": [],
                })
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

        clients_idx, contacts_idx = await _build_email_indexes(db, franchisee_id)

        groups: list[dict] = []
        for (fid, hid), members in by_home.items():
            if len(members) < 2:
                continue
            groups.append(await _hydrate_client_group(
                db, members,
                rule="franchisee_id + home_id",
                canonical_source={"franchisee_id": fid, "home_id": hid},
                clients_idx=clients_idx, contacts_idx=contacts_idx,
            ))
        for (fid, nn, pc), members in by_fuzzy.items():
            if len(members) < 2:
                continue
            groups.append(await _hydrate_client_group(
                db, members,
                rule="franchisee_id + normalised_name + normalised_postcode (no home_id)",
                canonical_source={"franchisee_id": fid, "normalised_name": nn, "normalised_postcode": pc},
                clients_idx=clients_idx, contacts_idx=contacts_idx,
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
    # A3. Identity resolution for a single My Client record.
    @router.get("/admin/diagnostics/clients/{client_id}/resolve-identity")
    async def resolve_client_identity(
        client_id: str,
        _user: dict = Depends(require_role("admin")),
    ):
        client = await db.franchisee_clients.find_one({"id": client_id}, {"_id": 0})
        if not client:
            return {**_envelope({"client_id": client_id}, environment=_env_name()),
                    "status": "unmatched", "reason": "client record not found"}
        direct = None
        if client.get("home_id") and client.get("source") == "cqc":
            direct = await db.cqc_locations.find_one({"location_id": client["home_id"]}, {"_id": 0})
        candidates: list[dict] = []
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
            fr = await db.franchisees.find_one({"id": franchisee_id}, {"_id": 0, "id": 1, "first_name": 1, "last_name": 1, "organisation": 1, "email": 1, "franchise_number": 1})

        clients_touched, hq_notes, correspondence = [], [], []

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
        if user_row or franchisee_id:
            q = {"$or": [{"created_at": {"$gte": cutoff_iso}}, {"updated_at": {"$gte": cutoff_iso}}]}
            if franchisee_id:
                q = {"$and": [q, {"franchisee_id": franchisee_id}]}
            async for h in db[HQ_NOTES_COLLECTION].find(q, {"_id": 0}).limit(200):
                hq_notes.append(_hq_note_view(h))

        # ---- correspondence (see class docstring)
        sam_email = _norm_email(email) if email else _norm_email(user_row and user_row.get("email"))
        # Contacts owned by Sam via web_form_contacts.franchisee_id
        sam_contact_ids: set[str] = set()
        if franchisee_id:
            async for c in db.web_form_contacts.find(
                {"franchisee_id": franchisee_id}, {"_id": 0, "id": 1},
            ):
                if c.get("id"):
                    sam_contact_ids.add(c["id"])

        # Client emails for inferred-only correspondence linkage
        client_emails: set[str] = set()
        if franchisee_id:
            async for c in db.franchisee_clients.find({"franchisee_id": franchisee_id}, {"_id": 0}):
                for entry in await _client_emails(c):
                    client_emails.add(entry["email"])

        # OUTBOUND (email_sends)
        out_q = {"sent_at": {"$gte": cutoff_iso}}
        async for row in db.email_sends.find(out_q, {"_id": 0}).limit(500):
            attribution_type = None
            attribution_reason = None
            sender = _norm_email(row.get("sent_by"))
            contact_id = row.get("contact_id")
            direct = False
            requires_verify = False
            if sam_email and sender and sender == sam_email:
                attribution_type = "direct_by_sam"
                attribution_reason = "email_sends.sent_by == sam's account email"
                direct = True
            elif contact_id and contact_id in sam_contact_ids:
                attribution_type = "admin_on_sams_records"
                attribution_reason = (
                    "email_sends.contact_id belongs to a web_form_contacts row "
                    "with franchisee_id == sam's franchisee"
                )
            else:
                # Inferred: recipient email matches an email on one of Sam's clients
                recipients = {_norm_email(x) for x in
                              (row.get("to") or []) + (row.get("cc") or []) + (row.get("bcc") or [])}
                overlap = recipients & client_emails
                if overlap:
                    attribution_type = "inferred_via_client_link"
                    attribution_reason = (
                        f"recipient email(s) {sorted(overlap)} appear on one or more of "
                        "sam's franchisee_clients records; no contact_id relationship"
                    )
                    requires_verify = True
                else:
                    continue  # not relevant to Sam
            correspondence.append({
                "attribution_type": attribution_type,
                "attribution_reason": attribution_reason,
                "actor_email": sender or None,
                "franchisee_id": franchisee_id if attribution_type in ("admin_on_sams_records", "inferred_via_client_link", "direct_by_sam") else None,
                "contact_id": contact_id,
                "client_record_id": None,
                "direct": direct,
                "requires_human_verification": requires_verify or (attribution_type == "inferred_via_client_link"),
                "collection": "email_sends",
                "correspondence_id": row.get("id"),
                "subject": row.get("subject"),
                "sent_at": row.get("sent_at"),
                "to": row.get("to"),
                "last_event": row.get("last_event"),
            })

        # INBOUND MATCHED (email_inbounds)
        in_q = {"received_at": {"$gte": cutoff_iso}}
        async for row in db.email_inbounds.find(in_q, {"_id": 0}).limit(500):
            contact_id = row.get("contact_id")
            attribution_type = None
            attribution_reason = None
            requires_verify = False
            if contact_id and contact_id in sam_contact_ids:
                attribution_type = "inbound_matched_to_sams_contact"
                attribution_reason = (
                    "email_inbounds.contact_id resolves to a web_form_contacts row "
                    "with franchisee_id == sam's franchisee"
                )
            else:
                sender = _norm_email(row.get("from"))
                if sender and sender in client_emails:
                    attribution_type = "inferred_inbound_email_match"
                    attribution_reason = (
                        f"inbound sender {sender} matches an email on one of sam's "
                        "franchisee_clients records"
                    )
                    requires_verify = True
                else:
                    continue
            correspondence.append({
                "attribution_type": attribution_type,
                "attribution_reason": attribution_reason,
                "actor_email": _norm_email(row.get("from")) or None,
                "franchisee_id": franchisee_id,
                "contact_id": contact_id,
                "client_record_id": None,
                "direct": attribution_type == "inbound_matched_to_sams_contact",
                "requires_human_verification": requires_verify or attribution_type == "inferred_inbound_email_match",
                "collection": "email_inbounds",
                "correspondence_id": row.get("id"),
                "subject": row.get("subject"),
                "received_at": row.get("received_at"),
                "from": row.get("from"),
                "match_method": row.get("match_method"),
            })

        # UNMATCHED INBOUND — only include if the structured ``from`` field
        # matches an email on one of Sam's clients. Body-text hits are
        # excluded by design.
        um_q = {"received_at": {"$gte": cutoff_iso}}
        async for row in db.email_inbound_unmatched.find(um_q, {"_id": 0}).limit(500):
            sender = _norm_email(row.get("from"))
            if not sender or sender not in client_emails:
                continue
            correspondence.append({
                "attribution_type": "inferred_inbound_email_match",
                "attribution_reason": (
                    f"unmatched inbound sender {sender} matches an email on one of "
                    "sam's franchisee_clients records; no contact_id relationship"
                ),
                "actor_email": sender,
                "franchisee_id": franchisee_id,
                "contact_id": None,
                "client_record_id": None,
                "direct": False,
                "requires_human_verification": True,
                "collection": "email_inbound_unmatched",
                "correspondence_id": row.get("id"),
                "subject": row.get("subject"),
                "received_at": row.get("received_at"),
                "from": row.get("from"),
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
            "attribution_definitions": {
                "direct_by_sam": "email_sends.sent_by exactly matches Sam's verified account email.",
                "admin_on_sams_records": "outbound email whose contact_id belongs to a web_form_contacts row with franchisee_id == Sam's franchisee — action performed by a different authenticated user.",
                "inferred_via_client_link": "correspondence recipient email matches an email stored on one of Sam's franchisee_clients rows; no contact_id relationship. Requires human verification.",
                "inbound_matched_to_sams_contact": "email_inbounds.contact_id resolves to a contacts/web_form_contacts record directly associated with Sam's franchisee_id.",
                "inferred_inbound_email_match": "inbound sender (structured ``from`` header) matches an email on one of Sam's franchisee_clients rows; no contact_id relationship. Requires human verification.",
            },
            "notes": (
                "Field-level audit rows are NOT available for these collections. "
                "Values shown are the current record contents plus created/updated timestamps only; "
                "do NOT describe them as verified field-level changes. Inferred correspondence "
                "is evidence for investigation ONLY — never present it as a direct action by Sam."
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

        def score(r: dict) -> tuple:
            has_source = 1 if (r.get("source") == "cqc" and r.get("home_id")) else 0
            notes_len = len((r.get("notes") or ""))
            contacts_n = len(r.get("contacts") or [])
            updated = r.get("updated_at") or ""
            return (has_source, contacts_n, notes_len, updated)
        rows_ranked = sorted(rows, key=score, reverse=True)
        survivor = rows_ranked[0]
        archived = rows_ranked[1:]

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
                parts = [s_val] + [v for _, v in non_empty_others]
                combined[key] = {"strategy": "append_with_separator", "parts": [p for p in parts if p]}
                continue
            if key == "contacts":
                combined[key] = {"strategy": "union_by_email_or_phone",
                                 "survivor_count": len(s_val or []),
                                 "additions_from": [rid for rid, _ in non_empty_others]}
                continue
            if s_val in (None, "", [], {}):
                distinct = {v for _, v in non_empty_others if v is not None}
                if len(distinct) == 1:
                    copied[key] = {"from_record_id": non_empty_others[0][0], "value": non_empty_others[0][1]}
                else:
                    conflicts.append({"field": key, "candidates": non_empty_others, "requires_human_decision": True})
                continue
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
                {"collection": HQ_NOTES_COLLECTION, "field": "home_id",
                 "note": ("HQ notes reference source home_id + franchisee_id + source — "
                          "merging clients does not affect them.")},
                {"collection": "email_sends", "field": "contact_id",
                 "note": ("Correspondence is keyed on contact_id (contacts/web_form_contacts). "
                          "franchisee_clients rows have no correspondence FK. Merging clients "
                          "does not automatically reassign correspondence.")},
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
async def _hydrate_client_group(db, members: list[dict], *, rule: str, canonical_source: dict,
                                clients_idx: dict, contacts_idx: dict) -> dict:
    hydrated = []
    for m in members:
        source_resolves_to = None
        if m.get("home_id") and m.get("source") == "cqc":
            found = await db.cqc_locations.find_one(
                {"location_id": m["home_id"]},
                {"_id": 0, "location_id": 1, "name": 1, "address": 1, "postcode": 1},
            )
            source_resolves_to = found or {"status": "orphaned — home_id no longer matches any cqc_locations row"}
        note_query = {"franchisee_id": m.get("franchisee_id"), "source": m.get("source"), "home_id": m.get("home_id")}
        hq_notes_full: list[dict] = []
        async for h in db[HQ_NOTES_COLLECTION].find(note_query, {"_id": 0}).sort([("updated_at", -1)]):
            hq_notes_full.append(_hq_note_view(h))
        correspondence_block = await _correspondence_for_client(
            db, m, all_clients_by_email=clients_idx, all_contacts_by_email=contacts_idx,
        )
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
            "hq_notes": hq_notes_full,
            "hq_note_entry_ids": [n["entry_id"] for n in hq_notes_full],
            "hq_note_identity_key": {
                "tuple": ["franchisee_id", "source", "home_id"],
                "values": [m.get("franchisee_id"), m.get("source"), m.get("home_id")],
                "note": "HQ notes are keyed by this tuple in the hq_home_notes collection — NOT client_record_id.",
            },
            "correspondence_linkage": correspondence_block,
            "bookings": [],
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
