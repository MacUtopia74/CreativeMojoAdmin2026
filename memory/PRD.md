# Creative Mojo Admin — PRD

## Original problem statement
Bespoke admin system for a franchise business consolidating Airtable, FileCamp, legacy CRM, Invoicing, and Banking modules into a single robust platform. Modules include: Territory mapping, Marketing e-shot composer, Franchise Store, Xero integration, File Vault, Video Hub, Sales Pipeline CRM, Project Linking, WYSIWYG Email Template Editor, Lead Temperature Scoring, custom PDF Landing Pages, CQC database sync, Contract Management System (CMS), MyTerritory+ (per-franchisee CRM + client pool).

## Architecture
- Backend: FastAPI (`/app/backend/server.py` monolith >7000 lines + modular routers e.g. `find_class_routes.py`, `contracts_routes.py`)
- Frontend: React + Tailwind + shadcn/ui + Mapbox GL JS
- DB: MongoDB
- Object storage: Cloudflare R2
- Integrations: Xero, Resend, WooCommerce, CQC API, Mapbox

## Recent changelog
- 2026-02-XX — Fix: Numbered map markers on MyTerritory+ (`FranchiseeTerritoryWidget`) now open the detail entry modal on click (same as row click), instead of only highlighting the circle. Plus/admin layouts only; basic franchisees unchanged.
- Map Popup Overhaul: public map now pulls from Franchisee Portal checkboxes only, no WP fallbacks.
- Portal UI: Territory/Name/Image/Facebook opt-in checkboxes on `PortalDetailsPage`.
- Contract Renewal Fee: £500 default on Add/Renew modal.
- Map iframe: `/api/find-class/embed.html` exposed publicly with `frame-ancestors` CSP for WordPress embedding.

## Backlog (prioritised)
### P0 / In progress
- Verify WP iframe replacement (user action on WordPress side)
- After WP iframe confirmed, delete dormant WP Bio Migration tooling

### P1
- Sam Whiteman's File Vault empty — build `/api/admin/files/diag`
- Contacts Page blank on Preview (recurring 6×)
- `/api/email/sends` 500 hardening (Kathryn Wal malformed BSON)
- Harden CQC sync (retry, completeness, stale warnings)
- Mobile-friendly Admin Sales Pipeline
- `{{first_name}}` chip pill in Tiptap editor
- Marketing+ insert image from File Vault into e-shot composer
- "Plan a Route" → Mapbox Directions
- Resend inbound webhook (blocked on user secret)

### P2
- Phase 5c auto-draft follow-up emails
- 60-day Hub+ free trial automation
- GoCardless recurring subscription post-trial
- Meta Ads Dashboard for Hub
- Admin view of MyTerritory+ Clients
- Phase 3 Website Migration (WooCommerce products, content, order history)
- Refactor `server.py` into distinct routers
- Specialisms filter dropdown on MyTerritory+ Territory pool (paused by user)

## Key files
- `/app/frontend/src/components/territory/FranchiseeTerritoryWidget.jsx` — MyTerritory+ orchestrator
- `/app/frontend/src/components/territory/TerritoryMap.jsx` — Mapbox layer + markers
- `/app/frontend/src/components/territory/TerritoryHomesList.jsx` — CQC homes list
- `/app/frontend/src/pages/FranchiseeDetailPage.js` — Admin franchisee page
- `/app/backend/find_class_routes.py` — Public map popup API + iframe embed
- `/app/frontend/src/pages/AdminContractsPage.jsx` — Contracts + renewal fee UI

## Test credentials
See `/app/memory/test_credentials.md`.
