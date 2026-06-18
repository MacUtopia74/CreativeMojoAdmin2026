"""Single source of truth for Gravity Forms intake configuration.

Shared between ``server.py`` (which routes live webhook posts) and
``gf_backfill.py`` (which periodically pulls entries from the GF REST API
as a safety-net). Keeping the form-ID list here means adding a new
Gravity Form to the CRM intake requires a one-line code change here —
no env-var update in production, preview AND local at the same time.
"""
from __future__ import annotations

# Form ID → CRM source category. Add new Gravity Forms here.
#   1  = General Contact Form (catch-all, sub-routed via FORM1_REASON_TO_SOURCE)
#   17 = Franchise Enquiry (long form, footer / main page)
#   32 = Licence Enquiry
#   33 = Franchise Enquiry (short popup form, launched June 2026)
FORM_ID_TO_SOURCE: dict[int, str] = {
    1:  "general_enquiry",
    17: "franchise_enquiry",
    32: "licence_enquiry",
    33: "franchise_enquiry",
}

# Subset of FORM_ID_TO_SOURCE whose submissions are dropped straight into
# the active Sales Pipeline as "New" — fresh leads requiring triage.
FORM_IDS_IN_PIPELINE: set[int] = {17, 32, 33}

# Form 1 (General Contact) sub-routes via its "Reason for contacting"
# dropdown so e.g. care-home and art-kit enquiries land in their own
# tabs instead of polluting the franchise pipeline.
FORM1_REASON_TO_SOURCE: dict[str, str] = {
    "franchise enquiry":            "franchise_enquiry",
    "licence enquiry":              "licence_enquiry",
    "care home class enquiry":      "care_home_enquiry",
    "deliverable art kit enquiry":  "art_kit_enquiry",
    "other":                        "general_enquiry",
}

# Source categories shown in the sales kanban. Everything else is
# reference-only data on the Contacts page.
PIPELINE_SOURCES: set[str] = {"franchise_enquiry", "licence_enquiry"}


def backfill_form_ids() -> list[int]:
    """Form IDs the periodic GF backfill task should pull. Excludes form 1
    because the general contact form is too noisy to backfill (most rows
    are non-CRM enquiries) and any real franchise/licence enquiries that
    slip through it are recoverable manually."""
    return sorted(fid for fid in FORM_ID_TO_SOURCE if fid in FORM_IDS_IN_PIPELINE)
