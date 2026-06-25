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
<p style="margin:0 0 6px 0;">Best Regards,</p>
<table cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;border-collapse:collapse;font-family:Helvetica,Arial,sans-serif;color:#1a1a1a;">
  <tr>
    <td valign="top" style="padding-right:18px;">
      <div style="font-size:22px;font-weight:bold;color:#dddd16;line-height:1.1;margin-bottom:2px;">Paul Caldeira-Dunkerley</div>
      <div style="font-size:14px;font-weight:bold;color:#1a1a1a;margin-bottom:8px;">Director, Creative Mojo Ltd</div>
      <hr style="border:0;border-top:1px solid #cccccc;margin:6px 0 10px 0;" />
      <div style="font-size:13px;line-height:1.8;">
        <span style="display:inline-block;">&#9742; 01884 303606 &nbsp;&nbsp; &#128241; 07886 374959</span><br/>
        <span>&#127760; <a href="https://www.creativemojo.com" style="color:#1a1a1a;text-decoration:none;">www.creativemojo.com</a></span><br/>
        <span>&#9993; <a href="mailto:paul@creativemojo.co.uk" style="color:#1a1a1a;text-decoration:none;">paul@creativemojo.co.uk</a></span><br/>
        <span>&#128205; Channings, Brithem Bottom, Cullompton, Devon EX15 1NB</span>
      </div>
      <div style="margin-top:14px;font-size:13px;line-height:1;">
        <a href="https://www.facebook.com/CreativeMojoLtd" style="text-decoration:none;margin-right:8px;display:inline-block;vertical-align:middle;">
          <img src="https://hub.creativemojo.co.uk/brand/social-facebook.png" alt="Facebook" width="32" height="32" style="display:inline-block;border:0;vertical-align:middle;" />
        </a>
        <a href="https://www.instagram.com/creativemojoltd" style="text-decoration:none;margin-right:8px;display:inline-block;vertical-align:middle;">
          <img src="https://hub.creativemojo.co.uk/brand/social-instagram.png" alt="Instagram" width="32" height="32" style="display:inline-block;border:0;vertical-align:middle;" />
        </a>
        <a href="https://twitter.com/creativemojoltd" style="text-decoration:none;margin-right:8px;display:inline-block;vertical-align:middle;">
          <img src="https://hub.creativemojo.co.uk/brand/social-x.png" alt="X" width="32" height="32" style="display:inline-block;border:0;vertical-align:middle;" />
        </a>
        <a href="https://www.youtube.com/@creativemojoltd" style="text-decoration:none;display:inline-block;vertical-align:middle;">
          <img src="https://hub.creativemojo.co.uk/brand/social-youtube.png" alt="YouTube" width="32" height="32" style="display:inline-block;border:0;vertical-align:middle;" />
        </a>
      </div>
    </td>
    <td valign="top" align="right" style="width:240px;">
      <img src="https://hub.creativemojo.co.uk/brand/creative-mojo-logo.png"
           alt="Creative Mojo" width="220" style="max-width:220px;height:auto;display:block;" />
    </td>
  </tr>
</table>
<p style="margin:16px 0;">
  <a href="https://www.youtube.com/watch?v=2gCXgPW_gC8&amp;feature=youtu.be"
     style="display:inline-block;border:2px solid #dddd16;color:#666666;padding:10px 26px;text-decoration:none;font-weight:bold;font-family:Helvetica,Arial,sans-serif;font-size:14px;letter-spacing:0.5px;border-radius:4px;">
     WATCH THE MOJO PROMO VIDEO &nbsp;&rsaquo;
  </a>
</p>
<p style="font-size:11px;line-height:1.5;color:#a0a0a0;margin-top:20px;">
  <strong style="color:#a0a0a0;">IMPORTANT:</strong> The contents of this email and any attachments are confidential. They are intended for the named recipient(s) only. If you have received this email by mistake, please notify the sender immediately and do not disclose the contents to anyone or make copies thereof.
</p>
<p style="font-size:11px;line-height:1.6;color:#333333;margin-top:14px;">
  Creative Mojo Ltd Registered Address: Channings, Brithem Bottom, Cullompton, Devon EX15 1NB.<br/>
  Registered in England and Wales No. 10261882<br/>
  <strong>VAT Registration No. 301645048</strong>
</p>
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
  <a href="https://www.youtube.com/watch?v=2gCXgPW_gC8&amp;feature=youtu.be"
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
  <a href="https://www.youtube.com/watch?v=2gCXgPW_gC8&amp;feature=youtu.be"
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
