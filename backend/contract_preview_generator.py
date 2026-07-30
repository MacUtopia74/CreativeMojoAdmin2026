"""Whole-document sample-preview PDF generator (Phase 1B — thin wrapper).

Delegates to the shared ``contract_render_engine`` in ``mode='preview'``
(lenient) so all preview-time behaviour lives in one place. This
module retains the Phase 1B public surface (``generate_sample_preview``,
``synthetic_default_for``, ``compose_single_line_address``,
``sanitise_filename_component``) so the CMS evidence-pack builder and
existing Phase 1B tests keep working unchanged.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

import contract_render_engine as engine

# Re-export helpers that other modules may already import.
sanitise_filename_component = engine.sanitise_filename_component
WATERMARK_TEXT = engine.WATERMARK_TEXT
# Backwards-compat alias for the per-marker PNG preview endpoint.
_write_value = engine.write_value


# ---------------------------------------------------------------------------
# Synthetic sample values (preview-only)
# ---------------------------------------------------------------------------
_SYNTHETIC_DEFAULTS: Dict[str, str] = {
    "string":         "Sample value",
    "multiline_text": "Sample line one\nSample line two\nSample line three",
    "date":           "31 December 2026",
    "currency":       "£1,234.56",
    "integer":        "5",
    "decimal":        "5.00",
    # Hyperlinks appear as a dict — never a plain string.
    "hyperlink":      {"url": "https://hub.creativemojo.co.uk/agreed-territory/sample/token",
                       "display": "View Agreed Territory Map"},
}


def compose_single_line_address(
    street: Optional[str] = None,
    city: Optional[str] = None,
    county: Optional[str] = None,
    postcode: Optional[str] = None,
    country: Optional[str] = None,
) -> str:
    parts = [
        (street or "").strip(),
        (city or "").strip(),
        (county or "").strip(),
        (postcode or "").strip(),
        (country or "").strip(),
    ]
    return ", ".join(p for p in parts if p)


def synthetic_default_for(code: str, data_type: str):
    """Preview-only synthetic default. Never used in production."""
    if code == "FRANCHISEE_LEGAL_NAME":
        return "Sample Franchisee Limited"
    if code == "FRANCHISEE_FIRST_NAME":
        return "Sample"
    if code == "FRANCHISEE_LAST_NAME":
        return "Franchisee"
    if code == "FRANCHISEE_FULL_NAME":
        return "Sample Franchisee"
    if code == "FRANCHISEE_ORGANISATION":
        return "Creative Mojo Sample Area"
    if code == "FRANCHISEE_EMAIL":
        return "sample@creativemojo.co.uk"
    if code == "FRANCHISEE_MOBILE":
        return "07000 000000"
    if code == "FRANCHISEE_ADDRESS_STREET":
        return "1 Sample Street"
    if code == "FRANCHISEE_CITY":
        return "Sampletown"
    if code == "FRANCHISEE_COUNTY":
        return "Sampleshire"
    if code == "FRANCHISEE_POSTCODE":
        return "SM1 1PL"
    if code == "FRANCHISEE_ADDRESS_BLOCK":
        return compose_single_line_address(
            street="2, Wordsworth Cottages",
            city="Robertsbridge",
            county="East Sussex",
            postcode="TN32 5JG",
            country="United Kingdom",
        )
    if code == "FRANCHISE_NUMBER":
        return "0099"
    if code == "CONTRACT_REFERENCE":
        return "CM-2026-0099"
    if code in ("AGREEMENT_DATE", "COMMENCEMENT_DATE", "TERM_START_DATE"):
        return "1 August 2026"
    if code == "RENEWAL_DATE":
        return "31 July 2031"
    if code == "MONTHLY_FEE":
        return "£113.30"
    if code == "RENEWAL_FEE":
        return "£500.00"
    if code == "CONTRACT_TERM_YEARS":
        return "5 years"
    if code == "HQ_SIGNATORY_NAME":
        return "Sample HQ Director"
    if code == "HQ_SIGNATORY_TITLE":
        return "Director"
    if code == "TERRITORY_MAP_URL":
        return {
            "url": "https://hub.creativemojo.co.uk/agreed-territory/sample/token",
            "display": "View Agreed Territory Map",
        }
    return _SYNTHETIC_DEFAULTS.get(data_type, f"[SAMPLE {code}]")


def generate_sample_preview(
    source_bytes: bytes,
    markers: List[Dict[str, Any]],
    values: Optional[Dict[str, Any]],
    template_name: str,
) -> Tuple[bytes, Dict[str, Any]]:
    """Return ``(preview_pdf_bytes, generation_report)``.

    ``source_bytes`` is treated as read-only; the engine opens them via
    a ``BytesIO`` stream. Missing values are filled with synthetic
    defaults so HQ can review layout without a real franchisee record.
    """
    values = dict(values or {})
    values_map: Dict[str, Any] = {}
    for m in markers:
        code = m.get("code") or ""
        if code in values and values[code] is not None:
            values_map[code] = values[code]
        else:
            values_map[code] = synthetic_default_for(
                code, (m.get("data_type") or "string").lower(),
            )
    pdf_bytes, report = engine.render(
        source_bytes,
        markers,
        values_map,
        mode="preview",
        template_name=template_name,
    )
    # Legacy-report field aliases so existing callers/tests keep working.
    report["preview_byte_size"] = report["byte_size"]
    return pdf_bytes, report
