# Creative Mojo — Admin & Franchisee Hub PRD
- ✅ **CMS Phase 1B post-Stop-Point-3 corrections — Overflow surfacing, Match-source, single-line address (Feb 2026)**
  HQ found two issues in the first Stop Point 3 review: (1) the engine was silently shrinking overlay text down to 7pt when it didn't fit; (2) `FRANCHISEE_ADDRESS_BLOCK` was authored multiline while the contract only allows a single line. Fixed both.
    • **Address block**: now a single-line comma-joined value —
      `compose_single_line_address(street, city, county, postcode, country)`
      in `contract_preview_generator`. Blank / whitespace-only
      components are omitted cleanly (no double commas, no trailing
      separator). Marker library `FRANCHISEE_ADDRESS_BLOCK` updated to
      `data_type=string`, `format={casing: as_is, join: ", "}`, and
      carries `default_presentation={wrapping: no_wrap, alignment:
      left, min_font_size: 11}`. One-shot idempotent migration in
      `seed_library()` upgrades pre-existing system-seeded entries;
      HQ-edited library entries are never touched.
    • **Library-level presentation defaults**: Marker Library entries
      can now carry a `default_presentation` block that is applied to
      new detections. `_apply_library_presentation_defaults()` only
      fills fields still None per occurrence — HQ overrides are
      respected. Wired into upload-marker-pdf and
      backfill-bbox-split.
    • **Overflow tracking**: every `sample-preview.pdf` and
      `sample-preview.png` render persists a per-occurrence
      `last_render_report: {overflow, final_size, overlay_family,
      overlay_display, substitution_required, computed_at}`. Surfaced
      in `marker-summary` for the UI. Per-marker PNG response headers
      also expose `X-Overflow` and `X-Final-Size`.
    • **UI**: red dot in the occurrence list for any occurrence with
      `overflow=true`; a prominent red warning banner in the property
      panel citing the current `min_font_size` and prescribing "enlarge
      the box, reposition, enable wrapping, or lower min size — but
      NEVER let it silently shrink"; new **Match Source** button
      one-clicks `font_size_override = source font_size` AND
      `min_font_size = source font_size` so the engine refuses to
      shrink below the contract-specified size. Green "Fits at Npt"
      chip when render succeeds.
  **Testing evidence**: 13 new tests in `test_address_and_overflow.py`
  covering the address composer edges, library-defaults application
  (with HQ-override respect), overflow persistence via
  sample-preview.pdf, forced overflow via tight render_bbox, PNG
  endpoint header exposure, and widen-clears-overflow. **91 backend
  tests total green** across the CMS Phase 1B suite (was 78 pre-fix).
  Paloma reset via backfill — address occurrence now correctly picks
  up `min_font_size=11`, `wrapping=no_wrap`, `alignment=left` from the
  library.

- ✅ **CMS Phase 1B Turn C.5 + Turn D — Duplicate Settings + Stop Point 3 Evidence Pack (Feb 2026)**
  Closes out Phase 1B ahead of Stop Point 3 sign-off.

  **Turn C.5 — Presentation fields + Duplicate shortcut**
    • Four new per-occurrence fields (all optional, backwards-compat):
      `wrapping` (`wrap`|`no_wrap`|`clip`), `max_lines` (int 0..200),
      `casing` (`none`|`upper`|`lower`|`title`|`sentence`),
      `overlay_font_family_override` (12 embeddable PDF base14 fonts).
      All honoured by `contract_preview_generator._write_value`.
    • Property panel gains four new dropdowns/inputs plus **Duplicate to
      next / Duplicate to all later** buttons.
    • Backend:
        - `GET /admin/contract-templates/{id}/markers/{oid}/duplicate-preview?scope=next|all_later`
          returns source, target list (ordered by page then y0),
          settings to copy, and a `never_altered` audit list.
        - `POST /admin/contract-templates/{id}/markers/{oid}/duplicate-settings`
          `{scope: "next"|"all_later"}` writes strictly-whitelisted
          fields (`alignment`, `font_size_override`, `min_font_size`,
          `wrapping`, `max_lines`, `casing`,
          `overlay_font_family_override`).
    • Invariants (verified by tests): `token_bbox`, `render_bbox`,
      `page`, `occurrence_id`, `code`, and source font metadata are
      NEVER touched by the duplicate action. Substitution ack stays at
      font-family level (untouched).
    • Confirmation dialog surfaces exact target occurrences + emerald
      "Never altered" disclaimer before HQ commits.

  **Turn D — Audit log + Stop Point 3 evidence pack**
    • New `contract_template_audit` collection. Every mutating action
      writes `{template_id, action, actor, at, before, after, extra}`.
      Wired into PATCH / POST-add / DELETE marker, substitution ack
      toggle, duplicate-settings apply, and evidence-pack generation.
    • `GET /admin/contract-templates/{id}/audit-log?limit=200` for UI
      display; audit drawer inside the Marker Review modal shows the
      last 200 entries with pretty-printed JSON extras.
    • `POST /admin/contract-templates/{id}/evidence-pack` returns a
      ZIP containing:
        - `README.md` — human-readable index with SHA-256, marker
          count, audit row count, generation timestamp
        - `manifest.json` — machine-readable snapshot (template
          metadata, all markers with token_bbox+render_bbox, marker
          summary, cross-line errors, substitution acknowledgements,
          preview report, invariants)
        - `source.pdf` — byte-identical source
        - `preview.pdf` — freshly generated sample preview
        - `markers.csv` — flat CSV for spreadsheet review
        - `audit_log.jsonl` — one JSON per historic action
    • Pack generation is itself audited (`evidence_pack.generate`
      row with `pack_id`).
    • Response headers: `X-Pack-Id`, `X-Marker-Count`,
      `X-Audit-Row-Count`, `X-Source-Sha256`.

  **Testing evidence:**
    - 17 new HTTP E2E tests in `test_phase1b_turn_c5_and_d.py` covering
      PATCH-and-reject for all new fields, duplicate-preview both
      scopes, duplicate-apply immutability invariant, audit-log
      capture, evidence-pack ZIP structure + headers, and preview
      generator honouring casing/max_lines.
    - 15/15 Playwright UI scenarios pass on Paloma (report
      `iteration_50.json`): new controls, duplicate confirmation
      dialog + never-altered disclaimer, audit drawer, evidence-pack
      button, full regression of Turn C features, and the critical
      token_bbox non-draggable invariant.
    - **Total: 78 backend tests green (42 pipeline + 19 Turn B + 17
      Turn C.5+D) + 30 Playwright UI scenarios green** across the
      phase. Paloma template reset via backfill after each test run.
    - **Stop Point 3 EVIDENCE PACK is now live and downloadable from
      the Marker Review workspace.**

- ✅ **CMS Phase 1B Turn C — Visual Marker Review UI (Feb 2026)**
  Full-screen modal invoked from the template detail page's `Marker
  Review` button. Renders the source PDF with `pdfjs-dist@3.11.174`
  (worker served from `/pdf.worker.min.js`) and overlays each
  occurrence's `render_bbox` as a draggable/resizable `react-rnd` box.
  `token_bbox` is shown as a read-only dashed-red indicator only when
  its occurrence is selected — it has `pointer-events:none` so it
  cannot be dragged or resized (Turn A redaction invariant preserved).
  **Right sidebar features:**
    • Property panel — `[[CODE]]`, page, source font family, live
      per-marker preview PNG (auto-refetched on any change), alignment
      buttons (left/center/right/justify), size override + min size
      number inputs, and the read-only token_bbox + render_bbox
      coordinates.
    • Substitution acknowledgements — one row per source font family
      with per-group checkbox (only shown when `substitution_required`
      is true), plus **bulk "Acknowledge all → <overlay family>"**
      shortcut that appears when 1+ pending required group shares the
      same overlay family. Bulk confirm dialog shows exact source
      families and total occurrence count; each ack is written via a
      separate POST so per-family `acknowledged_by` / `acknowledged_at`
      audit trail is preserved.
    • Occurrence list — full navigation across all pages with amber
      highlight for the selected row.
  **Toolbar:** page prev/next, zoom in/out (50%..300%), Add-mode toggle
  (with library-code selector), whole-document Preview PDF download.
  **Add flow:** click Add → pick a code → click on canvas to place a
  new occurrence (140×20 pt default box). `manually_added` chip
  distinguishes it in the sidebar.
  **Delete flow:** trash icon on property panel → confirm dialog
  (data-testid=`mr-delete-confirm`).
  **Testing evidence:** 15 Playwright E2E scenarios all pass on
  Paloma template (7 occurrences · 5 pages) — modal open, PDF render,
  selection, page nav, token_bbox indicator, property-panel controls,
  refresh preview, add + delete, cancel-add, zoom, page nav, whole-doc
  download, X-button + backdrop close, parent-page regression, and the
  critical **token_bbox non-draggable invariant** (coordinates verified
  unchanged after 200px drag attempt). Backend surface unchanged since
  Turn B — 42 unit + 19 HTTP tests still green (61 total).

- ✅ **CMS Phase 1B Turn B — Occurrence CRUD, Substitution Ack, Per-marker PNG (Feb 2026)**
  Backend foundation for the visual Marker Review UI (Turn C):
    • Each `MarkerOccurrence` now carries a stable `occurrence_id`
      (UUID), plus editable overlay controls: `alignment`,
      `font_size_override`, `min_font_size`, `manually_added`. Existing
      markers get IDs lazily on first read (idempotent migration).
    • **CRUD routes** (all admin-only):
        - `PATCH /admin/contract-templates/{id}/markers/{occurrence_id}`
          — edits `render_bbox`, `alignment`, `font_size_override`,
          `min_font_size`. `token_bbox` is *never* editable.
        - `POST /admin/contract-templates/{id}/markers` — manually add
          an occurrence for the Word-swallowed-token case; validates
          code against live Marker Library, page against page count,
          bbox geometry.
        - `DELETE /admin/contract-templates/{id}/markers/{occurrence_id}`
          — removes a false-positive or manually-added occurrence.
    • **Substitution acknowledgements** — grouped per source
      `font_family`. `marker-summary` now returns
      `substitution_groups[]` with `substitution_required`,
      `occurrence_count`, `acknowledged`, `acknowledged_by`,
      `acknowledged_at`. Endpoint:
      `POST /admin/contract-templates/{id}/substitution-acknowledgements`.
      Response also carries `all_substitutions_acknowledged` for the
      publish-gate.
    • **Per-marker sample-preview PNG** — cropped preview centred on
      the marker: `GET /admin/contract-templates/{id}/markers/{oid}/sample-preview.png?dpi=180&pad=24`.
      Applies redaction + overlay for that one marker only, clips to
      `render_bbox` + padding. Returns PNG + `X-Marker-Code`,
      `X-Marker-Page`, `X-Marker-Occurrence-Id` headers.
  **Testing evidence**: 19 new HTTP E2E tests
  (`test_phase1b_turn_b.py`) — CRUD happy paths + validation edges
  (bad alignment, inverted bbox, unknown code, page out of range),
  substitution ack toggle round-trip, PNG magic-bytes check + dpi
  clamp, and unauth-denied. Existing 42 Phase 1A/B unit tests still
  green. Total: 61 tests, all passing. Turn C (frontend UI) awaiting
  user go-ahead.

- ✅ **CMS Phase 1B Turn A — Redaction bbox split (Feb 2026)**
  Fixed the P0 redaction bug where PyMuPDF's `apply_redactions()` was
  destroying surrounding text (e.g. "AGREEMENT DATED " being erased
  alongside `[[AGREEMENT_DATE]]`). Every marker now carries two
  bounding boxes:
    • `token_bbox` — character-tight union around `[[MARKER_CODE]]`
      glyphs only, sourced from PyMuPDF `rawdict` per-character bboxes.
      Used exclusively for `page.apply_redactions()`.
    • `render_bbox` — span-level union, horizontally clamped to the
      token so long-neighbour-word spans don't inflate the overlay
      area. Used for `insert_textbox()` placement.
    • `bbox` — legacy mirror of `render_bbox` for backwards-compat.
  Preview watermark switched from em-dashes to ASCII hyphens
  (`PREVIEW - NOT FOR ISSUE`) to avoid Helvetica base14 encoding
  artefacts. New idempotent backfill endpoint
  `POST /api/admin/contract-templates/backfill-bbox-split?dry_run=…`
  re-extracts geometry from R2-stored PDFs and rewrites `markers`
  without mutating source bytes. Applied to the Paloma test template
  in Preview environment. 5 new regression tests
  (`test_bbox_split_redaction.py`) + all 37 existing Phase 1A/B tests
  green. Awaiting user visual sign-off before Turn B.

- ✅ **CMS Phase 1A — Fixed-PDF Marker System (24 Jul 2026, Stop Point 2 PASSED)**
  Replaced the Tiptap/DOCX editor architecture with a deterministic
  fixed-PDF `[[MARKER]]` detection system, per the user's revised
  specification and the 12 amendments approved on Phase 0.
    • **New backend modules**:
        - `contract_markers_library.py` — global catalogue with soft-
          delete-only semantics, 28-marker approved seed (17 automatic
          / 9 manual / 2 system_generated), CRUD + hide/unhide +
          usage endpoints, code validation, per-marker
          `eligible_contract_types` + `repeat_allowed`.
        - `contract_markers_pipeline.py` — deterministic detection
          engine (PyMuPDF only, no LLM). Span reconstruction handles
          Word's split-token exports; cross-line and orphan-bracket
          errors surfaced; font family/size/weight/embed metadata
          captured per occurrence; SHA-256 of source bytes recorded.
        - `contract_templates_routes.py` — pruned to Phase 1A surface:
          list, detail, upload-marker-pdf (6-stage async job, no LLM),
          marker-summary, rename, publish (freezes version), archive,
          set-default, duplicate, source-pdf download, integrity-check
          endpoint (on-demand SHA-256 verify against R2), page
          thumbnail with amber overlay.
    • **Marker Library** — global catalogue independent of template
      instances (amendment #2): `library.available` vs
      `library.eligible[]` vs `template_required[]` are four
      independent flags. Contract-type eligibility per marker.
      Content types are `string / multiline_text / date / currency /
      integer / decimal` — no HTML anywhere (amendment #4).
      Soft delete only — hidden flag, in-use guard blocks physical
      delete (amendment #2, #11).
    • **Detection**: LLM-free (amendment #13 hard requirement,
      verified: zero references to `EMERGENT_LLM_KEY` / `litellm` /
      `anthropic` / `openai` in the new pipeline). Detects inline-
      in-sentence markers correctly (amendment #8). Repeat markers
      permitted for identity codes by default (amendment #7).
      Automatic markers with missing Hub values surface as
      `fallback_on_missing="manual_review_required"` never silently
      blanked or invented (amendment #1).
    • **Source PDF preservation** — original bytes stored in R2
      untouched; SHA-256 recorded at upload; on-demand integrity
      check verifies R2 object matches recorded hash. Personalised
      PDF is deliberately NOT generated in Phase 1A (amendment #12).
      R2 Bucket Locks NOT enabled — application works independent
      of them (amendment #10).
    • **Evidence surface**: Marker Summary drawer at
      `/admin/contracts/templates/{id}` shows summary banner
      (ready / not ready), source PDF metadata + SHA-256, integrity-
      check button, categorised marker lists (recognised /
      unrecognised / not-eligible / template-required missing),
      per-page thumbnails with amber marker overlays, full occurrence
      table with page + bbox + font + embed status.
    • **Admin Marker Library UI** at `/admin/markers-library` —
      searchable list of all 28 seed markers with source badges,
      new-marker modal with code validation, hide/unhide toggle,
      contract-type eligibility multi-select. Full visual PDF
      placement editor is deferred to Phase 1B.
    • **Legacy code isolation** (amendment #11): archived under
      `_legacy/` with `__init__` files. Frontend legacy `.jsx`
      renamed to `.jsx.legacy` so webpack skips them. Nothing
      permanently deleted. Tiptap packages still installed
      because `RichTextEditor.jsx` (marketing e-shot, HQ updates)
      shares them — full removal deferred until user Stop Point 4.
    • **Test coverage**: 19 unit tests
      (`test_contract_markers_pipeline.py`) + 28 E2E integration tests
      (`test_phase1a_e2e.py`), **47/47 green**.
    • **Documentation delivered**:
        - `/app/memory/word_authoring_guide.md` — HQ-facing one-pager
        - `/app/memory/r2_bucket_locks_guidance.md` — optional
          hardening reference, no code changes required


- ✅ **CMS Phase 1A — DOCX Import (24 Jul 2026, E2E validated 100%)**
  Word (.docx) is now the PREFERRED source format for contract
  templates. PDF import is retained as fallback. Driven by
  python-mammoth (deterministic, no LLM step).
    • **New backend module** `contract_docx_pipeline.py`:
      - `convert_docx(docx_bytes, upload_image)` returns semantic
        HTML + plain text + warnings + counts of images / tables /
        headings / page-breaks
      - Preprocessor rewrites `word/document.xml` +
        `word/styles.xml` to translate inline paragraph
        alignments (`w:jc`) and explicit page breaks
        (`w:br type=page`) into synthetic named styles
      - Style map covers Word Heading 1–3, plus CM custom styles
        (CoverSheetMainTitle, CoverSheetTitle, CoverSheetParties,
        CoverSheet, Recitals, TOC1/2/3, Header)
      - Post-processors: wrap imported clause numbers in
        `.cm-original-num` grey chips (same as PDF flow); wrap
        every bare block-level `<img>` in `<p class="text-center">`
        so ProseMirror can make them selectable
    • **New backend endpoints**:
      - `POST /api/admin/contract-templates/upload-async` accepts
        `.docx` OR `.pdf` + optional `reference_pdf`; routes to
        the appropriate pipeline based on extension
      - `GET /api/admin/contract-templates/{id}/source-docx`
        returns the original Word source with correct MIME
    • **New template document fields**: `import_type`
      (`"docx"` | `"pdf"`), `source_docx` (metadata),
      `source_pdf.role` = `"source"` or `"reference"` so PDF
      companions attached to DOCX imports are labelled distinctly
    • **Frontend changes**:
      - Upload modal accepts .docx AND .pdf; DOCX / PDF file-kind
        badge; optional Reference PDF picker appears when a .docx
        is selected
      - LegalDocEditor now includes `@tiptap/extension-table` +
        `TableRow` + `TableCell` + `TableHeader` (v3.28 named
        imports), plus a `ResizableImage` extension with width +
        align attributes
      - Amber "Table:" contextual toolbar (add row/col before /
        after, delete row/col, header row toggle, merge/split,
        delete table)
      - Sky-blue "Image:" contextual toolbar (25/50/75/100% resize,
        left/centre/right align, delete)
      - `onSelectionUpdate` re-render hook so both contextual
        toolbars mount/unmount correctly on every selection
        transition (Tiptap v3 React binding needs this)
      - Editor top bar shows the green "DOCX IMPORT" badge, source
        filename, and dual "Source DOCX" + "Reference PDF"
        download buttons
      - WeasyPrint branding CSS mirrors all DOCX-import classes
        (`.cover-title`, `.cover-subtitle`, `.cover-parties`,
        `.recital`, `.toc-1/2/3`, `.text-center/right/justify`,
        table borders, `img[data-align]`) so the PDF preview
        renders identically to the editor
    • **New test suite** `test_contract_docx_pipeline.py`
      (9 cases) plus 2 additional standalone-image tests. Full
      pytest total: **56/56 green** on the 4 required Phase 1A
      suites + 7 iter45 E2E tests.
    • **Real-world validation** — Paloma renewal DOCX (322 KB):
      converted in ~5s, verbatim match **100%**, 4 embedded
      images preserved (Creative Mojo logo, artwork), 5 tables
      preserved and editable, 348 headings preserved, cover-page
      centering + recital italics + TOC indents all render
      correctly in both the editor and the WeasyPrint PDF
      preview.
    • **Explicitly not preserved** (documented up-front to user
      and confirmed): Word auto-TOC field (replaced by our TOC
      node), Word headers/footers (WeasyPrint injects branded
      header/footer), free-floating text boxes / drawing shapes,
      multi-column sections (collapsed to single flow),
      track-changes / comments (stripped).


- ✅ **CMS Phase 1A — Async Upload Pipeline (23 Jul 2026)**
  Replaced the synchronous PDF upload endpoint with an async job
  pattern so long LLM-driven conversions no longer collide with the
  Cloudflare 60s edge timeout.
    • New backend endpoints in `contract_templates_routes.py`:
        - `POST /api/admin/contract-templates/upload-pdf-async`
          (returns `{job_id}` in <200 ms and spawns
          `asyncio.create_task(_run_conversion_job(...))`)
        - `GET /api/admin/contract-templates/upload-jobs/{job_id}`
          for polling
    • New collection `contract_upload_jobs` with schema:
      `{id, status, stage, progress, message, pdf_filename,
      byte_size, template_name, contract_type, template_id, error,
      created_by, created_at, updated_at}`.
    • 6-stage progression exposed to the UI:
      `uploading(5) → extracting(25) → converting(70) →
      verifying(85) → creating(95) → complete(100)` with a `failed`
      terminal state on any error (LLM key missing, extraction
      failure, LLM chunk failure, unexpected exception).
    • New frontend `UploadModal` component in
      `AdminContractTemplatesPage.jsx` — proper modal (no more
      `window.prompt`) with name / contract-type / file inputs,
      client-side validation, a live progress bar + stage list
      (`data-testid='upload-progress-bar'`,
      `data-testid='upload-stage-{code}'` for each stage), auto-nav
      to the editor on complete, retry button on failure, and
      resilient polling (5-attempt backoff before surfacing an
      error) so a single transient 502 during a long LLM chunk no
      longer freezes the visible progress.
    • Sync `POST /upload-pdf` endpoint retained for backward
      compatibility (all 31 existing pytest cases still pass).
    • New test suite `test_contract_templates_upload_async.py`
      (9 cases) covers job doc shape, staged progression, error
      paths, template creation on complete, and non-PDF rejection.
      Combined pytest: **40/40 green**.


- ✅ **CMS Phase 1A — Contract Templates (23 Jul 2026, E2E validated)**
  Full backend + frontend pipeline for authoring legal contract
  templates in-house.
    • **Backend** (`/app/backend/contract_templates_routes.py`,
      `contract_pdf_pipeline.py`, `contract_numbering.py`,
      `contract_placeholders.py`, `contract_branding.py`): 19 admin
      endpoints under `/api/admin/contract-templates/**` covering
      list/CRUD, PDF upload (PyMuPDF extraction → Claude Sonnet 4.5
      HTML cleanup via Emergent LLM Key → verbatim SequenceMatcher
      diff), autosave (PATCH /draft), immutable versioning + rollback,
      approve-conversion (strips imported grey numbering and applies
      authoritative backend 1./1.1/1.1.1 numbering), publish/archive/
      set-default/duplicate/rename, source-PDF download, and
      WeasyPrint PDF preview with Cover + Contents (real
      target-counter page numbers) + running header/footer.
    • **Frontend**: `/admin/contracts/templates` list page and
      `/admin/contracts/templates/:id` Tiptap-based `LegalDocEditor`
      (custom nodes: PlaceholderChip yellow pill, PageBreak,
      TableOfContents). Toolbar: bold/italic/underline, H1-H6,
      lists, text-align, undo/redo, link, page-break, contents,
      placeholder dropdown (14 system placeholders). Diff panel,
      Version History drawer with restore, Save Version, Approve
      Conversion, PDF Preview, Source PDF.
    • **Tests**: `test_contract_preview_toc.py` (4) +
      `test_contract_templates_phase1a.py` (27) — 31/31 green.
    • **Fixes applied during E2E validation** (iteration 42→43):
      P0 fix in `contract_pdf_pipeline.convert_to_html()` (switched
      from non-existent streaming API to `chat.send_message()`),
      P1 fix to WeasyPrint logo path (absolute `file://` URL +
      logo file copied to `/app/backend/static/`), TipTap
      LegalDocEditor extension-text-style import fix + duplicate
      extension cleanup (StarterKit v3 already ships Underline/Link).
    • **Known limitation for Phase 1B**: very large legacy PDFs
      that take >60s to convert hit the Cloudflare edge timeout on
      the client side (backend still writes the template, but the
      browser sees a 502 and the user must refresh the list). To
      be resolved with an async job + polling pattern.
    • **Not yet delivered (Phase 1B / 2)**: contract issuance
      workflow, franchisee portal signing UI, notifications,
      signed-contract storage. Also deferred: `window.prompt` →
      proper Upload PDF modal, publish idempotency micro-fix, admin
      view of "Contents page numbering after real page-breaks" edge
      cases in complex 40+ page contracts.




- ✅ **Recent Lookups on the map + Care Home Contacts split panel + geocode backfill (17 Jul 2026)**
  Two new visualisations both reusing the Territory Builder's
  `TerritoryMap` component (extended with an optional `pins` prop):
    • **Find-a-Class Overview → "Recent Lookups · Map"** — every
      logged public postcode lookup now plotted on the franchise map
      with hit/miss colour coding. Windows: 30d/90d/12m/all. Older
      rows without geocode are gracefully omitted. Endpoint:
      `GET /api/find-class/lookups/map?days=…`. Lookups now also
      persist lat/lng at insert time (was only postcode string before).
    • **Sales & Contacts → Care Home Contacts tab** — split panel:
      list left, map right. Filter bar: Last 30d / Last 12m / Custom
      date range / All time, plus a franchisee-territory dropdown
      (all territories, "Uncovered only", or scope to one franchisee).
      List and map filters stay in lock-step. Pin click opens the
      contact drawer. Endpoint: `GET /api/contacts/map?…` which also
      resolves which franchisee's territory each pin falls inside.
    • **Geocode backfill startup task** — hydrates every enquiry
      postcode that isn't already in `postcodes_cache` via
      postcodes.io bulk API. First boot: 1,501 postcodes cached;
      Care Home plotted rows went 23 → 196 (~91% coverage).
    • **Contact drawer "Plan their territory" card** — when a plan is
      already linked to the contact, the CTA flips to green
      "See linked plan" (with plan name + sector count + shared pill)
      and jumps straight to `?plan_id=<id>` instead of restarting
      the flow. Fixes the Gemma-Louise King confusion where the
      button still read "OPEN BUILDER" after linking.
  Files: `backend/server.py` (contacts/map endpoint + geocode backfill),
  `backend/find_class_routes.py` (lookups/map endpoint + lat/lng on
  insert), `frontend/src/components/territory/TerritoryMap.jsx` (pins
  prop + click handler), `frontend/src/pages/FindClassAdminPage.jsx`
  (LookupsMap sub-view), `frontend/src/pages/ContactsPage.js`
  (CareHomeMapPanel + linked-plan CTA).
  **Feature 3 (parked)**: surface care-home enquiries inside a
  franchisee's MyTerritory+ drop-down as "Customers who have
  contacted" — either matched to their CQC listing or added as a
  potential customer from the enquiry form.
  ⚠️ Production fix requires Save to GitHub → Redeploy.


- ✅ **Franchisee-controlled Mojo page profile + fix public-map data leak (15 Jul 2026)**
  Samantha Whiteman flagged that her private admin email/mobile were
  leaking to the public `creativemojo.co.uk` map popup. Root cause:
  `/api/public/find-class` was projecting the admin-record `email`,
  `mobile_phone`, `telephone`, `home_phone` and `mojo_email` fields
  directly into the popup payload. Rebuilt as an opt-in curation:
    • New fields on `franchisees` doc: `website_email`, `website_phone`,
      `website_bio`, plus three `show_website_*` toggles (all default
      `false`, so the leak stops the moment this ships even for
      franchisees who never log in).
    • Public find-class endpoint stops projecting any admin contact
      fields. Only the curated `website_*` values are surfaced, and
      only when the matching `show_*` flag is true. Adds a new `bio`
      key on the popup payload for the WordPress front-end to render.
    • New `PATCH /api/portal/me/website-profile` — franchisee-only.
    • New "Your Mojo page profile" section on the portal "My Franchise"
      page: bio textarea (4kB cap), phone + email inputs, each with
      its own "Use this X on your Mojo page" checkbox and one Save
      button. Optimistic Save + green tick indicator.
    • WordPress biography one-off importer:
      `POST /api/admin/franchisees/import-website-bios` — accepts a WP
      WXR (XML) export, matches posts to franchisees via wp_page_url
      slug / slugified wp_title / fuzzy title contain. On non-dry-run,
      stamps `website_bio` and flips `show_website_bio=true` (Paul:
      "let's just put those live"). Only touches live franchisees
      (`lifecycle_status != 'ex'`, `tags` contains `Franchisee`).
      Uses XML instead of live scraping because creativemojo.co.uk is
      behind Imunify360 bot protection — WXR export is cleaner + safer.
      Report response lists matched + unmatched + still-missing so
      Paul can spot-check before/after.
  Verified: curl round-trip (toggles ON → payload has values, toggles
  OFF → payload is null on all three fields, name/area/photo still
  populate); dry-run importer against sample WXR matches Anita Priest
  correctly and rejects both the draft and the unrelated post.
  Files: `backend/server.py` (portal PATCH endpoint, importer,
  portal_me projection), `backend/find_class_routes.py` (drop admin
  projection, gated public projection), `frontend/src/pages/portal/PortalDetailsPage.jsx`.
  ⚠️ Production fix requires Save to GitHub → Redeploy, then upload the
  WP XML export via curl or the admin console. Endpoint takes a
  `?dry_run=true` param so Paul can eyeball matches first.


- ✅ **Territory Builder — UK county boundaries overlay + share persistence (09 Jul 2026)**
  Added a "Counties" toggle button (bottom-right of the Territory
  Builder map) that overlays the 73 UK ceremonial counties as a soft
  indigo dashed line + fill + zoom-conditional uppercase label. Toggle
  state is persisted on the plan (`show_counties` field), so when the
  admin flips it on and saves, the public share link (`/share/territory/…`)
  renders the same overlay — perfect for orienting prospective
  franchisees against familiar county names. GeoJSON bundled at
  `/public/uk-counties.geojson` (Douglas-Peucker simplified from the
  evansd/uk-ceremonial-counties dataset, ~900 KB → ~250 KB gzipped).
  Layers are registered once in `style.load` with `visibility: "none"`
  and flipped via `setLayoutProperty`, so the toggle is instant with
  no flicker or re-fetch. Backend: `territory_routes.py`
  (`TerritoryPlanIn.show_counties`, `public_plan` echoes the flag).
  Frontend: `TerritoryMap.jsx` (source/layers + visibility effect),
  `TerritoryBuilderPage.jsx` (state + toggle button + save wiring +
  hydrate from saved plan), `PublicTerritorySharePage.jsx` (respects
  the flag). Verified end-to-end via Playwright + curl round-trip.
  ⚠️ Production fix requires Save to GitHub → Redeploy.


- ✅ **Sales & Contacts — per-tab "new" red badges + bold row highlight (09 Jul 2026)**
  Sandra had no in-app signal for new inbound Care Home / Franchise /
  Licence / Art Kit / General enquiries — only the raw notification
  email. Added a per-contact `seen_at` timestamp (stamped on insert as
  `null` for webhook inbounds; existing 8k+ Airtable/legacy rows were
  back-filled at startup so they don't drown the signal). New API:
  `POST /api/contacts/{id}/mark-seen`. `/api/contacts/counts` now
  returns `new_*` counters per tab. Frontend renders a red pill badge
  (matching the sidebar alert style) next to each Sales & Contacts tab
  when unseen count > 0, and bolds each unseen row with a red-dot
  indicator + subtle red-tinted row background. Opening a row's drawer
  auto-marks it seen (optimistic UI, count decrements immediately).
  Manually-added / imported contacts are stamped as already-seen so
  admin activity doesn't inflate the badge. Verified end-to-end via
  Playwright — badge goes 2 → 1 → row un-bolds on click.
  Files: `backend/server.py` (counts endpoint, mark-seen route,
  startup backfill, insert-time seen_at), `frontend/src/pages/ContactsPage.js`.
  ⚠️ Production fix requires Save to GitHub → Redeploy.


- ✅ **Password reset page auto-redirect to login — P0 fix (08 Jul 2026)**
  Users clicking the branded Resend reset link (`/reset-password?token=…`)
  landed on the reset form for a split second before being bounced to
  `/login`, even in incognito. Root cause: `/reset-password` was missing
  from BOTH public-path allowlists —
  • `AuthContext.js:isPublicPath()` — mounted the reset route as an
    authenticated view and fired `/auth/me`, returning 401.
  • `api.js` axios 401 interceptor — the 401 then triggered
    `/auth/refresh`, which also 401'd, and the fallback branch called
    `window.location.href = "/login"`.
  Added `/reset-password` (and `/dbs/apply/` in AuthContext for parity)
  to all three allowlists. The reset page now loads standalone and
  stays put for unauthenticated users. Verified via Playwright
  screenshot — URL preserved, form visible, no redirect.
  Files: `frontend/src/contexts/AuthContext.js`, `frontend/src/lib/api.js`.
  ⚠️ Production fix requires Save to GitHub → Redeploy.


## Recent (Feb 2026)
- ✅ **Franchisee project-folder grid thumbnails — production whitescreen icons**
  In the franchisee portal Calendar → "Open Project Folder" modal (Grid
  view), every file tile rendered as a red "failed" PDF icon on
  production (`hub.creativemojo.co.uk`). The component
  (`ProjectGuideModal.jsx`) was minting an R2 presigned URL and
  fetching the bytes from the browser to render with pdfjs — that
  browser-side fetch was blocked because the R2 bucket CORS policy
  doesn't allow the production domain (preview's
  `*.emergentagent.com` is allowed, so it worked in dev). Replaced
  the inline pdfjs + signed-URL approach with the existing
  `<FileThumbnail>` component which uses the same-origin authed
  `GET /api/files/thumbnail?key=&size=md` proxy (server-renders to
  JPEG, caches in R2 `_thumbs/`). Side-benefits: no multi-MB PDF
  download per tile, no client-side pdfjs worker, instant subsequent
  loads from the thumbnail cache. Verified end-to-end on Preview —
  Beatles - Abbey Road PDFs now render their first-page previews.
  Files: `frontend/src/components/calendar/ProjectGuideModal.jsx`.
  ⚠️ Production fix requires Save to GitHub → Redeploy.

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
- `{{first_name}}` yellow chip pill in Tiptap WYSIWYG editor

## Recently Shipped (Feb 2026 · Territory Atlas Cache)
- **Phase 1 — Dissolve & simplify polygons.** Server now emits ONE
  dissolved MultiPolygon per franchisee (was: 2000+ per-sector
  features). Simplified at ~5 m tolerance. Payload 10 MB → 5.6 MB
  raw / 2 MB gzip. Features 2099 → 56.
- **Phase 2 — Persistent atlas cache** (`territory_atlas_cache`
  collection). Fingerprint-verified single-doc cache with pre-
  serialised JSON body so cache-hits stream verbatim without
  re-encoding the ~5 MB dict. Server-side response drops from
  ~2.7 s to ~85 ms on warm cache.
- **Phase 3 — Automatic invalidation.** `PUT /territory` and
  `POST /territory/rollback` now return in ~100 ms and schedule the
  atlas rebuild as a background task (`asyncio` `BackgroundTasks`).
  `PATCH /franchisees/{id}` invalidates only if a fingerprint-
  relevant field (org, postcode, franchise_number, tags, lifecycle)
  changes. `POST /territory/atlas/refresh` is the manual belt-and-
  braces button. `asyncio.Lock` coalesces overlapping rebuilds.
- **Phase 4 — Editable overlay pattern.** Territory Builder passes
  `exclude_id` so the franchisee currently being edited is filtered
  out of the atlas backdrop in-memory (O(N) on ~60 items). Their
  editable layer uses the existing live path unchanged.
- **Phase 5 — Browser ETag caching.** Weak ETag = fingerprint +
  variant. `If-None-Match` returns HTTP 304 (0 bytes). Browser
  skips the 5 MB re-parse + Mapbox tessellation on repeat opens.
  `Cache-Control: private, max-age=60, must-revalidate`.
- **Toolbar diagnostic.** Territory Builder shows "ATLAS · N min ago"
  + manual refresh button (⟲) so admins can eyeball freshness.

Result: first map open **30 s → ~1 s**; repeat opens **~50 ms** via
304; territory save unblocked from atlas rebuild (returns in ~100 ms
then rebuilds in the background).

### Care-home overlay in Franchisee's My Territory+ portal
- Extracted `CareHomeEnquiriesOverlay` into `/components/territory/` as a
  reusable render-prop component with a `mode` prop (`admin` | `portal`).
  Admin still hits `/api/contacts/map?...&franchisee_id=`; portal hits
  the new `/api/portal/territory-plus/care-home-enquiries` endpoint
  (auth-scoped so a franchisee can only see their own sectors).
- Wired into `PortalTerritoryPage` for the Territory+ variant only;
  vanilla `/portal/territory/basic` route omits the overlay.
- Same toggle + 4 presets (30d / 12m / Custom / All time) + row-hover
  teal tint + "Try All time" empty-state hint as the admin side.
- Backend endpoint added in `territory_plus_routes.py`, delegates to
  `server._contacts_map_impl` (lazy import to avoid circular dep).
- Verified via testing_agent_v3_fork (iteration_41): 100% pass on both
  portal + admin regression, including gating check that basic route
  hides the overlay.

### Care Home overlay on Admin Franchisee page (redeployed to prod)
- "Show Care Home Enquiries in this area" toggle + date filter +
  compact list on the individual Admin Franchisee Detail page.
- Overlays pins on the *existing* TerritoryMap (Option B — no second
  map instance) via a new `extraPins` prop on FranchiseeTerritoryWidget.
- Verified via testing_agent_v3_fork (iteration_40): 100% pass.


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
