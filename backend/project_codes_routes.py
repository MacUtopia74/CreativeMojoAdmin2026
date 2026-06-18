"""Project Codes — the central link between WooCommerce products and
Cloudflare R2 project assets stored in our ``files_index`` collection.

Design (per product brief, locked 16 Jun 2026):
  • **Storage**: Hub-primary. ``project_code`` lives on the Mongo
    documents (``woo_products`` + ``files_index``). R2 metadata is NOT
    used as the primary store — would require enumerating the bucket
    on every lookup. R2-side stamping can be layered later without
    schema changes.
  • **WooCommerce side**: Hub-only. We don't push the code into Woo;
    the admin assigns codes inside this app, keyed by Woo product ID.
  • **Multiple assets per code**: Every ``files_index`` doc can carry
    ``project_code`` + ``asset_type`` ∈ {instruction_pdf, svg_cutting,
    stencil, video, image, other}. One code → many files of different
    types. The portal calendar modal defaults to ``instruction_pdf``
    for the "Open Project Guide" button; a future Project Library can
    surface every asset.
  • **Suggestion engine**: rapidfuzz token_set_ratio across Woo
    product names and file basenames (extension stripped). Returns
    ranked suggestions with confidence 0–100. The admin approves one
    at a time or bulk-approves anything ≥ threshold.

Endpoints (all admin-scoped except the portal one):
  • GET    /admin/project-codes                — unified Woo + file view
  • PUT    /admin/project-codes/woo/{woo_id}   — set/clear product code
  • PUT    /admin/project-codes/file/{key}     — set/clear file code + asset_type
  • GET    /admin/project-codes/suggestions    — auto-match suggestions
  • POST   /admin/project-codes/suggestions/approve  — single approve
  • POST   /admin/project-codes/suggestions/approve-bulk — bulk approve
  • POST   /admin/project-codes/suggestions/skip — dismiss a suggestion
  • GET    /portal/calendar/projects?month=&year=  — month-filtered list
                                                     for the Calendar modal
"""
from __future__ import annotations

import logging
import re
import unicodedata
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import quote_plus

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from rapidfuzz import fuzz

logger = logging.getLogger("creative-mojo-admin.project_codes")

ASSET_TYPES = (
    "instruction_pdf", "svg_cutting", "stencil",
    "video", "image", "other",
)
DEFAULT_ASSET_TYPE = "instruction_pdf"

# Filename extensions → default asset_type guess. Used when the admin
# hasn't set one yet and we need to pre-fill the dropdown.
EXT_DEFAULT_ASSET = {
    ".pdf": "instruction_pdf",
    ".svg": "svg_cutting",
    ".dxf": "svg_cutting",
    ".mp4": "video", ".mov": "video", ".m4v": "video", ".webm": "video",
    ".jpg": "image", ".jpeg": "image", ".png": "image",
    ".webp": "image", ".heic": "image", ".heif": "image",
}

# Standard tag for products that should appear in the calendar modal
# (per spec: "Standard Boxed Art Kits"). Stored slugified for the
# Mongo filter — rapidfuzz on the slug ignores capitalisation/spaces.
ART_KIT_TAG_SLUG = "standard-boxed-art-kits"

# File-vault path fragment that bounds the "project-guide" universe.
# Anything outside this folder (per-franchisee documents under
# ``franchisees/…/My own franchise documents``, admin scratch, .trash
# etc.) is NOT a candidate for Project Code matching — the spec is
# strict about this so franchisees never see a private file by
# accident, and the suggestion engine isn't dragged down by 500+
# irrelevant docs.
PROJECT_FILES_KEY_FRAGMENT = "All Projects & Templates (Guides & Files)"


def _exclude_terms_filter(raw: Optional[str]) -> Optional[dict]:
    """Turn ``"Stencil, SVG"`` into a Mongo ``$nor`` clause that drops
    any file whose ``name`` contains *any* of those terms (case-i).

    Returns ``None`` when the input is empty so callers can short-circuit.
    """
    if not raw:
        return None
    terms = [t.strip() for t in str(raw).split(",") if t.strip()]
    if not terms:
        return None
    return {
        "$nor": [
            {"name": {"$regex": re.escape(t), "$options": "i"}}
            for t in terms
        ],
    }


def _project_files_query(exclude_terms: Optional[str] = None) -> dict:
    """Mongo filter that restricts ``files_index`` to project-guide
    territory, optionally further excluding any name containing the
    comma-separated terms in ``exclude_terms`` (e.g. "Stencil")."""
    f: dict = {"key": {"$regex": re.escape(PROJECT_FILES_KEY_FRAGMENT)}}
    extra = _exclude_terms_filter(exclude_terms)
    if extra:
        f.update(extra)
    return f


async def _purge_out_of_scope_codes(db) -> int:
    """One-shot cleanup: clear ``project_code`` / ``asset_type`` from
    any file outside the project-guide folder. Runs idempotently from
    the admin page's first load so legacy mistakes auto-heal.
    """
    res = await db.files_index.update_many(
        {
            "project_code": {"$ne": None},
            "key": {"$not": {"$regex": re.escape(PROJECT_FILES_KEY_FRAGMENT)}},
        },
        {"$set": {"project_code": None, "asset_type": None}},
    )
    return res.modified_count


# Month names ↔ index — used when matching Woo categories like "May"
# / "June" to either the visible calendar month (portal) or the
# admin's month dropdown.
MONTH_NAMES_LOWER = (
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december",
)

# ---------------------------------------------------------------- helpers


def slugify_project_code(raw: str) -> str:
    """Turn a free-text name into a stable Project Code.

    ``"Forget Me Not Tea Set"`` → ``"FORGET_ME_NOT_TEA_SET"``.

    Aggressive on punctuation so accidental punctuation drift between
    the Woo product name and file name still yields the same code.
    HTML tags (``<br>``, ``</p>``, …) are stripped before slugifying so
    storefront editor markup doesn't bleed into the generated codes.
    """
    if not raw:
        return ""
    s = str(raw)
    # Drop HTML tags + common entities — storefront editor sometimes
    # ships raw markup in the product title which would otherwise
    # become "BR" / "P" tokens in the slug.
    s = re.sub(r"<[^>]+>", " ", s)
    s = (s.replace("&nbsp;", " ")
           .replace("&amp;", "&")
           .replace("&lt;", "<")
           .replace("&gt;", ">")
           .replace("&quot;", '"')
           .replace("&#39;", "'"))
    # Strip accents → ASCII so "café" and "cafe" match.
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.upper()
    s = re.sub(r"[^A-Z0-9]+", "_", s).strip("_")
    return s


def _strip_extension(name: str) -> str:
    return re.sub(r"\.[A-Za-z0-9]{1,5}$", "", name or "")


def _guess_asset_type(filename: str) -> str:
    m = re.search(r"\.[A-Za-z0-9]{1,5}$", filename or "")
    if not m:
        return DEFAULT_ASSET_TYPE
    return EXT_DEFAULT_ASSET.get(m.group(0).lower(), "other")


def _match_score(product_name: str, file_basename: str) -> int:
    """Confidence 0–100. Uses token_set_ratio so word-order and stray
    punctuation don't tank the score — "Forget Me Not Tea Set" and
    "Forget Me Not - Tea Set" still match ~95+."""
    a = (product_name or "").strip().lower()
    b = _strip_extension(file_basename or "").strip().lower()
    if not a or not b:
        return 0
    return int(fuzz.token_set_ratio(a, b))


# ---------------------------------------------------------------- models


class ProductCodeBody(BaseModel):
    project_code: Optional[str] = Field(
        default=None,
        description="Set to empty/null to clear. Slugified server-side.",
    )


class FileCodeBody(BaseModel):
    project_code: Optional[str] = Field(default=None)
    asset_type: Optional[str] = Field(default=None)


class ApproveBody(BaseModel):
    woo_id: str
    file_key: str
    project_code: Optional[str] = None  # if None, generate from product name
    asset_type: Optional[str] = None    # if None, guess from extension


class BulkApproveBody(BaseModel):
    # Server-side floor of 90 ensures bulk approval can never be set
    # to a careless threshold (e.g. 50%) and silently wreck the
    # mapping. The admin UI also surfaces a review-before-confirm
    # modal so the human eyes every link before it lands.
    min_score: int = Field(default=95, ge=90, le=100)
    limit: int = Field(default=100, ge=1, le=500)


class SkipBody(BaseModel):
    woo_id: str
    file_key: str


# ---------------------------------------------------------------- router
def build_project_codes_router(db, require_role) -> APIRouter:
    router = APIRouter()

    async def _ensure_indexes():
        await db.woo_products.create_index("project_code")
        await db.files_index.create_index("project_code")
        await db.files_index.create_index([("project_code", 1), ("asset_type", 1)])
        await db.project_code_skips.create_index([("woo_id", 1), ("file_key", 1)], unique=True)

    @router.get("/admin/project-codes")
    async def list_project_codes(
        q: Optional[str] = Query(None, description="Fuzzy filter on names"),
        status: str = Query("all", description="all|matched|woo_only|file_only"),
        month: Optional[int] = Query(
            None, ge=1, le=12,
            description="If set, only Woo products whose category matches this month",
        ),
        exclude_files: Optional[str] = Query(
            None,
            description=(
                "Comma-separated terms (e.g. 'Stencil'). Files whose name "
                "contains any of these are hidden — defaults set client-side."
            ),
        ),
        _user: dict = Depends(require_role("admin")),
    ):
        """Single unified view: every Woo top-level product (no
        variations) and every IN-SCOPE file from the project-guide
        folder (``All Projects & Templates (Guides & Files)`` only —
        franchisee-private files are excluded by design).

        ``status`` filter helps the admin focus on the work that's
        left — ``woo_only`` lists Woo products that don't yet have a
        matching file; ``file_only`` lists orphaned files.

        ``month`` (1–12) narrows the Woo side to a single calendar
        month based on the product's WooCommerce category — drives
        the admin's month dropdown so the user can hand-link a single
        month's batch at a time.
        """
        await _ensure_indexes()
        # Self-heal any out-of-scope file codes on every load. Cheap
        # update_many that no-ops once clean.
        await _purge_out_of_scope_codes(db)

        # Project-side: ignore variations (they share parent's code).
        woo_match: dict = {"is_variation": {"$ne": True}}
        if q:
            woo_match["name"] = {"$regex": re.escape(q), "$options": "i"}
        if month:
            mname = MONTH_NAMES_LOWER[month - 1]
            woo_match["$or"] = [
                {"category_slugs": mname},
                {"category_names": {"$regex": f"^{mname}$", "$options": "i"}},
            ]
        woo_cur = db.woo_products.find(
            woo_match,
            {
                "_id": 0, "id": 1, "woo_id": 1, "name": 1, "sku": 1,
                "image_url": 1, "project_code": 1,
                "tag_names": 1, "tag_slugs": 1,
                "category_names": 1, "category_slugs": 1,
            },
        ).sort("name", 1)
        woo_products = await woo_cur.to_list(5000)

        file_match: dict = dict(_project_files_query(exclude_files))
        if q:
            file_match["name"] = {"$regex": re.escape(q), "$options": "i"}
        file_cur = db.files_index.find(
            file_match,
            {
                "_id": 0, "id": 1, "key": 1, "name": 1, "content_type": 1,
                "size": 1, "project_code": 1, "asset_type": 1,
            },
        ).sort("name", 1)
        files = await file_cur.to_list(5000)

        # Build code → file list lookup once so the join is O(1).
        files_by_code: dict[str, list[dict]] = {}
        for f in files:
            code = f.get("project_code")
            if code:
                files_by_code.setdefault(code, []).append(f)

        matched_codes = {p.get("project_code") for p in woo_products if p.get("project_code")}
        matched_codes.discard(None)
        matched_codes.discard("")

        # Apply status filter
        out_woo = []
        for p in woo_products:
            code = p.get("project_code")
            has_file = bool(code and files_by_code.get(code))
            row = {
                **p,
                "has_code": bool(code),
                "linked_files": files_by_code.get(code, []) if code else [],
                "has_linked_file": has_file,
            }
            if status == "matched" and not has_file:
                continue
            if status == "woo_only" and has_file:
                continue
            if status == "file_only":
                continue
            out_woo.append(row)

        out_files = []
        for f in files:
            code = f.get("project_code")
            in_matched = bool(code and code in matched_codes)
            row = {
                **f,
                "has_code": bool(code),
                "linked_to_woo": in_matched,
            }
            if status == "matched" and not in_matched:
                continue
            if status == "file_only" and in_matched:
                continue
            if status == "woo_only":
                continue
            out_files.append(row)

        # Counters power the admin status pills at the top of the page.
        counts = {
            "woo_total": len(woo_products),
            "woo_with_code": sum(1 for p in woo_products if p.get("project_code")),
            "woo_matched_to_file": sum(
                1 for p in woo_products
                if p.get("project_code") and files_by_code.get(p.get("project_code"))
            ),
            "files_total": len(files),
            "files_with_code": sum(1 for f in files if f.get("project_code")),
        }
        return {"products": out_woo, "files": out_files, "counts": counts}

    @router.put("/admin/project-codes/woo/{woo_id}")
    async def set_product_code(
        woo_id: str,
        body: ProductCodeBody,
        user: dict = Depends(require_role("admin")),
    ):
        existing = await db.woo_products.find_one(
            {"id": woo_id}, {"_id": 0, "id": 1, "name": 1},
        )
        if not existing:
            raise HTTPException(404, "Woo product not found")
        new_code = slugify_project_code(body.project_code or "") or None
        await db.woo_products.update_one(
            {"id": woo_id},
            {"$set": {
                "project_code": new_code,
                "project_code_updated_at": datetime.now(timezone.utc).isoformat(),
                "project_code_updated_by": user.get("email"),
            }},
        )
        return {"ok": True, "project_code": new_code}

    @router.put("/admin/project-codes/file/{file_key:path}")
    async def set_file_code(
        file_key: str,
        body: FileCodeBody,
        user: dict = Depends(require_role("admin")),
    ):
        existing = await db.files_index.find_one(
            {"key": file_key}, {"_id": 0, "key": 1, "name": 1},
        )
        if not existing:
            raise HTTPException(404, "File not found")
        new_code = slugify_project_code(body.project_code or "") or None
        asset_type = body.asset_type
        if asset_type and asset_type not in ASSET_TYPES:
            raise HTTPException(400, f"asset_type must be one of {ASSET_TYPES}")
        if new_code and not asset_type:
            asset_type = _guess_asset_type(existing.get("name") or "")
        await db.files_index.update_one(
            {"key": file_key},
            {"$set": {
                "project_code": new_code,
                "asset_type": asset_type if new_code else None,
                "project_code_updated_at": datetime.now(timezone.utc).isoformat(),
                "project_code_updated_by": user.get("email"),
            }},
        )
        return {"ok": True, "project_code": new_code, "asset_type": asset_type if new_code else None}

    # ---- Suggestion engine ----------------------------------------

    async def _build_suggestions(
        min_score: int,
        limit: int,
        exclude_files: Optional[str] = None,
    ) -> list[dict]:
        """Return ranked product↔file suggestions whose fuzzy score
        meets ``min_score``. Skipped pairs, pairs already linked
        through the same Project Code, and files whose name matches
        any ``exclude_files`` term are filtered out.
        """
        # Pull lightweight projections — we only need name + key/ID.
        woo = await db.woo_products.find(
            {"is_variation": {"$ne": True}},
            {"_id": 0, "id": 1, "name": 1, "image_url": 1, "project_code": 1},
        ).to_list(5000)
        files = await db.files_index.find(
            _project_files_query(exclude_files),
            {"_id": 0, "key": 1, "name": 1, "project_code": 1, "asset_type": 1, "content_type": 1},
        ).to_list(10000)

        # Build "skip" lookup so dismissed suggestions don't reappear.
        skipped = set()
        async for s in db.project_code_skips.find({}, {"_id": 0, "woo_id": 1, "file_key": 1}):
            skipped.add((s["woo_id"], s["file_key"]))

        out: list[dict] = []
        for p in woo:
            # If product already has a code AND a file is already
            # linked, don't suggest more — admin already curated it.
            if p.get("project_code") and any(
                f.get("project_code") == p.get("project_code") for f in files
            ):
                continue
            best: list[dict] = []
            for f in files:
                # Don't suggest pairs where the file is already linked
                # to a *different* product code — would create a
                # conflict on approval.
                if f.get("project_code") and f.get("project_code") != p.get("project_code"):
                    continue
                if (p["id"], f["key"]) in skipped:
                    continue
                # Skip JPG/JPEG files — per spec, raw photos are never
                # the right "project guide" companion to a Woo product
                # so they only add noise to the suggestion list. Admin
                # can still link them manually via the Files tab if
                # ever needed.
                fname = (f.get("name") or "").lower()
                if fname.endswith(".jpg") or fname.endswith(".jpeg"):
                    continue
                score = _match_score(p.get("name", ""), f.get("name", ""))
                if score < min_score:
                    continue
                best.append({
                    "file_key": f["key"],
                    "file_name": f.get("name"),
                    "score": score,
                    "asset_type_guess": _guess_asset_type(f.get("name") or ""),
                })
            if not best:
                continue
            best.sort(key=lambda x: -x["score"])
            out.append({
                "woo_id": p["id"],
                "product_name": p.get("name"),
                "product_image": p.get("image_url"),
                "suggested_code": slugify_project_code(p.get("name", "")),
                "current_code": p.get("project_code"),
                "matches": best[:5],  # top 5 candidates per product
                "best_score": best[0]["score"],
            })
        out.sort(key=lambda x: -x["best_score"])
        return out[:limit]

    @router.get("/admin/project-codes/suggestions")
    async def get_suggestions(
        min_score: int = Query(80, ge=50, le=100),
        limit: int = Query(200, ge=1, le=1000),
        exclude_files: Optional[str] = Query(
            None,
            description="Comma-separated terms — files whose name contains any are skipped",
        ),
        _user: dict = Depends(require_role("admin")),
    ):
        await _ensure_indexes()
        items = await _build_suggestions(min_score, limit, exclude_files)
        return {"items": items, "count": len(items), "min_score": min_score}

    @router.post("/admin/project-codes/suggestions/approve")
    async def approve_suggestion(
        body: ApproveBody = Body(...),
        user: dict = Depends(require_role("admin")),
    ):
        prod = await db.woo_products.find_one(
            {"id": body.woo_id}, {"_id": 0, "id": 1, "name": 1, "project_code": 1},
        )
        if not prod:
            raise HTTPException(404, "Woo product not found")
        f = await db.files_index.find_one(
            {"key": body.file_key}, {"_id": 0, "key": 1, "name": 1, "project_code": 1},
        )
        if not f:
            raise HTTPException(404, "File not found")
        code = slugify_project_code(
            body.project_code
            or prod.get("project_code")
            or prod.get("name")
            or "",
        )
        if not code:
            raise HTTPException(400, "Could not derive a Project Code")
        asset_type = body.asset_type or _guess_asset_type(f.get("name") or "")
        if asset_type not in ASSET_TYPES:
            asset_type = DEFAULT_ASSET_TYPE
        now = datetime.now(timezone.utc).isoformat()
        await db.woo_products.update_one(
            {"id": body.woo_id},
            {"$set": {
                "project_code": code,
                "project_code_updated_at": now,
                "project_code_updated_by": user.get("email"),
            }},
        )
        await db.files_index.update_one(
            {"key": body.file_key},
            {"$set": {
                "project_code": code,
                "asset_type": asset_type,
                "project_code_updated_at": now,
                "project_code_updated_by": user.get("email"),
            }},
        )
        return {"ok": True, "project_code": code, "asset_type": asset_type}

    @router.post("/admin/project-codes/suggestions/approve-bulk")
    async def approve_bulk(
        body: BulkApproveBody = Body(...),
        user: dict = Depends(require_role("admin")),
    ):
        suggestions = await _build_suggestions(body.min_score, body.limit)
        now = datetime.now(timezone.utc).isoformat()
        approved = 0
        for s in suggestions:
            top = s["matches"][0]
            code = slugify_project_code(s.get("product_name") or "")
            if not code:
                continue
            asset_type = top.get("asset_type_guess") or DEFAULT_ASSET_TYPE
            await db.woo_products.update_one(
                {"id": s["woo_id"]},
                {"$set": {
                    "project_code": code,
                    "project_code_updated_at": now,
                    "project_code_updated_by": user.get("email"),
                }},
            )
            await db.files_index.update_one(
                {"key": top["file_key"]},
                {"$set": {
                    "project_code": code,
                    "asset_type": asset_type,
                    "project_code_updated_at": now,
                    "project_code_updated_by": user.get("email"),
                }},
            )
            approved += 1
        return {"ok": True, "approved": approved, "considered": len(suggestions)}

    @router.post("/admin/project-codes/suggestions/skip")
    async def skip_suggestion(
        body: SkipBody = Body(...),
        user: dict = Depends(require_role("admin")),
    ):
        await db.project_code_skips.update_one(
            {"woo_id": body.woo_id, "file_key": body.file_key},
            {"$set": {
                "skipped_at": datetime.now(timezone.utc).isoformat(),
                "skipped_by": user.get("email"),
            }},
            upsert=True,
        )
        return {"ok": True}

    @router.get("/admin/project-codes/suggestions/skipped")
    async def list_skips(_user: dict = Depends(require_role("admin"))):
        """Surface the skip queue so the admin can see how many
        suggestions they previously dismissed before deciding whether
        to reset.
        """
        cur = db.project_code_skips.find({}, {"_id": 0}).sort("skipped_at", -1)
        items = await cur.to_list(2000)
        return {"count": len(items), "items": items}

    @router.post("/admin/project-codes/suggestions/reset-skips")
    async def reset_skips(_user: dict = Depends(require_role("admin"))):
        """Clear the skip queue so previously-dismissed suggestions
        re-surface on the next ``/suggestions`` call. Used after a fresh
        WooCommerce or R2 sync when filename changes might make a
        previously-rejected pair worth reconsidering.
        """
        res = await db.project_code_skips.delete_many({})
        return {"ok": True, "cleared": res.deleted_count}

    # ---- Manual Woo refresh trigger (the admin "Sync from Woo" button)
    # already exists in the existing Woo integration router; we don't
    # duplicate it here.

    # ---- Portal calendar feed ------------------------------------

    @router.get("/portal/calendar/projects")
    async def portal_projects(
        month: int = Query(..., ge=1, le=12),
        year: int = Query(..., ge=2000, le=2100),
        user: dict = Depends(require_role("franchisee", "admin")),
    ):
        """Projects available for the calendar modal.

        Filters Woo products to the "Standard Boxed Art Kits" tag
        AND a category matching the requested month name. Joins each
        product to its linked ``instruction_pdf`` file (if any) so the
        modal can render an immediate "Open Project Guide" link or
        a "Coming soon" fallback.

        ``guide_url`` is intentionally returned as a relative path
        (``/files/download?key=…``); the React ``api`` client prepends
        the API host + bearer token. Keeping it relative means we
        never leak the host into client-stored state. The frontend
        GETs the path and opens the returned ``{url}`` in a new tab.
        """
        month_name_lower = MONTH_NAMES_LOWER[month - 1]
        # Slug version: "may" / "june" — Woo stores categories slugged
        # lowercase so we match either name or slug.
        month_slug = month_name_lower
        # NB: year is currently advisory (Woo categories are usually
        # "May" not "May 2026"). We accept it for future-proofing —
        # if you later add per-year categories, the filter can extend.
        prods = await db.woo_products.find(
            {
                "is_variation": {"$ne": True},
                "$and": [
                    {"$or": [
                        {"tag_slugs": ART_KIT_TAG_SLUG},
                        {"tag_names": {"$regex": "Standard Boxed Art Kits", "$options": "i"}},
                    ]},
                    {"$or": [
                        {"category_slugs": month_slug},
                        {"category_names": {"$regex": f"^{month_name_lower}$", "$options": "i"}},
                    ]},
                ],
            },
            {
                "_id": 0, "id": 1, "woo_id": 1, "name": 1,
                "image_url": 1, "permalink": 1, "project_code": 1,
                "category_names": 1, "tag_names": 1,
            },
        ).sort("name", 1).to_list(500)

        # Resolve instruction_pdf for each project_code in one round-trip.
        codes = [p["project_code"] for p in prods if p.get("project_code")]
        files: dict[str, dict] = {}
        if codes:
            cur = db.files_index.find(
                {
                    **_project_files_query(),
                    "project_code": {"$in": codes},
                    "asset_type": "instruction_pdf",
                },
                {"_id": 0, "key": 1, "name": 1, "project_code": 1, "size": 1},
            )
            for f in await cur.to_list(2000):
                # Keep first match per code (admin can change which file
                # is the canonical instruction PDF by re-tagging).
                code = f.get("project_code")
                if code and code not in files:
                    files[code] = f

        items = []
        for p in prods:
            code = p.get("project_code")
            f = files.get(code) if code else None
            items.append({
                "id": p["id"],
                "woo_id": p.get("woo_id"),
                "name": p.get("name"),
                "image_url": p.get("image_url"),
                "permalink": p.get("permalink"),
                "project_code": code,
                "has_guide": bool(f),
                # The file download URL is the existing files-router
                # signed-URL pattern — keeping it relative so the
                # frontend's ``api`` client adds the host/auth.
                "guide_url": (
                    f"/files/download?key={quote_plus(f['key'])}"
                    if f else None
                ),
                "guide_key": f.get("key") if f else None,
                "guide_filename": f.get("name") if f else None,
            })
        return {"month": month, "year": year, "items": items, "count": len(items)}

    @router.get("/portal/projects/{project_code}/files")
    async def portal_project_files(
        project_code: str,
        guide_key: str = "",
        user: dict = Depends(require_role("franchisee", "admin")),
    ):
        """List every file that lives in the same R2 folder as the
        project guide PDF. The franchisee asked for "show the folder",
        not "show files tagged with this project_code" — so we derive
        the folder prefix from ``guide_key`` and list its contents.

        Falls back to the project_code filter when no guide_key is
        supplied (for older calendar entries that haven't been re-fetched
        yet). Either way the franchisee is still confined to files in
        the project-guide tree via the ``PROJECT_FILES_KEY_FRAGMENT``
        check below — they can't peek into arbitrary R2 folders.
        """
        if not project_code or not project_code.strip():
            raise HTTPException(400, "project_code required")

        if guide_key and PROJECT_FILES_KEY_FRAGMENT in guide_key:
            # Folder = everything up to the last "/" in the guide key.
            # Add a trailing "/" so a prefix like "foo/bar" doesn't match
            # "foo/barbecue".
            folder = guide_key.rsplit("/", 1)[0] + "/"
            query: dict = {"key": {"$regex": f"^{re.escape(folder)}"}}
        else:
            # Legacy fallback — keep the project_code-based filter so the
            # endpoint stays useful for items that don't have a guide
            # uploaded yet, or where the caller didn't pass guide_key.
            query = {
                **_project_files_query(),
                "project_code": project_code.strip(),
            }

        cur = db.files_index.find(
            query,
            {"_id": 0, "key": 1, "name": 1, "size": 1, "asset_type": 1,
             "modified": 1, "content_type": 1},
        ).sort("name", 1)
        files = await cur.to_list(2000)
        out: list[dict] = []
        for f in files:
            out.append({
                "key": f.get("key"),
                "name": f.get("name") or "",
                "size": f.get("size"),
                "asset_type": f.get("asset_type") or "other",
                "content_type": f.get("content_type"),
                "modified": f.get("modified"),
                "download_url": f"/files/download?key={quote_plus(f['key'])}",
            })
        return {"project_code": project_code, "files": out, "count": len(out)}

    return router
