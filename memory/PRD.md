# Creative Mojo — Admin & Franchisee Hub PRD

## Original Problem Statement
Bespoke admin system for the Creative Mojo franchise business, consolidating
Airtable, FileCamp, a legacy CRM, Invoicing and Banking modules into a single
robust platform. Includes Admin Console + Franchisee Portal with matching UX
where applicable.

## Core Modules
- Announcements / HQ Updates
- File Vault (Cloudflare R2)
- Training Videos (YouTube OAuth)
- Subscription Requests
- Calendar (shared across HQ + franchisees)
- CRM with **Mapbox Territory Mapping** (CQC + Scotland + NI + Wales/CIW)
- Marketing eshot composer
- Franchise Store (Shape Orders)
- Xero Invoicing integration
- **Project Linking** — maps WooCommerce products ↔ Cloudflare R2 project
  assets via shared `project_code` (rapidfuzz suggestion engine).

## Recent (June 2026)
- ✅ YouTube sync hardening (fail-loud on API-key fallback, newest-first + LATEST badge)
- ✅ Territory Builder legend dropdowns overlay-positioned
- ✅ CIW Wales importer + cross-border mapping + Wales admin page
- ✅ My Clients Panel polish (left-aligned BEDS/STATUS, default lead status,
  full-width expand)
- ✅ "My Clients Only" filter hides non-client markers
- ✅ Project Codes / Linking foundation: admin page, fuzzy suggestions,
  manual link table, calendar modal, month dropdown, Stencil exclusion filter
- ✅ Verified Preview: Project Codes search ("National BBQ Week") and month
  dropdown (June) now render correctly (16 Jun 2026)
- ✅ **Iteration 22 (18 Jun 2026) — Convert-to-Franchisee auto-links territory plan**
  • POST /api/contacts/{id}/convert-to-franchisee now finds the latest
    territory_plan for the contact, copies sectors + home_count onto the
    new franchisee, back-links the plan, and writes a territory_history
    snapshot tagged `source=convert_to_franchisee`. Response surfaces
    `territory_linked`, `territory_sectors`, `territory_home_count`,
    `linked_plan_id`.
  • ContactsPage convertContact: sonner toast on auto-link, confirm()
    prompt redirects admin to /territory-builder when no plan exists.
  • Test coverage: backend/tests/test_iter22_convert_territory.py (4/4
    pass) + testing_agent_v3_fork verified frontend both code paths.
- ✅ **Iteration 22 (18 Jun 2026) — Eliminated GF_BACKFILL_FORM_IDS env drift**
  • New /app/backend/form_intake_config.py owns FORM_ID_TO_SOURCE,
    FORM_IDS_IN_PIPELINE, FORM1_REASON_TO_SOURCE, PIPELINE_SOURCES +
    backfill_form_ids() helper. server.py + gf_backfill.py both import
    from it. Env var GF_BACKFILL_FORM_IDS is now optional (still honoured
    as emergency override). Removes the drift that hit Form 33 in prod.

## P1 — Upcoming
- Marketing+ #3: Insert image from File Vault into eshot composer
- Plan-a-Route: wire to Mapbox Directions + deep-link to Google/Apple Maps

## P2 — Future
- Phase 3 Website Migration (WooCommerce content + order history rebuild)
- Self-serve email password reset via Resend
- Wire `pending_invoice_additions` → Xero invoice run
- WooCommerce order reconcile
- Bulk auto-merge duplicate contacts
- GoCardless monthly billing reconciliation dashboard
- Phase 5: Licensee credit-based portal

## Refactor
- Split `server.py` (>4400 lines) into per-feature routers

## Blocked (User Action)
- Xero reconnect — user to update `XERO_REDIRECT_URI` in Xero Developer Console

## Test Credentials
- Admin: `admin@creativemojo.co.uk` / `CreativeMojo2026!`
- Demo Franchisee: `demo@creativemojo.co.uk` / `CreativeMojoDemo2026!`
- Sandra (Franchisee): `sandra@creativemojo.co.uk` / `Test1234!`

## Key URLs
- Preview frontend + backend: `https://licensee-vault.preview.emergentagent.com`
- Production frontend: `https://hub.creativemojo.co.uk` (needs redeploy to
  pick up Project Linking changes)

## Known Issue Recurrence
- Preview vs Production confusion (user tests production, agent works on
  preview). Always confirm which environment when verifying fixes.
