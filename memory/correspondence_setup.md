# Correspondence — Setup Guide

Follow these steps in Resend + your DNS provider to complete the
Correspondence feature build. Nothing here touches your existing
`creativemojo.co.uk` sending records — every change lives on the
dedicated **`messages.creativemojo.co.uk`** subdomain.

---

## 1. Add the receiving subdomain in Resend

1. Log in to <https://resend.com/domains>.
2. Click **Add Domain** and enter exactly:
   ```
   messages.creativemojo.co.uk
   ```
3. Region: keep whichever region your existing sending domain uses (recommended: `eu-west-1` for UK deliverability). Do **not** change your sending domain's region.
4. On the new domain's page, toggle **Enable Receiving** on.
5. Resend will now display 2–4 DNS records. **Copy exactly what it shows** — the MX host and TXT tokens are region-specific and pointing to guessed values will silently fail.

Typical record shape (yours may differ — trust Resend's UI):

| Type | Host / Name                                            | Value / Content                                     | Priority |
|------|--------------------------------------------------------|-----------------------------------------------------|----------|
| MX   | `messages.creativemojo.co.uk`                          | `inbound-smtp.<region>.amazonaws.com` (from Resend) | 10       |
| TXT  | `messages.creativemojo.co.uk`                          | `resend-verification=<token>`                       | —        |
| TXT  | `resend._domainkey.messages.creativemojo.co.uk`        | DKIM public key from Resend                         | —        |
| TXT  | `messages.creativemojo.co.uk` (optional SPF, if shown) | `v=spf1 include:amazonses.com -all`                 | —        |

> **Do not** add MX records to the root `creativemojo.co.uk`. The subdomain is isolated so your existing mailboxes are untouched.

## 2. Add the records at your DNS provider

Log in to whichever DNS host manages `creativemojo.co.uk` (Cloudflare, GoDaddy, Squarespace, etc.) and add each record exactly as shown by Resend.

- If your DNS host asks for a "host" or "name", enter the value **relative** to the root domain (usually just `messages` for the MX record and TXT verification, and `resend._domainkey.messages` for the DKIM record).
- If it asks for the **full name**, use the fully-qualified value from the table above.
- Set TTLs to 300–3600 seconds (default is fine).

Verify from a terminal:

```bash
dig +short MX messages.creativemojo.co.uk
dig +short TXT messages.creativemojo.co.uk
dig +short TXT resend._domainkey.messages.creativemojo.co.uk
```

The MX must resolve to Resend's inbound host. Both TXT lookups should return non-empty values.

## 3. Verify inside Resend

Go back to the domain page in Resend and click **Verify**. It usually turns green within 5 minutes; propagation can take up to a couple of hours.

## 4. Create the inbound webhook

1. In Resend, go to **Webhooks → Add Webhook**.
2. **Endpoint URL** — use the production URL of the Hub:
   ```
   https://hub.creativemojo.co.uk/api/webhooks/resend/inbound
   ```
   (or the preview URL while testing:
   `https://licensee-vault.preview.emergentagent.com/api/webhooks/resend/inbound`)
3. Event: check `email.received` only.
4. Save. Resend will show a **Signing Secret** — click **Reveal** and copy it (starts with `whsec_`).

## 5. Add the secret to the Hub

Add the following to `backend/.env` (via Emergent → Configuration if editing production):

```env
RESEND_INBOUND_WEBHOOK_SECRET=whsec_...paste-signing-secret-here...
RESEND_RECEIVING_DOMAIN=messages.creativemojo.co.uk
```

Restart the backend (Emergent will do this automatically after a config change).

## 6. Send a test email

- From your personal inbox, reply to any outbound sent through the Hub. The `Reply-To` header will look like `reply+xxxxxxxx@messages.creativemojo.co.uk`.
- Or send fresh to that same address to test unmatched → sender-based matching.

Within 5–10 seconds the reply should appear in the contact's Correspondence modal under **RECEIVED**. If it doesn't:
- Check the Resend dashboard for the incoming email and webhook attempt logs (Webhooks → your webhook → Recent Deliveries).
- Check `backend.err.log` for `correspondence` errors.
- Verify DNS with the `dig` commands above.

---

## Notes on behaviour

- **Every outbound** email sent through the Hub now stamps a unique `Reply-To: reply+{token}@messages.creativemojo.co.uk` header. Legacy contacts get a token allocated on their first send.
- **Matching order**: plus-token → In-Reply-To → any Message-ID in References → sender email → unmatched.
- **Attachments** are downloaded into R2 as soon as the webhook fires (Resend's URLs expire in 1 hour). The UI shows a signed 15-minute download link.
- **Unmatched** inbounds are still saved (with `contact_id = null`, `match_method = "unmatched"`) so nothing is lost — expose these via a Later ticket if you want an "Unlinked inbox" review view.
