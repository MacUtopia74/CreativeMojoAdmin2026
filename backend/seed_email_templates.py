"""Seed Paul's two starting email templates (Franchise + Australian Licence).
Idempotent — looks up by ``slug`` so re-running won't duplicate.

Run once after the email_templates module ships:
    cd /app/backend && python seed_email_templates.py
"""
from __future__ import annotations

import asyncio
import os
import uuid
from datetime import datetime, timezone

from motor.motor_asyncio import AsyncIOMotorClient

SIGNATURE_HTML = """
<p>Have a great day.</p>
<p>Best Regards,</p>
<p><strong>Paul Caldeira-Dunkerley</strong><br/>
Managing Director — Creative Mojo Ltd<br/>
Mobile: 07976 233 660 &nbsp;|&nbsp; Office: 01580 882 230<br/>
Email: <a href="mailto:paul@creativemojo.co.uk">paul@creativemojo.co.uk</a><br/>
Website: <a href="https://www.creativemojo.co.uk">www.creativemojo.co.uk</a></p>
<p style="font-size:11px;color:#666;">Creative Mojo Ltd · Robertsbridge · East Sussex</p>
"""

FRANCHISE_BODY = f"""
<p>Hi {{{{first_name}}}},</p>
<p>Thank you so much for your interest in becoming a Creative Mojo franchisee.</p>
<p>Please find attached our full information pack for prospective UK franchisees, which covers the
business, who we work with, what your investment looks like and how we support you from training
through to launch.</p>
<p style="margin:20px 0;">
  <a href="{{{{file:franchise_pack}}}}"
     style="display:inline-block;background:#dddd16;color:#1a1a1a;padding:12px 22px;text-decoration:none;font-weight:bold;border-radius:6px;">
     Click here to download the Creative Mojo Franchise Pack 2026
  </a>
</p>
<p>I'd love the chance to talk you through it and answer any questions you may have. The next step
is normally a no-pressure 30-minute call — feel free to reply with a couple of times that suit you,
or grab a slot from my calendar.</p>
<p style="margin:20px 0;">
  <a href="https://www.creativemojo.co.uk/promo-video"
     style="display:inline-block;background:#1a1a1a;color:#dddd16;padding:10px 18px;text-decoration:none;font-weight:bold;border-radius:6px;">
     ▶ Watch the Mojo promo video
  </a>
</p>
{SIGNATURE_HTML}
"""

LICENCE_BODY = f"""
<p>Hi {{{{first_name}}}},</p>
<p>Thank you so much for your interest in Creative Mojo. As you are based outside the UK, our
relationship would be set up as an <strong>international licence</strong> rather than a franchise —
giving you the rights to run Creative Mojo classes in your territory with our full creative and
business support.</p>
<p>I've attached our Licence Information Pack which covers everything: the model, how training and
launch works, ongoing creative content, support and what your investment looks like.</p>
<p style="margin:20px 0;">
  <a href="{{{{file:licence_pack}}}}"
     style="display:inline-block;background:#dddd16;color:#1a1a1a;padding:12px 22px;text-decoration:none;font-weight:bold;border-radius:6px;">
     Click here to download the Creative Mojo Licence Information Pack
  </a>
</p>
<p>The next step is usually a 30-minute video call to walk you through it and answer any questions —
reply with a couple of times that suit you (and your timezone) and we'll get something in the diary.</p>
<p style="margin:20px 0;">
  <a href="https://www.creativemojo.co.uk/promo-video"
     style="display:inline-block;background:#1a1a1a;color:#dddd16;padding:10px 18px;text-decoration:none;font-weight:bold;border-radius:6px;">
     ▶ Watch the Mojo promo video
  </a>
</p>
{SIGNATURE_HTML}
"""


SEEDS = [
    {
        "slug": "franchise-enquiry-reply",
        "name": "Franchise Enquiry Reply",
        "subject": "Your Creative Mojo Franchise Enquiry",
        "body_html": FRANCHISE_BODY,
        "default_from": "paul@creativemojo.co.uk",
        "sender_name": "Paul Caldeira-Dunkerley",
        "default_cc": [],
        "default_bcc": ["paul@creativemojo.co.uk"],
        "category": "franchise",
        "attachments": [{"key": "", "name": "Creative Mojo Franchise Pack 2026", "placeholder": "franchise_pack"}],
    },
    {
        "slug": "licence-enquiry-reply",
        "name": "Licence Enquiry Reply (Overseas)",
        "subject": "Your Creative Mojo Enquiry",
        "body_html": LICENCE_BODY,
        "default_from": "paul@creativemojo.co.uk",
        "sender_name": "Paul Caldeira-Dunkerley",
        "default_cc": [],
        "default_bcc": ["paul@creativemojo.co.uk"],
        "category": "licence",
        "attachments": [{"key": "", "name": "Creative Mojo Licence Information Pack", "placeholder": "licence_pack"}],
    },
]


async def main():
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = client[os.environ["DB_NAME"]]
    now = datetime.now(timezone.utc).isoformat()
    written = 0
    skipped = 0
    for seed in SEEDS:
        existing = await db.email_templates.find_one({"slug": seed["slug"]}, {"_id": 0, "id": 1})
        if existing:
            print(f"  • '{seed['name']}' already exists — skipping")
            skipped += 1
            continue
        doc = dict(seed)
        doc["id"] = str(uuid.uuid4())
        doc["created_at"] = now
        doc["created_by"] = "system-seed"
        doc["updated_at"] = now
        doc["updated_by"] = "system-seed"
        await db.email_templates.insert_one(doc)
        print(f"  ✓ '{seed['name']}' seeded ({doc['id']})")
        written += 1
    print(f"\nDone — {written} written, {skipped} skipped.")


if __name__ == "__main__":
    asyncio.run(main())
