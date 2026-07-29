"""Dry-run: match WordPress franchise export biographies to live
franchisees and print a matching report.

READ-ONLY. Does not touch the database. Produces a CSV + terminal
summary showing every candidate match, method, confidence, and
whether the target `website_bio` is currently blank.
"""
from __future__ import annotations

import asyncio
import csv
import html
import os
import re
import sys
from collections import defaultdict
from pathlib import Path

from bs4 import BeautifulSoup
from motor.motor_asyncio import AsyncIOMotorClient

CSV_PATH = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/franchises_wp.csv")
OUT_PATH = Path("/tmp/wp_bio_dry_run.csv")


# ---------- helpers -----------------------------------------------------------
def normalise_email(v) -> str:
    return (v or "").strip().lower()


def normalise_name(v) -> str:
    """Aggressive canonicalisation: lower-case, strip accents, drop
    non-word characters. Handles casing differences plus stray
    punctuation ("Anna-Marie" ≡ "anna marie" ≡ "annamarie")."""
    s = (v or "").strip().lower()
    s = re.sub(r"[^a-z0-9\s]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def wp_content_to_text(html_str: str) -> str:
    """Convert WordPress content HTML to clean plain text, preserving
    paragraph breaks. Strips Gutenberg block comments, shortcodes,
    scripts/styles."""
    if not html_str:
        return ""
    s = html_str
    # Strip Gutenberg block comments <!-- wp:... -->
    s = re.sub(r"<!--\s*/?wp:[^>]*-->", "", s)
    # Strip WP shortcodes [foo bar="baz"] ... [/foo]
    s = re.sub(r"\[/?[a-zA-Z0-9_\-]+(\s[^\]]*)?\]", "", s)
    soup = BeautifulSoup(s, "html.parser")
    for tag in soup(["script", "style", "figure", "img"]):
        tag.decompose()
    # Turn <br> into newlines, block-level tags into double newlines.
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
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def name_variants(first: str, last: str) -> set[str]:
    """All normalised variants of a person's name so we can match
    'John Smith' / 'Smith John' / 'John A Smith' etc."""
    first = normalise_name(first)
    last = normalise_name(last)
    out: set[str] = set()
    if first and last:
        out.add(f"{first} {last}")
        out.add(f"{last} {first}")
        out.add(f"{first}{last}")
    return out


# ---------- main --------------------------------------------------------------
async def main() -> None:
    # 1) Load & parse the CSV.
    rows: list[dict] = []
    with CSV_PATH.open("r", encoding="utf-8-sig", newline="") as fh:
        reader = csv.DictReader(fh)
        for r in reader:
            rows.append(r)
    print(f"[csv] loaded {len(rows)} rows from {CSV_PATH}")

    # 2) Load live franchisees.
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = client[os.environ["DB_NAME"]]
    active = await db.franchisees.find(
        {"tags": "Franchisee", "lifecycle_status": {"$ne": "ex"}},
        {"_id": 0, "id": 1, "first_name": 1, "last_name": 1,
         "organisation": 1, "wp_title": 1, "franchise_number": 1,
         "email": 1, "contact_email": 1, "primary_email": 1,
         "mojo_email": 1, "secondary_email": 1,
         "website_bio": 1},
    ).to_list(500)
    print(f"[db]  loaded {len(active)} active franchisees")

    # Build lookup indexes over the live roster.
    email_index: dict[str, dict] = {}
    name_index: dict[str, list[dict]] = defaultdict(list)
    territory_index: dict[str, list[dict]] = defaultdict(list)

    def _strip_prefix(s: str) -> str:
        for pref in ("Creative Mojo - ", "Creative Mojo "):
            if s.lower().startswith(pref.lower()):
                return s[len(pref):].strip()
        return s.strip()

    for f in active:
        for k in ("email", "contact_email", "primary_email",
                  "mojo_email", "secondary_email"):
            e = normalise_email(f.get(k))
            if e:
                email_index.setdefault(e, f)
        for v in name_variants(f.get("first_name") or "", f.get("last_name") or ""):
            name_index[v].append(f)
        for candidate in (f.get("wp_title"), _strip_prefix(f.get("organisation") or "")):
            if candidate:
                territory_index[normalise_name(candidate)].append(f)

    # 3) Iterate CSV rows, extract bio + attempt match.
    #    We produce ONE report row per CSV row.
    report: list[dict] = []
    matched_franchisees: dict[str, list[dict]] = defaultdict(list)

    for r in rows:
        title = (r.get("Title") or "").strip()
        status_col = ""
        # Post Type column may not carry publish/draft state, but the
        # WP admin export writes it into other columns. We surface
        # whatever hints we find.
        for k in r.keys():
            if k.lower() in ("post status", "status", "post_status"):
                status_col = r[k]
                break
        post_type = (r.get("Post Type") or "").strip()
        raw_html = r.get("Content") or ""
        content_text = wp_content_to_text(raw_html)
        char_count = len(content_text)
        franchisee_name_col = (r.get("franchisee_name")
                               or r.get("_franchisee_name") or "").strip()
        contact_email_col = (r.get("contact_email")
                             or r.get("_contact_email") or "").strip()
        facebook_col = (r.get("facebook_link")
                        or r.get("_facebook_link") or "").strip()
        permalink = (r.get("Permalink") or "").strip()

        # ----- match pipeline -----
        method = "NO_MATCH"
        confidence = "none"
        match: dict | None = None
        alternative_matches: list[dict] = []

        # 1) email match (highest confidence)
        email_norm = normalise_email(contact_email_col)
        if email_norm and email_norm in email_index:
            match = email_index[email_norm]
            method = "email"
            confidence = "high"

        # 2) full-name match
        if not match:
            name_norm = normalise_name(franchisee_name_col)
            candidates = name_index.get(name_norm, [])
            if len(candidates) == 1:
                match = candidates[0]
                method = "name"
                confidence = "high"
            elif len(candidates) > 1:
                match = candidates[0]
                alternative_matches = candidates[1:]
                method = "name (multiple)"
                confidence = "ambiguous"

        # 3) territory / WP title match (supporting only — never used
        #    to overwrite; recorded as low confidence)
        if not match:
            title_norm = normalise_name(_strip_prefix(title))
            t_candidates = territory_index.get(title_norm, [])
            if len(t_candidates) == 1:
                match = t_candidates[0]
                method = "title"
                confidence = "low"
            elif len(t_candidates) > 1:
                match = t_candidates[0]
                alternative_matches = t_candidates[1:]
                method = "title (multiple)"
                confidence = "ambiguous"

        if match:
            matched_franchisees[match["id"]].append({
                "wp_title": title, "confidence": confidence,
                "method": method, "chars": char_count,
                "excerpt": content_text[:120].replace("\n", " "),
                "permalink": permalink,
            })

        report.append({
            "wp_row_index": rows.index(r) + 1,
            "wp_post_type": post_type,
            "wp_post_status_hint": status_col,
            "wp_title": title,
            "wp_permalink": permalink,
            "wp_franchisee_name": franchisee_name_col,
            "wp_contact_email": contact_email_col,
            "wp_facebook": facebook_col,
            "bio_chars": char_count,
            "match_method": method,
            "match_confidence": confidence,
            "matched_franchisee_id": (match or {}).get("id") or "",
            "matched_first_name": (match or {}).get("first_name") or "",
            "matched_last_name": (match or {}).get("last_name") or "",
            "matched_franchise_number": (match or {}).get("franchise_number") or "",
            "matched_organisation": (match or {}).get("organisation") or "",
            "matched_wp_title": (match or {}).get("wp_title") or "",
            "matched_contact_email": normalise_email(
                (match or {}).get("contact_email")
                or (match or {}).get("primary_email")
                or (match or {}).get("email")
                or (match or {}).get("mojo_email")),
            "live_website_bio_state": (
                "populated" if (match and (match.get("website_bio") or "").strip())
                else "blank" if match else "n/a"
            ),
            "live_website_bio_len": len((match or {}).get("website_bio") or ""),
            "alt_match_ids": "|".join(a["id"] for a in alternative_matches),
            "alt_match_names": "|".join(
                f"{a.get('first_name','')} {a.get('last_name','')}".strip()
                for a in alternative_matches),
            "bio_excerpt": content_text[:200].replace("\n", " "),
        })

    # 4) Write CSV report.
    with OUT_PATH.open("w", encoding="utf-8", newline="") as fh:
        fields = list(report[0].keys()) if report else []
        w = csv.DictWriter(fh, fieldnames=fields)
        w.writeheader()
        for row in report:
            w.writerow(row)
    print(f"[out] wrote CSV → {OUT_PATH}")

    # 5) Summary counts.
    n_total = len(report)
    n_matched = sum(1 for r in report if r["matched_franchisee_id"])
    n_ambig = sum(1 for r in report if r["match_confidence"] == "ambiguous")
    n_no_content = sum(1 for r in report if r["bio_chars"] == 0)
    n_no_match = sum(1 for r in report if not r["matched_franchisee_id"])
    n_low = sum(1 for r in report if r["match_confidence"] == "low")
    n_high = sum(1 for r in report if r["match_confidence"] == "high")
    n_blank_target = sum(1 for r in report if r["live_website_bio_state"] == "blank")
    n_pop_target = sum(1 for r in report if r["live_website_bio_state"] == "populated")
    print()
    print("=" * 72)
    print("SUMMARY")
    print("=" * 72)
    print(f"  WP rows total                : {n_total}")
    print(f"    - matched (any confidence) : {n_matched}")
    print(f"      · HIGH confidence        : {n_high}")
    print(f"      · LOW  (title-only)      : {n_low}")
    print(f"      · AMBIGUOUS              : {n_ambig}")
    print(f"    - NO match                 : {n_no_match}")
    print(f"    - WP row has no bio content: {n_no_content}")
    print()
    print(f"  Of matched rows, target state:")
    print(f"    - live website_bio BLANK   : {n_blank_target}  ← safe to backfill")
    print(f"    - live website_bio POPULATED: {n_pop_target}  ← DO NOT overwrite")
    print()

    # 6) Franchisees receiving multiple WP-bio candidates (Bel / Annette / Helen etc.)
    multi = {fid: rows_ for fid, rows_ in matched_franchisees.items() if len(rows_) > 1}
    if multi:
        print("Franchisees with MULTIPLE candidate WP bio pages:")
        for fid, rows_ in multi.items():
            fr = next((f for f in active if f["id"] == fid), None)
            name = f"{fr.get('first_name') or ''} {fr.get('last_name') or ''}".strip() if fr else fid
            print(f"  • {name} (#{fr.get('franchise_number') or '—'}) — {len(rows_)} candidates:")
            for c in sorted(rows_, key=lambda x: -x["chars"]):
                print(f"      · [{c['confidence']:>9}] {c['wp_title']!r}  {c['chars']} chars  ({c['method']})")
    print()

    # 7) Franchisees on the live roster that got no WP bio at all.
    matched_ids = set(matched_franchisees.keys())
    active_missing = [f for f in active if f["id"] not in matched_ids]
    if active_missing:
        print(f"Active franchisees with NO WP bio match ({len(active_missing)}):")
        for f in active_missing:
            print(f"  • {f.get('first_name','')} {f.get('last_name','')} — "
                  f"#{f.get('franchise_number') or '—'} — "
                  f"{f.get('organisation') or ''}")
    print()
    print(f"Full row-by-row CSV: {OUT_PATH}")


if __name__ == "__main__":
    asyncio.run(main())
