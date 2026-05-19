"""One-off scraper that backfills `wp_page_url` on each franchisee record.

Strategy:
  1. List every `franchise` custom-post via WordPress REST API
     (https://www.creativemojo.com/wp-json/wp/v2/franchise).
  2. For each one, fetch the rendered HTML and pull out the franchise-
     specific contact email (Cloudflare-obfuscated `email-protection` link),
     plus the visible phone.
  3. Match emails against `franchisees.email` / `secondary_email`. Write back
     `wp_page_url` (the post permalink) so the public Find-a-Class API can
     return the right "Visit Page" link.

Run from inside the backend container:
    cd /app/backend && python scrape_wp_franchise_urls.py
"""
from __future__ import annotations

import asyncio
import html
import os
import re
from urllib.parse import urlparse

import httpx
from motor.motor_asyncio import AsyncIOMotorClient

WP_BASE = "https://www.creativemojo.com"
MONGO_URL = os.environ.get("MONGO_URL")
DB_NAME = os.environ.get("DB_NAME")


def cf_decode(encoded: str) -> str | None:
    """Decode Cloudflare email-protection hex strings to a plain email."""
    if not encoded:
        return None
    try:
        key = int(encoded[:2], 16)
        out = "".join(chr(int(encoded[i:i + 2], 16) ^ key) for i in range(2, len(encoded), 2))
        # HTML-entity-decode any remaining &#NN; characters
        return html.unescape(out).strip().lower()
    except Exception:
        return None


# Generic / shared emails we should NEVER use to match to a single franchisee.
SHARED_EMAILS = {
    "info@creativemojo.co.uk",
    "sandra@creativemojo.co.uk",  # HQ fallback
    "headoffice@creativemojo.co.uk",
    "support@creativemojo.co.uk",
}


async def list_franchise_posts(client: httpx.AsyncClient) -> list[dict]:
    out: list[dict] = []
    page = 1
    while True:
        r = await client.get(f"{WP_BASE}/wp-json/wp/v2/franchise",
                             params={"per_page": 100, "page": page, "_fields": "id,slug,title,link"})
        if r.status_code != 200:
            break
        data = r.json()
        if not data:
            break
        out.extend(data)
        if len(data) < 100:
            break
        page += 1
    return out


async def extract_emails_from_page(client: httpx.AsyncClient, url: str) -> list[str]:
    r = await client.get(url, headers={"User-Agent": "Mozilla/5.0"})
    if r.status_code != 200:
        return []
    text = r.text
    # 1. Cloudflare-protected emails: data-cfemail="…" OR href="…/email-protection#HEX"
    protected = re.findall(r'(?:data-cfemail="|/email-protection#)([a-fA-F0-9]+)', text)
    emails = []
    for hex_str in protected:
        decoded = cf_decode(hex_str)
        if decoded and "@" in decoded:
            emails.append(decoded)
    # 2. Any plain mailto:
    plain = re.findall(r'mailto:([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]+)', text)
    emails.extend(e.lower() for e in plain)
    # Dedupe, preserve order
    seen = set()
    deduped = []
    for e in emails:
        if e in seen:
            continue
        seen.add(e)
        deduped.append(e)
    return deduped


async def main():
    if not (MONGO_URL and DB_NAME):
        print("Set MONGO_URL and DB_NAME first.")
        return
    client_mongo = AsyncIOMotorClient(MONGO_URL)
    db = client_mongo[DB_NAME]

    async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as http:
        posts = await list_franchise_posts(http)
        print(f"Found {len(posts)} franchise posts on creativemojo.com")
        # Build a normalised email → franchisee lookup
        # ⚠️ The @creativemojo.co.uk address (the one shown on the public WP
        # pages) is stored as `mojo_email` on our records, NOT `email`.
        franchisees = await db.franchisees.find(
            {"$or": [
                {"mojo_email": {"$exists": True, "$ne": None}},
                {"email": {"$exists": True, "$ne": None}},
                {"secondary_email": {"$exists": True, "$ne": None}},
            ]},
            {"_id": 0, "id": 1, "email": 1, "mojo_email": 1, "secondary_email": 1,
             "first_name": 1, "last_name": 1, "organisation": 1},
        ).to_list(1000)
        by_email: dict[str, dict] = {}
        for f in franchisees:
            for em in [f.get("mojo_email"), f.get("email"), f.get("secondary_email")]:
                if not em:
                    continue
                # secondary_email is sometimes comma-separated — split it.
                for addr in em.split(","):
                    a = addr.strip().lower()
                    if a:
                        by_email[a] = f
        print(f"Indexed {len(by_email)} franchisee emails")

        matched = 0
        unmatched = []
        for post in posts:
            slug = post["slug"]
            link = post["link"]
            emails = await extract_emails_from_page(http, link)
            # Filter out generic/shared
            specific = [e for e in emails if e not in SHARED_EMAILS]
            if not specific:
                unmatched.append({"slug": slug, "reason": "no franchise-specific email", "all_emails": emails})
                continue
            franchisee = None
            chosen_email = None
            for em in specific:
                if em in by_email:
                    franchisee = by_email[em]
                    chosen_email = em
                    break
            if not franchisee:
                unmatched.append({"slug": slug, "reason": "no franchisee record matched", "emails": specific})
                continue
            # Write back
            # `wp_title` is the cleaned-up area name from the WP post itself
            # (e.g. "Crowthorne, Wokingham, Bracknell & Reading") — much
            # nicer for the popup than the verbose `organisation` field.
            wp_title = html.unescape(post["title"]["rendered"]).strip()
            # Strip the "Creative Mojo " prefix when present
            for prefix in ("Creative Mojo - ", "Creative Mojo "):
                if wp_title.lower().startswith(prefix.lower()):
                    wp_title = wp_title[len(prefix):]
                    break
            await db.franchisees.update_one(
                {"id": franchisee["id"]},
                {"$set": {
                    "wp_page_url": link,
                    "wp_slug": slug,
                    "wp_title": wp_title,
                }},
            )
            name = f"{franchisee.get('first_name') or ''} {franchisee.get('last_name') or ''}".strip()
            print(f"  ✓ {chosen_email:35s}  →  {name}  ({slug})")
            matched += 1

        print(f"\n=========================")
        print(f"Matched & updated: {matched}/{len(posts)}")
        print(f"Unmatched:        {len(unmatched)}")
        for u in unmatched:
            print(f"  ✗ {u['slug']:60s} — {u['reason']}")
            if u.get('all_emails'):
                print(f"     emails found: {u['all_emails']}")
            elif u.get('emails'):
                print(f"     emails (not in DB): {u['emails']}")

    client_mongo.close()


if __name__ == "__main__":
    from dotenv import load_dotenv
    load_dotenv("/app/backend/.env")
    MONGO_URL = os.environ.get("MONGO_URL")
    DB_NAME = os.environ.get("DB_NAME")
    asyncio.run(main())
