# Creative Mojo — Admin & Franchisee Hub PRD

## Recent (Feb 2026)
- ✅ **Franchisee post-login whitescreen fix — `profile.tags.some is not a function`**
  Legacy Airtable franchisee records imported `tags` as a comma-separated
  string (e.g. `"demo, vip"`) instead of a JSON array, so PortalShell.jsx
  raised a TypeError on `rawTags.some(...)` and whitescreened the
  franchisee portal (reproduced by helen.bell@). Belt-and-braces fix:
  • Backend `GET /api/portal/me` (`server.py:2370-2374`) now splits string
    tags on `[,;]` and returns `[]` for any non-string/non-list value.
  • Frontend `PortalShell.jsx:172-176` defensively coerces with
    `Array.isArray(rawTags) ? rawTags : []` before `.some(...)`.
  • Same defensive guard applied across `FranchiseesPage.js`,
    `FranchiseeDetailPage.js`, `CalendarPage.jsx`.
  Regression test added at
  `/app/backend/tests/test_portal_tags_normalization.py` (7 tests, 1.5s).
  Verified end-to-end via testing_agent iteration_39 (backend 100%,
  frontend 100%) — portal renders for both list-shaped and malformed
  string-shaped tags without crash.

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

## Recent (29 Jun 2026)
- ✅ **Phase 5b — Automatic inbound reply detection (Resend Inbound)**
  Built end-to-end. Outbound emails now stamp a deterministic
  `Message-ID: <{send_id}@creativemojo.co.uk>` header (stored on
  `email_sends.message_id`). New webhook at
  `POST /api/email/resend-inbound` accepts `email.received` events,
  Svix-verifies with `RESEND_INBOUND_WEBHOOK_SECRET`, fetches the full
  message from Resend's `/emails/receiving/{id}` API, matches by
  `In-Reply-To` + `References` headers, and pushes a
  `{type:"replied", direction:"inbound", auto_matched:true}` event
  onto the timeline (also fires the +15 Lead Temperature boost).
  Unmatched replies persist to `email_inbound_unmatched` and surface
  in a new admin tray at `/admin/inbound-unmatched` with Link/Discard
  actions. EmailTimeline shows "auto" vs "manual" badges. Also
  unified outbound: all sends now `From: paul@creativemojo.co.uk` and
  `Reply-To: paul@creativemojo.co.uk` (template `default_from` no
  longer overrides); dropped the implicit `franchises@` BCC to avoid
  self-loops.
  Requires: env var `RESEND_INBOUND_WEBHOOK_SECRET` + an Outlook
  server-side forwarding rule on `paul@` → `creativemojo@*.resend.app`.
  Files: `backend/resend_routes.py`,
  `frontend/src/pages/AdminInboundUnmatchedPage.jsx`,
  `frontend/src/components/EmailTimeline.jsx`,
  `frontend/src/App.js`, `frontend/src/components/Layout.js`.


## Recent (29 Jun 2026)
- ✅ **"New version ready" banner spurious-fire fix** — `BUILD_VERSION`
  was the process start timestamp, so any k8s pod restart (liveness
  probe, OOM, autoscaling) or multi-replica setup produced a different
  version on each `/api/version` poll → banner fired 3-4× per day with
  no actual deploy. Now uses a SHA-256 hash of `server.py` +
  `requirements.txt`, which is stable across pod restarts and identical
  across all replicas serving the same image. Banner now only appears
  when real code ships.
- ✅ **Auto-merge duplicate Gravity Forms submissions** — when the same
  person submits more than one form (e.g. Form 33 quick + Form 17 full
  enquiry), the second submission now folds its richer fields
  (address, county, "Heard about us", phone, etc.) into the existing
  contact instead of being silently skipped. Every merge is logged
  in `merged_from_history` and surfaced on the contact drawer under
  "Auto-merged submissions" so no data is hidden. Refresh button
  toast now shows a "🔗 N duplicate submissions merged" line.
  Files: `backend/gf_backfill.py` (`_merge_into_active_contact`),
  `frontend/src/pages/ContactsPage.js` (drawer panel),
  `frontend/src/pages/FormIntakePage.js` (toast summary).
- ✅ **Kanban Hot-lozenge bulk endpoint fixed** — `/api/contacts/temperatures`
  was shadowed by the earlier-registered catch-all `/api/contacts/{contact_id}`
  (returning 404 "Contact not found"). Renamed bulk route to
  `/api/pipeline/temperatures` and updated `ContactsPage.js` to match.
  The AUTO score chip now renders on every kanban card across all stage
  columns (including Contacted). User must redeploy to push to production.

## Recent (June 2026)
- ✅ **25 Jun 2026 (PM) — Landing Pages + CTA Composer + Phase 4 Lead Temperature**
  • **Public PDF Landing Pages** (`/info/:slug`, no auth) — branded
    viewer with logo, intro, "What's inside" bullets, yellow CTA. Each
    visit + download is tracked, attributed to the originating email
    send via `?t=<send-id>` token.
  • Admin CRUD at `/admin/landing-pages` (slug, title, intro_html,
    bullets, CTA label, R2 file picker, active toggle, live view/download
    counters, expandable Visit Log).
  • `{{landing:<slug>}}` tokens in email templates resolve at send time
    to the public URL + tracking token. Origin is configurable via
    `PUBLIC_BASE_URL` env or falls back to the request's own host.
  • **CTA Composer Modal** replaces the 3 stacked native window.prompt /
    window.confirm calls with a single in-app dialog. Three sources:
    Landing Page (dropdown of active pages) · R2 File (existing browser)
    · External URL.
  • **Phase 4 Lead Temperature**: `GET /api/contacts/{id}/temperature`
    scores opens (+2, cap 6), clicks (+5, cap 15), landing-page views
    (+3, cap 9), downloads (+8, cap 16). Events older than 30 days are
    halved. Bands: Hot ≥ 15, Warm 8–14, Cold 0–7. New
    `LeadTemperatureBadge.jsx` chip on the contact drawer (read-only,
    sits alongside the manual flame).
  • All verified by testing_agent_v3_fork iteration_32 (100% pass).
- ✅ **25 Jun 2026 — Per-franchisee Activity & Logs + Login tracking**
  • New `auth_logins` collection: every successful AND failed `/auth/login`
    attempt recorded with role, email, IP, user-agent, franchisee_id.
  • New `GET /api/admin/auth/login-log?franchisee_id=&outcome=` endpoint.
  • Added optional `franchisee_id` filter to existing
    `/admin/announcements/reads`, `/admin/files/download-log`, and
    `/admin/marketing/log` endpoints.
  • New `LoginLog.jsx` component (with success/failed filter chips).
  • Existing 3 log components now accept optional `franchiseeId` prop;
    column hidden when scoped.
  • "Activity & Logs" panel added to `FranchiseeDetailPage.js` with 4
    collapsible sub-logs (Logins, HQ Updates, File downloads, Marketing).
  • Global Logs page now lists Login activity at the top.
- ✅ **25 Jun 2026 — Email-template File Picker: full R2 folder browser**
  • FilePickerModal in EmailTemplatesPage gained Browse/Search tabs.
  • Browse mode uses `/api/files/tree?prefix=…` with breadcrumbs so admins
    can drill into `admin/franchise-sales-pdf/…` and other private folders.
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
- ✅ **Iteration 24 (19 Jun 2026) — Form 33 intake fix + Pipeline Maintenance UI**
  • Root cause of "no Form 33 leads in NEW column": field-ID mapping in
    gf_backfill.py was using flat keys (5/7) but Form 33 uses GF composite
    dotted keys (5.3 for Name, 7.5 for Postcode). All 3 stub Form 33
    rows (Lisa, Paul, Donna) were in the DB but had null first/last_name,
    so were invisible on the kanban.
  • Fixed FIELD_LABELS_BY_FORM[33] mapping + Form 33 extraction in
    run_backfill (splits "5.3" full-name into first+last). Live webhook
    in server.py also gains a "split full-name into first+last" safety
    pass when last_name comes back null.
  • New GET /api/intake/backfill/diagnose/{form_id} endpoint — calls GF
    REST API directly and reports per-entry verdict (would_insert /
    already_in_db / skip_spam_filter / skip_tombstoned) plus the raw
    field IDs. Indispensable for future "why isn't form X arriving?" bugs.
  • New POST /api/intake/backfill/contacted-to-dormant?cutoff_days=60 —
    moves stale "Contacted" leads (no human touch + arrival date > 60d)
    into "Dormant". Reversible. On Preview reduced Contacted column from
    597 → 67 (530 moved to Dormant). Idempotent.
  • FormIntakePage.js gains a "Pipeline Maintenance" panel with three
    buttons: Refresh from Gravity Forms, Archive Contacted > 60d → Dormant,
    Diagnose a Form. Removes need for console snippets.
  • `_repair_pipeline_membership` confirmed permanently disabled (kept
    as no-op) — caused the 951-row resurrection in iter 23.
- ✅ **Iteration 28 (20 Jun 2026) — Global Follow-up Nag popup**
  • New ``followup_tasks`` MongoDB collection — when an admin clicks
    "Remind" on the Contract Renewals page, a follow-up task is now
    auto-created (idempotent on contract_id) with ``due_at`` set
    3 days out. ``mark-contacted`` unmark also clears any pending
    follow-up so undo round-trips cleanly.
  • New endpoints:
    - ``GET  /api/followup-tasks/due`` — admin only, lists tasks
      whose due_at has passed (oldest first).
    - ``POST /api/followup-tasks/{id}/actioned`` — archives to
      ``followup_tasks_done`` (audit trail) and removes the nag.
    - ``POST /api/followup-tasks/{id}/snooze`` — pushes ``due_at``
      forward by ``hours`` (default 24, clamped 1h..30d).
  • New ``<FollowupNagger />`` component mounted in the admin
    ``Layout``. Polls ``/followup-tasks/due`` every 60s and shows a
    sticky bottom-right card with one row per due task. Each row has
    Actioned / Snooze 1d / Snooze 1w buttons. Card is collapsible
    (preference persists per session) but stays mounted so the
    admin can always see how many follow-ups are in flight.
  • Schema is generic on ``kind`` so future "I'm awaiting a reply"
    flows (welcome emails, invoice nudges, etc.) can reuse the same
    popup without code changes.
  • Verified end-to-end: mark-contacted → task created with due_at
    +3d; force-due then poll surfaces it; Actioned removes it
    (audit kept); Snooze 1d pushes it out of due window.

- ✅ **Iteration 27 (19 Jun 2026) — Pre-go-live franchisee readiness check**
  • Comprehensive testing-agent end-to-end pass before Foteini's first
    login: portal login (2-step), File Vault access (incl. cross-
    franchisee permission denial), Territory map, HQ Updates, Logout,
    admin sanity all PASS.
  • Added ``/portal/calendar`` → ``/portal/events`` Navigate redirect.
  • Normalised the historic ``must_change_password`` vs
    ``force_password_change`` naming drift.
  • Handover emails BCC paul@creativemojo.co.uk for off-system audit
    trail (silent — invisible to recipient).


  • Comprehensive testing-agent end-to-end pass before Foteini's first
    login: portal login (2-step), File Vault access (incl. cross-
    franchisee permission denial), Territory map, HQ Updates, Logout,
    admin sanity all PASS.
  • Sandra demo franchisee verified — login lands on /portal (not
    /admin), sidebar shows My Franchise / Territory / Calendar /
    File Vault / HQ Updates / Account.
  • Project Folder modal (iter-26) verified visually end-to-end:
    opens with folder summary card + List/Grid toggle + DOWNLOAD ALL
    AS ZIP + per-file downloads. Both view modes render correctly.
  • Added ``/portal/calendar`` → ``/portal/events`` Navigate redirect
    so any legacy URL in handover emails / docs still lands on the
    right page.
  • Normalised the historic ``must_change_password`` vs
    ``force_password_change`` naming drift — admin users-list and
    ``_user_doc_to_response`` (login + me) now BOTH return both
    fields as equivalent booleans, plus ``handover_pending`` is
    surfaced consistently.
  • Cleaned up the 4 stale ``password_reset_requests`` rows left
    behind by the testing agent (rejected, preserves audit trail).
  • Backend ZIP-stream perf flagged for follow-up: streaming the
    full ``shared/`` (6.4 GB / 1217 files) saturates a worker —
    consider async job + signed URL for the next iteration.

- ✅ **Iteration 26 (19 Jun 2026) — Calendar Project Folder modal aligned with HQ Updates UX**
  • Calendar → "Projects this month" → "Open Project Folder"
    (renamed from "Open Project Guide") now opens a modal that
    mirrors the look and feel of ``PublicFolderSharePage``
    ("Hello Summer"-style).
  • Folder summary card + List/Grid toggle (preference persists
    per browser) + per-file Download buttons + "Download all as
    ZIP" CTA streaming via ``/api/files/folder-zip``.
  • Grid view shows real thumbnails for images + first-page PDF
    previews via pdfjs-dist (lazy IntersectionObserver-driven).
  • Backend untouched — same listing / download / zip endpoints
    used everywhere else in the file vault.


  • Calendar → "Projects this month" → "Open Project Folder" (renamed
    from "Open Project Guide") now opens a modal that mirrors the
    look and feel of the public ``PublicFolderSharePage`` ("Hello
    Summer"-style): folder summary card, List/Grid toggle (preference
    persists per browser), per-file Download buttons, and a single
    "Download all as ZIP" CTA that streams via the existing
    ``/api/files/folder-zip`` endpoint.
  • Grid view shows real thumbnails for images + first-page PDF
    previews via pdfjs-dist (lazy IntersectionObserver-driven). All
    other file types fall back to a coloured icon.
  • Old "PDF iframe on left + thin sidebar on right" layout removed
    — replaced by the unified folder browser so franchisees get one
    consistent file-browsing experience whether the files came from
    HQ Updates or a Calendar project link.
  • Backend untouched. Same ``/portal/projects/{code}/files`` listing
    + ``/files/download`` signed-URL minting + ``/files/folder-zip``
    streaming used everywhere else.

- ✅ **Iteration 25 (19 Jun 2026) — Manage Gravity Forms admin tool**
  • Form intake config moved from hardcoded ``form_intake_config.py`` +
    ``gf_backfill.py if form_id == X:`` ladder to a MongoDB-backed
    ``gf_form_configs`` collection. Static module kept as a safety
    fallback if a form's DB row is missing.
  • New module ``gf_form_config_db.py`` owns the schema, seed
    migration (forms 1/17/32/33 auto-inserted on first boot), CRUD
    helpers, generic ``extract_from_entry`` and ``auto_guess_field_map``.
  • New endpoints under ``/api/intake/forms-config``:
    - ``GET    /``            list all configured forms
    - ``GET    /{id}``        single config
    - ``POST   /``            create
    - ``PUT    /{id}``        update
    - ``DELETE /{id}``        remove
    - ``GET    /{id}/discover``  fetch GF form metadata + auto-guess field map
    - ``POST   /{id}/preview``   dry-run last 10 entries through any
                                 config (saved OR unsaved) — returns
                                 per-entry outcome predictions
  • ``run_backfill`` now reads field mappings from the DB. The legacy
    if-ladder remains as a safety net.
  • New ``<ManageFormsPanel />`` React component on Form Intake page:
    table of configured forms with badges (category + pipeline?),
    Add/Edit modal with autodetect button, Preview panel with table
    of dry-run outcomes. Email is required; first_name OR full_name
    must be set.
  • Categories supported: Franchise (pipeline), Licence (pipeline),
    Care Home, Art Kit, General (contacts only).
  • Verified end-to-end: existing 4 forms behave identically; CRUD +
    preview + discover all work; invalid configs (missing email) get
    400'd; deleting + re-adding doesn't lose data.
  • Adding a new Gravity Form is now: click Add → enter ID → click
    Auto-detect → review → Test Import → Save. No code, no deploy.

- ✅ **Iteration 24.3 (19 Jun 2026) — THE actual Form 33 fix**
  • Real root cause #1 (revealed by the per-entry traces in v24.2):
    Production's ``GF_BACKFILL_FORM_IDS`` env var was set to ``1,17,32``
    — i.e. FORM 33 WAS NEVER BEING PULLED FROM THE GF REST API.
    Preview's env had ``1,17,32,33``, which is why Preview worked and
    Production didn't. The traces showed 134 entries processed across
    forms 1/17/32 and exactly zero from form 33.
  • Fix: env-var union with ``backfill_form_ids()`` instead of an
    override. The env var can now only ADD forms, never subtract.
    Production's stale env value is now harmless.
  • Real root cause #2 (collateral damage from v24.2's promotion path):
    the email-promotion logic fired regardless of whether the inbound
    GF entry was franchise/licence-eligible. A 2025 Form-1 art-kit
    enquiry from Sanora Carrozza matched an old dormant row by email
    and got promoted to NEW even though art_kit_enquiry isn't a
    pipeline source.
  • Fix: ``re_engaged_by_email`` now also requires
    ``in_pipeline_flag=True`` for the inbound entry. Care-home /
    art-kit / general-contact submissions can no longer promote
    historic rows into NEW.
  • New ``POST /api/intake/backfill/undo-bad-art-kit-promotion`` — one-shot
    repair to pull any wrongly-promoted (non-franchise/licence) row
    back OUT of the NEW column. Idempotent.
  • UI gains a 4th maintenance button ("Remove non-pipeline rows from
    NEW") for the cleanup. Refresh result now also reports
    ``form_ids_used`` so an env mis-config will never be invisible
    again.
  • Verified end-to-end on Preview with ``GF_BACKFILL_FORM_IDS=1,17,32``
    (production-shape env): form 33 forced into pull list, Lisa
    inserted, Paul promoted from existing care-home row, Donna
    inserted, zero bad cross-form promotions.

## P1 — Upcoming
- **Mobile-friendly Admin Sales Pipeline (Tier A)**: hide Dormant/Lost on `<sm`,
  4-col KPIs, snap-scroll kanban, header wrap
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
