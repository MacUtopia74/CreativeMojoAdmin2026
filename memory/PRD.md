# Creative Mojo — Unified Admin Platform PRD

## Original Problem Statement (from user)
A UK franchise business (Creative Mojo — creative arts activities in care homes) wants to replace its fragmented stack (Airtable + FileCamp + a legacy bespoke admin built by an absent friend) with a single, owned, head-office-controlled platform.

## User Personas
- **Admin (Head Office staff)** — Paul Dunkerley and team. Full access.
- **Franchisee** (Phase 3) — Owns a territory; accesses own files + shared brand files. ~88 active.
- **Licensee** (Phase 5) — Pays AUD monthly via GoCardless; 8 downloads/month quota.

## Tech Stack
- Backend: FastAPI + MongoDB + bcrypt + PyJWT + httpx
- Frontend: React 19 + React Router 7 + Tailwind + lucide-react
- Storage (future): Cloudflare R2
- Map (future): Mapbox GL JS
- Auth: Email + password JWT with httpOnly cookies

## Design Direction
Swiss & high-contrast light theme. Cabinet Grotesk (display) + Manrope (body). Yellow `#D4FF00` accent used sparingly.

## Build Plan
- **Phase 1** ✅ Admin shell + login + CRM core + Airtable migration + WordPress form pipeline (×3 forms) + anniversary reminders scaffold
- **Phase 1.5** GoCardless live mandate status (read-only API + webhook). Replaces static `mandate` field with live status pill + last/next payment.
- **Phase 1.6** ✅ Sales pipeline (simple): Kanban view of enquiries with stages New → Contacted → Qualified → Demo Booked → Converted → Lost
- **Phase 2** Order management + WooCommerce live sync + Gantt view
- **Phase 3** Franchisee logins + Cloudflare R2 file storage + file browser (FileCamp retired)
- **Phase 4** Territory mapping tool + public find-a-class embed (replaces DaD Postcode Lookup)
- **Phase 5** Licensee portal + 8-download/month quota + optional GoCardless webhook

## What's Implemented (2026-05-13)

### Phase 1 — Iteration 1
- Admin auth (bcrypt + JWT httpOnly cookies + brute-force protection)
- Airtable Inspector (browse all 14 tables, view fields with type badges, count records, sample 10 rows)

### Phase 1 — Iteration 2 (Migration + CRM)
- **MIGRATION COMPLETE:** Airtable → MongoDB
  - 88 franchisees
  - 134 contracts (linked back to franchisees)
  - 5,958 legacy contacts (tagged `legacy_general_enquiry`)
  - 1,674 web form contacts (tagged `franchise_enquiry`)
  - 2,470 territory postcodes (linked to franchisees)
- Decision-capture workflow: per-table migrate/skip + per-field keep/drop/rename/merge with optional notes. Decisions persist in MongoDB. Migration Plan page exports JSON or Markdown.
- 78 fields kept, 1 renamed (1st Anniversary Date → anniversary_reminder), 1 merged (Contacts dedup), 120 dropped.
- **Franchisees:** list page (sortable, searchable) + detail page (photo, contact details, address, tags, linked contracts, full territory postcode list)
- **Contracts:** list page (134 records, linked to franchisees, search by name/email, status badges)
- **Contacts:** list page with source filter (Franchise enquiries vs Legacy general) + **simple sales pipeline kanban view** (Phase 1.6 — 6 columns: New / Contacted / Qualified / Demo Booked / Converted / Lost) with one-click stage changes
- **Anniversary reminders:** /api/anniversaries/today returns franchisees with contract anniversaries falling today — scaffolded for automated emails (Phase 1.5b)
- **Dashboard:** real KPIs (88/134/7,632/2,470), Run Migration button (idempotent), anniversaries today card, phase build status

### Tests
- Backend: 35/35 pytest tests pass (auth, brute-force, airtable inspector, migration, CRUD, pipeline, anniversaries)
- Frontend: all 8 critical flows verified via Playwright (login, dashboard KPIs, sidebar nav, franchisees list+search+detail, contracts list, contacts list+filter+pipeline view)

## Migration Decisions (final, applied)
**To migrate:** Franchisees/Licencees (88), Contracts (134), Contacts (5,958 → legacy), Web Form - Contact (1,674 → franchise enquiries), DaD Postcode Lookup (2,470 → territories)
**Skipped:** Snowflakes, Avery All Homes, Avery August 2025 Products, Renewals 2025, Franchise Review Survey 2020, Finance Questionnaire Nov 2022, DaD Shop Orders, Shapes/DBS/Other Orders, FSH Home List Lookup

## Gravity Forms (still to wire up — Phase 1 outstanding)
- Form 1 → `general_enquiry`
- Form 17 → `franchise_enquiry`
- Form 32 → `licence_enquiry`
- Free WordPress plugin replacing Zapier (user will self-install ZIP)

## Backlog — P0 (next iteration)
- **Build the WordPress plugin** to capture all 3 Gravity Forms live
- Provide ZIP + install instructions to user
- Test forms → CRM end-to-end

## Backlog — P1 (Phase 1.5 — GoCardless live mandate status)
- GoCardless API token read from `.env`
- `gocardless_mandate_id` field on franchisee
- `/api/gocardless/mandates/sync` to auto-link by email
- `/api/webhooks/gocardless` receiver with signature verification
- Live status pill on franchisee detail page
- Last/next payment date + amount, lifetime total
- Dashboard alert: failed mandates last 24h
- Renewal Fee Paid? auto-tick on detected renewal payment

## Backlog — P1 (Phase 2 — Orders)
- WooCommerce REST API + webhook integration
- Orders list (Active/Completed/Draft/All filters)
- Gantt view of orders vs due dates
- Order detail page (products, shipping, billing, notes, emails)
- Manual "Create Order" workflow
- Production status workflow

## Backlog — P2+ (Phases 3, 4, 5)
- Phase 3: Franchisee role login, Cloudflare R2 storage, file browser with per-franchisee permissions, FileCamp retirement
- Phase 4: Mapbox territory map, postcode sector polygons, care-home tally, public find-a-class embed
- Phase 5: Licensee portal, 8-download/month quota, audit log, optional GoCardless webhook for auto-suspend

## Backlog — minor refinements
- Split `server.py` (~775 lines) into modules: auth.py, airtable.py, crm.py
- Add pagination (skip/limit + total) to /api/contacts for browsing beyond 2000 records
- Anniversaries: optimise N+1 franchisee lookup with batched query
- Consider downloading franchisee photos from Airtable's expiring URLs to local storage

## Active Credentials & Secrets (in `/app/backend/.env`)
- `MONGO_URL`, `DB_NAME=creative_mojo_admin`
- `JWT_SECRET`
- `ADMIN_EMAIL=admin@creativemojo.co.uk`, `ADMIN_PASSWORD=CreativeMojo2026!`
- `AIRTABLE_PAT`, `AIRTABLE_BASE_ID=appc7qwihJ15LxH8P`
- `FRONTEND_URL=https://licensee-vault.preview.emergentagent.com`
