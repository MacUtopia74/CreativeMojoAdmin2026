# Creative Mojo — Unified Admin Platform PRD

## Original Problem Statement (from user)
A UK franchise business (Creative Mojo — creative arts activities in care homes) wants to replace its fragmented stack (Airtable + FileCamp + a legacy bespoke admin built by an absent friend) with a single, owned, head-office-controlled platform.

Scope confirmed via scoping conversation:
1. **CRM** — migrate from Airtable, with three live Gravity Forms (general / franchise / licence) feeding the new CRM via a free WordPress plugin replacing Zapier.
2. **Order management** — WooCommerce live sync + manual orders + Gantt view (head-office only, not linked to franchisee territories).
3. **Franchisee logins + file storage** — Cloudflare R2 file storage with folder-tree UI, replacing FileCamp (no public API).
4. **UK postcode territory mapping** — Mapbox-based tool replicating current Creative Mojo map, with public website embed at creativemojo.com/find-a-class/ replacing the manual DaD Postcode Lookup.
5. **Licensee portal** — separate logins, 8 downloads/month quota, monthly reset. GoCardless handles payments externally.

## User Personas
- **Admin (Head Office staff)** — Paul Dunkerley and team. Full access to everything.
- **Franchisee** (future, Phase 3) — Owns a territory; accesses own files + shared brand files. ~50 users.
- **Licensee** (future, Phase 5) — Pays AUD monthly via GoCardless; 8 downloads/month quota.

## Tech Stack
- Backend: FastAPI + MongoDB (Motor async driver) + bcrypt + PyJWT + httpx for Airtable
- Frontend: React 19 + React Router 7 + Tailwind CSS + lucide-react icons
- Storage (future): Cloudflare R2
- Map (future): Mapbox GL JS
- Auth: Email + password JWT with httpOnly cookies (samesite=none, secure=true)

## Design Direction
Swiss & high-contrast light theme. Cabinet Grotesk (display) + Manrope (body). Brand yellow `#D4FF00` used sparingly as an interaction accent. 1px grid borders instead of soft shadows.

## Build Plan (5 phases)
- **Phase 1** — Admin shell + login + CRM core + Airtable migration + WordPress form pipeline (×3 forms)
- **Phase 2** — Order management + WooCommerce live sync + Gantt view
- **Phase 3** — Franchisee logins + Cloudflare R2 file storage + file browser (FileCamp retired)
- **Phase 4** — Territory mapping tool + public find-a-class embed
- **Phase 5** — Licensee portal + 8-download/month quota + optional GoCardless webhook

## What's Implemented (2026-05-13)
### Phase 1 — Iteration 1 (current)
- ✅ Admin authentication: bcrypt password hashing, JWT in httpOnly cookies, brute-force protection (5 attempts → 15 min lockout per ip:email)
- ✅ Seeded admin user: `admin@creativemojo.co.uk` / `CreativeMojo2026!` (idempotent startup seed)
- ✅ MongoDB indexes on `users.email` (unique), `users.id` (unique), `login_attempts.identifier`
- ✅ Endpoints: `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `POST /api/auth/users` (admin-only)
- ✅ Airtable read-only proxy: `/api/airtable/tables`, `/records`, `/count` (5-min schema cache)
- ✅ Dashboard stats endpoint with airtable summary
- ✅ Frontend: split-screen login page, sidebar+topbar layout, dashboard with KPI tiles + phase status + next steps, full Airtable Inspector page (browse 14 tables, view all fields with type badges, inspect 10 sample records, on-demand record count)
- ✅ Placeholder pages for Franchisees/Contracts/Contacts (populated post-walkthrough)
- ✅ All flows tested: 17/17 backend tests pass, all 21 frontend flows verified by Playwright

## Migration Decisions (agreed during scoping)
**To migrate:**
- Franchisees/Licencees (88 records, 85 fields)
- Contracts (134 records)
- Contacts table (5,958 records — legacy general enquiries archive)
- Web Form - Contact (1,674 records — active franchise enquiries)
- DaD Postcode Lookup (2,470 records — temporary bridge until Phase 4 auto-generates lookups)

**Skip migration:**
- Snowflakes, Avery All Homes, Avery August 2025 Products, Renewals 2025, Franchise Review Survey 2020, Finance Questionnaire Nov 2022

**Gravity Forms (×3) for live feed:**
- Form 1 → tag `general_enquiry`
- Form 17 → tag `franchise_enquiry`
- Form 32 → tag `licence_enquiry` (feeds Phase 5 pipeline)

## Backlog — P0 (next iteration)
- Schema walkthrough with user (use the Airtable Inspector together) → finalise field-level keep/drop/merge/rename decisions
- Build CRM data models for Franchisees, Contracts, Contacts in MongoDB
- Build franchisee list view (mirroring Airtable's list view UX)
- Build franchisee detail page (mirroring Airtable card layout — photo, contact details, address, status pills, contract number, linked contracts)
- Build contracts list + detail
- Build contacts list with source-tag filtering + dedupe report
- Migration script: pull all agreed Airtable data into MongoDB collections with field mapping
- Build WordPress plugin (free, no Zapier) to POST Gravity Form submissions into CRM
- Provide WordPress plugin ZIP + install/config instructions to user

## Backlog — P1 (Phase 1.5 — GoCardless live mandate status)
- Read GoCardless API token from `.env` (production)
- Add `gocardless_mandate_id` field to franchisee model
- Build `/api/gocardless/mandates/sync` endpoint to auto-link mandates by email
- Build webhook receiver at `/api/webhooks/gocardless` with signature verification
- Live status pill on franchisee detail page (Active / Pending / Failed / Cancelled / Not linked)
- Show last payment date + amount, next scheduled payment, lifetime total
- Dashboard alert: failed mandates in last 24h
- Static `Mandate` value from Airtable preserved as fallback until each franchisee is linked

## Backlog — P1 (Phase 2)
- WooCommerce REST API + webhook integration for order sync
- Orders list with filter tabs (Active/Completed/Draft/All)
- Gantt view of orders vs due dates
- Order detail page (products, shipping, billing, notes, emails)
- Manual "Create Order" workflow
- Production status workflow

## Backlog — P2+ (Phases 3-5)
- Phase 3: Franchisee role login, Cloudflare R2 storage, file browser with per-franchisee permissions
- Phase 4: Mapbox territory map, postcode sector polygons, care-home tally, public find-a-class embed
- Phase 5: Licensee portal, 8-download/month quota, audit log, optional GoCardless webhook

## Active Credentials & Secrets (in `/app/backend/.env`)
- `MONGO_URL`, `DB_NAME=creative_mojo_admin`
- `JWT_SECRET` (64-char hex)
- `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME`
- `AIRTABLE_PAT`, `AIRTABLE_BASE_ID=appc7qwihJ15LxH8P`
- `FRONTEND_URL=https://licensee-vault.preview.emergentagent.com`

## Notes
- All tests passing as of 2026-05-13. No retest needed.
- Code review nits (non-blocking): split `server.py` into modules once Phase 2 lands; migrate FastAPI deprecated `on_event` to lifespan handlers.
