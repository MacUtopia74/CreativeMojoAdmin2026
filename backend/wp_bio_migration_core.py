"""Pure-logic core for the WordPress → website_bio backfill.

Shared by:
  * `scripts/wp_bio_backfill.py` (CLI, developer use)
  * `wp_bio_migration_routes.py` (admin-only API endpoint, production use)

`build_plan(db, rows)` returns a deterministic "what would we do"
description: which franchisees would be inserted / overwritten /
preserved / skipped, based on the current live-DB state and the parsed
WordPress CSV rows. It does NOT write. Both the dry-run endpoint and
the apply endpoint call this and the apply endpoint then executes the
plan step-by-step.
"""
from __future__ import annotations

import html
import re
from typing import Any

from bs4 import BeautifulSoup

SCRIPT_VERSION = "wp_bio_backfill_2026_07_29_v1"
MIN_CHARS = 60
APPROVED_OVERWRITE_FRANCHISE_NUMBERS: set[str] = {"0030"}   # Anita Priest
HOLD_BACK_FRANCHISE_NUMBERS: set[str] = {"0006"}            # Helen Lyons
PLACEHOLDER_SNIPPETS = (
    "biography here to come",
    "coming soon",
    "bio to come",
    "biography to come",
)


# ---------- helpers ----------------------------------------------------------
def normalise_email(v: Any) -> str:
    return (str(v) if v is not None else "").strip().lower()


def _dedup_key(text: str) -> str:
    """Typographic-normalise so two WP pages differing only in smart
    quotes / dashes / NBSPs count as duplicates."""
    s = text or ""
    for a, b in (("\u2018", "'"), ("\u2019", "'"), ("\u201c", '"'),
                 ("\u201d", '"'), ("\u2013", "-"), ("\u2014", "-"),
                 ("\u00a0", " ")):
        s = s.replace(a, b)
    return " ".join(s.lower().split())


def is_placeholder(text: str) -> bool:
    t = (text or "").strip().lower()
    return any(p in t for p in PLACEHOLDER_SNIPPETS)


def wp_content_to_text(html_str: str) -> str:
    """Convert WordPress content HTML to clean plain text, preserving
    paragraph breaks."""
    if not html_str:
        return ""
    s = html_str
    s = re.sub(r"<!--\s*/?wp:[^>]*-->", "", s)   # Gutenberg block comments
    s = re.sub(r"\[/?[a-zA-Z0-9_\-]+(\s[^\]]*)?\]", "", s)  # shortcodes
    soup = BeautifulSoup(s, "html.parser")
    for tag in soup(["script", "style", "figure", "img"]):
        tag.decompose()
    for br in soup.find_all("br"):
        br.replace_with("\n")
    block_tags = ("p", "div", "section", "article", "h1", "h2", "h3",
                  "h4", "h5", "h6", "li", "blockquote")
    parts: list[str] = []
    for el in soup.descendants:
        if getattr(el, "name", None) in block_tags:
            txt = el.get_text(" ", strip=True)
            if txt:
                parts.append(txt)
    if not parts:
        parts = [soup.get_text(" ", strip=True)]
    text = "\n\n".join(p for p in parts if p)
    text = html.unescape(text)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = text.replace("\u00a0", " ")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


# ---------- planning ---------------------------------------------------------
async def build_plan(db, csv_rows: list[dict]) -> dict:
    """Return a deterministic list of actions the migration would take
    against the current DB. Purely read-only.

    Returns
    -------
    {
      "stats": { "to_insert": int, "to_overwrite": int,
                 "to_preserve": int, "to_skip_short": int,
                 "to_skip_placeholder": int,
                 "to_skip_pending_manual_choice": int,
                 "wp_rows_matched": int, "wp_rows_unmatched": int },
      "actions": [
        {"franchisee_id": ..., "franchise_number": ..., "name": ...,
         "action": "inserted"|"overwrote_approved"|"preserved_existing"|
                   "skipped_short_content"|"skipped_placeholder"|
                   "skipped_pending_manual_choice"|"skipped_blank_content",
         "chars": int,
         "text": str,           # only present when will_write is True
         "previous_bio": str?,  # only for overwrite branches
         "source_permalink": str,
         "source_title": str,
         "source_row_index": int,
         "will_write": bool,
         "note": str },
        ...
      ],
      "unmatched_wp_rows": [ {row_index, title, contact_email, name}, ... ]
    }
    """
    # 1) Load live franchisees.
    active = await db.franchisees.find(
        {"tags": "Franchisee", "lifecycle_status": {"$ne": "ex"}},
        {"_id": 0, "id": 1, "first_name": 1, "last_name": 1,
         "organisation": 1, "wp_title": 1, "franchise_number": 1,
         "email": 1, "contact_email": 1, "primary_email": 1,
         "mojo_email": 1, "secondary_email": 1,
         "website_bio": 1, "show_website_bio": 1},
    ).to_list(500)

    # 2) Email → franchisee index.
    email_lookup: dict[str, dict] = {}
    for f in active:
        for k in ("email", "contact_email", "primary_email",
                  "mojo_email", "secondary_email"):
            e = normalise_email(f.get(k))
            if e:
                email_lookup.setdefault(e, f)

    # 3) Group WP rows by matched-franchisee id (email match only).
    grouped: dict[str, list[dict]] = {}
    unmatched: list[dict] = []
    for i, r in enumerate(csv_rows, start=1):
        r_email = normalise_email(
            r.get("contact_email") or r.get("_contact_email"))
        target = email_lookup.get(r_email)
        if target is None:
            unmatched.append({
                "row_index": i,
                "title": (r.get("Title") or "").strip(),
                "contact_email": r_email,
                "name": (r.get("franchisee_name")
                         or r.get("_franchisee_name") or "").strip(),
            })
            continue
        r["_row_index"] = i
        grouped.setdefault(target["id"], []).append(r)

    # 4) Per-franchisee decision.
    actions: list[dict] = []
    for fid, rows in grouped.items():
        target = next(f for f in active if f["id"] == fid)
        fno = target.get("franchise_number") or ""
        fname = (f"{target.get('first_name') or ''} "
                 f"{target.get('last_name') or ''}").strip()
        existing = (target.get("website_bio") or "").strip()

        # Held-back list (Helen Lyons).
        if fno in HOLD_BACK_FRANCHISE_NUMBERS:
            actions.append(_action(
                target, rows[0], "skipped_pending_manual_choice",
                chars=0, will_write=False,
                note=("Held back for manual choice between multiple WP "
                      "pages. Write a separate audit row when Paul picks "
                      "an option (inserted_manual_choice_A or _B)."),
            ))
            continue

        # Preserve-existing FIRST — so show_website_bio is enabled even if
        # WP row is a placeholder/short.
        if existing and fno not in APPROVED_OVERWRITE_FRANCHISE_NUMBERS:
            actions.append(_action(
                target, rows[0], "preserved_existing",
                chars=len(existing), will_write=True,
                previous_bio=existing,
                note=("Live bio already populated; WP row ignored. Only "
                      "show_website_bio may flip to true."),
            ))
            continue

        # Dedup by typography-normalised key.
        candidates: list[tuple[dict, str]] = []
        seen: set[str] = set()
        for r in rows:
            txt = wp_content_to_text(r.get("Content") or "").strip()
            if not txt:
                continue
            k = _dedup_key(txt)
            if k in seen:
                continue
            seen.add(k)
            candidates.append((r, txt))

        if not candidates:
            actions.append(_action(
                target, rows[0], "skipped_blank_content",
                chars=0, will_write=False,
                note="No WP row for this franchisee carried any content.",
            ))
            continue

        if len(candidates) > 1:
            actions.append(_action(
                target, candidates[0][0], "skipped_pending_manual_choice",
                chars=0, will_write=False,
                note=(f"{len(candidates)} distinct WP bios matched — "
                      f"needs manual choice."),
            ))
            continue

        source_row, text = candidates[0]
        n_chars = len(text)

        if is_placeholder(text):
            actions.append(_action(
                target, source_row, "skipped_placeholder",
                chars=n_chars, will_write=False,
                note=f"WP text matched placeholder pattern: {text[:60]!r}",
            ))
            continue

        if n_chars < MIN_CHARS:
            actions.append(_action(
                target, source_row, "skipped_short_content",
                chars=n_chars, will_write=False,
                note=(f"WP bio only {n_chars} chars, below "
                      f"{MIN_CHARS}-char threshold."),
            ))
            continue

        # Write path.
        action = ("overwrote_approved"
                  if existing and fno in APPROVED_OVERWRITE_FRANCHISE_NUMBERS
                  else "inserted")
        actions.append(_action(
            target, source_row, action,
            chars=n_chars, will_write=True, text=text,
            previous_bio=existing if action == "overwrote_approved" else None,
            note=("Overwrite approved for Anita #0030 (Cheryl/Johann "
                  "legacy text)." if action == "overwrote_approved"
                  else "Inserted from WP export."),
        ))

    # 5) Stats.
    def _count(name: str) -> int:
        return sum(1 for a in actions if a["action"] == name)

    stats = {
        "wp_rows_matched": sum(len(v) for v in grouped.values()),
        "wp_rows_unmatched": len(unmatched),
        "to_insert": _count("inserted"),
        "to_overwrite": _count("overwrote_approved"),
        "to_preserve": _count("preserved_existing"),
        "to_skip_short": _count("skipped_short_content"),
        "to_skip_placeholder": _count("skipped_placeholder"),
        "to_skip_pending_manual_choice":
            _count("skipped_pending_manual_choice"),
        "to_skip_blank_content": _count("skipped_blank_content"),
    }
    return {
        "stats": stats,
        "actions": sorted(actions,
                          key=lambda a: (a["franchise_number"] or "")),
        "unmatched_wp_rows": unmatched,
    }


def _action(target: dict, source_row: dict | None, action: str, *,
            chars: int, will_write: bool,
            text: str | None = None,
            previous_bio: str | None = None,
            note: str = "") -> dict:
    return {
        "franchisee_id": target["id"],
        "franchise_number": target.get("franchise_number") or "",
        "name": (f"{target.get('first_name') or ''} "
                 f"{target.get('last_name') or ''}").strip(),
        "action": action,
        "chars": int(chars or 0),
        "text": text,
        "previous_bio": previous_bio,
        "source_permalink": (source_row or {}).get("Permalink") or "",
        "source_title": (source_row or {}).get("Title") or "",
        "source_row_index": (source_row or {}).get("_row_index"),
        "will_write": bool(will_write),
        "note": note,
    }
