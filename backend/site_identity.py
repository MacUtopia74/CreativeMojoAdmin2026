"""Pure, side-effect-free helpers for the duplicate-diagnostics
endpoints. NONE of these functions read from or write to Mongo.

Concepts (as agreed with the user, Feb 2026):
  * ``cqc_location_id``   — one individual CQC registration
  * ``canonical_site_id`` — one physical home/site, potentially
                            containing >1 ``cqc_location_id``
  * ``client_record_id``  — one franchisee-owned My Client CRM row
  * ``source_cqc_location_id`` — the CQC registration a client was
                            originally created from (if any)

``canonical_site_id`` is DIAGNOSTIC-ONLY at this stage. It is derived
on the fly from the underlying evidence (name + full address +
postcode + coords + provider_id + service overlap) and returned as
part of the diagnostic response. It is never persisted. Ambiguous
sites stay ungrouped and are flagged for human review.
"""
from __future__ import annotations

import hashlib
import logging
import math
import os
import re
import subprocess
from typing import Any, Iterable, Optional


DIAGNOSTIC_VERSION = "phase-a+c-2026-08-04"

_logger = logging.getLogger("creative-mojo-admin.site_identity")


def _resolve_build_commit() -> str:
    """Resolve the current build commit hash for diagnostic responses.

    Resolution order (safe fallbacks — must never break app startup):
      1. Explicit deployment env vars: ``BUILD_COMMIT``, ``COMMIT_SHA``,
         ``GIT_COMMIT``, ``RENDER_GIT_COMMIT``, ``VERCEL_GIT_COMMIT_SHA``
      2. Guarded ``git rev-parse HEAD`` with a 2-second timeout,
         suppressing every possible failure (missing .git, missing git
         binary, non-zero exit, timeout)
      3. Literal ``"unknown"`` — the app remains fully functional and
         the diagnostic response is honest about the gap.
    """
    for env_key in ("BUILD_COMMIT", "COMMIT_SHA", "GIT_COMMIT",
                    "RENDER_GIT_COMMIT", "VERCEL_GIT_COMMIT_SHA"):
        val = os.environ.get(env_key)
        if val:
            return val.strip()[:40]
    try:
        out = subprocess.check_output(
            ["git", "rev-parse", "HEAD"],
            cwd=os.path.dirname(os.path.abspath(__file__)),
            stderr=subprocess.DEVNULL,
            timeout=2,
        )
        return out.decode("utf-8", "replace").strip()[:40] or "unknown"
    except Exception:  # noqa: BLE001 — any failure → "unknown"
        return "unknown"


# Resolve once at import; never re-runs on request.
try:
    BUILD_COMMIT = _resolve_build_commit()
except Exception:  # noqa: BLE001 — belt & braces so a resolver bug can't crash startup
    _logger.exception("build_commit resolver crashed — falling back to 'unknown'")
    BUILD_COMMIT = "unknown"


def _norm(value: Any) -> str:
    """Lowercase, strip punctuation and collapse whitespace. Used for
    fuzzy comparison — the raw values remain available for display."""
    if value is None:
        return ""
    s = re.sub(r"[^\w\s]", " ", str(value).lower())
    return re.sub(r"\s+", " ", s).strip()


def normalise_postcode(pc: Any) -> str:
    """UK postcode → uppercase, single space between outward and
    inward halves. Any input that isn't recognisable is returned
    upper-cased with whitespace collapsed."""
    if not pc:
        return ""
    raw = re.sub(r"\s+", "", str(pc).upper())
    m = re.fullmatch(r"([A-Z]{1,2}\d[A-Z\d]?)(\d[A-Z]{2})", raw)
    return f"{m.group(1)} {m.group(2)}" if m else raw


def normalise_name(name: Any) -> str:
    """Drop trading suffixes and common site prefixes for comparison."""
    n = _norm(name)
    n = re.sub(r"\b(ltd|limited|plc|the)\b", "", n)
    return re.sub(r"\s+", " ", n).strip()


def normalise_address(address: Any) -> str:
    """Compare-safe address string (line-break agnostic, punctuation
    stripped). The un-normalised value stays available for display."""
    return _norm(address)


def haversine_metres(a: tuple[float, float] | None, b: tuple[float, float] | None) -> Optional[float]:
    if not a or not b:
        return None
    lat1, lon1 = a; lat2, lon2 = b
    if None in (lat1, lon1, lat2, lon2):
        return None
    R = 6_371_000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1); dl = math.radians(lon2 - lon1)
    h = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return 2 * R * math.asin(min(1.0, math.sqrt(h)))


def _coords(rec: dict) -> Optional[tuple[float, float]]:
    lat, lng = rec.get("lat") or rec.get("latitude"), rec.get("lng") or rec.get("longitude")
    if isinstance(lat, (int, float)) and isinstance(lng, (int, float)):
        return (float(lat), float(lng))
    return None


def evidence_between(a: dict, b: dict) -> dict:
    """Detailed match evidence between two records (either CQC
    locations or My Client rows). Returns per-factor booleans plus a
    weighted composite score in ``[0, 1]``.
    """
    pc_a, pc_b = normalise_postcode(a.get("postcode")), normalise_postcode(b.get("postcode"))
    name_a, name_b = normalise_name(a.get("name")), normalise_name(b.get("name"))
    addr_a, addr_b = normalise_address(a.get("address")), normalise_address(b.get("address"))
    dist = haversine_metres(_coords(a), _coords(b))
    prov_a, prov_b = a.get("provider_id") or a.get("provider"), b.get("provider_id") or b.get("provider")

    postcode_match = bool(pc_a) and pc_a == pc_b
    name_match = bool(name_a) and name_a == name_b
    name_similar = bool(name_a) and (name_a in name_b or name_b in name_a)
    address_match = bool(addr_a) and addr_a == addr_b
    address_similar = bool(addr_a) and (addr_a[:40] == addr_b[:40])
    coords_close = dist is not None and dist <= 40.0  # within 40 m
    provider_match = bool(prov_a) and prov_a == prov_b

    # Weighted score. Postcode alone is not enough (many care homes on
    # one postcode). Address + name is the strongest signal.
    weights = {
        "postcode": 0.15,
        "name_exact": 0.30,
        "name_similar": 0.10,
        "address_exact": 0.30,
        "address_similar": 0.10,
        "coords_close": 0.10,
        "provider_match": 0.05,
    }
    score = 0.0
    if postcode_match: score += weights["postcode"]
    if name_match: score += weights["name_exact"]
    elif name_similar: score += weights["name_similar"]
    if address_match: score += weights["address_exact"]
    elif address_similar: score += weights["address_similar"]
    if coords_close: score += weights["coords_close"]
    if provider_match: score += weights["provider_match"]

    if score >= 0.75:
        confidence = "high"
    elif score >= 0.45:
        confidence = "medium"
    elif score > 0.0:
        confidence = "low"
    else:
        confidence = "none"

    return {
        "score": round(score, 3),
        "confidence": confidence,
        "postcode_match": postcode_match,
        "name_match": name_match,
        "name_similar": name_similar and not name_match,
        "address_match": address_match,
        "address_similar": address_similar and not address_match,
        "coords_close": coords_close,
        "coords_distance_metres": None if dist is None else round(dist, 1),
        "provider_match": provider_match,
        "normalised": {
            "name_a": name_a, "name_b": name_b,
            "address_a": addr_a, "address_b": addr_b,
            "postcode_a": pc_a, "postcode_b": pc_b,
        },
    }


def derived_site_key(*, name: Any, address: Any, postcode: Any) -> str:
    """Stable, deterministic diagnostic-only site key. NOT persisted.
    Two records producing the same key are proposed as belonging to
    the same physical site, PENDING human confirmation.
    """
    seed = "|".join([normalise_name(name), normalise_address(address), normalise_postcode(postcode)])
    return "sitehash-" + hashlib.sha1(seed.encode()).hexdigest()[:16]
