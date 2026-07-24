"""Contract-template placeholder registry.

Central list of the merge-field tokens the Template Editor can insert.
Each entry describes:

- ``token``          : the exact string inside ``{{...}}`` in the HTML.
- ``label``          : human label for the editor's insert menu.
- ``source_field``   : the field on the franchisee / issued-contract that
                        Phase 2's populate step will read from.
- ``sample_value``   : shown in the digital / PDF preview so the reader
                        sees a realistic layout while HQ is still editing.

To add a new placeholder in the future, append one entry here. No editor
rebuild, no schema change, no route change is required.
"""
from typing import List, Dict


PLACEHOLDER_REGISTRY: List[Dict[str, str]] = [
    # --- Party identity -----------------------------------------------------
    {"token": "franchisee_name",       "label": "Franchisee name",       "source_field": "franchisee.full_name",   "sample_value": "Jane Sample"},
    {"token": "business_name",         "label": "Business name",         "source_field": "franchisee.organisation","sample_value": "Creative Mojo (Sample) Ltd"},
    {"token": "address",               "label": "Address",               "source_field": "franchisee.address",     "sample_value": "1 Sample Street, Sampletown"},
    {"token": "postcode",              "label": "Postcode",              "source_field": "franchisee.postcode",    "sample_value": "SA1 1SA"},
    {"token": "email",                 "label": "Email",                 "source_field": "franchisee.email",       "sample_value": "jane@sample.co.uk"},
    {"token": "telephone",             "label": "Telephone",             "source_field": "franchisee.telephone",   "sample_value": "01234 567 890"},

    # --- Territory ----------------------------------------------------------
    {"token": "territory",             "label": "Territory description", "source_field": "contract.territory_snapshot.summary", "sample_value": "Sample Territory"},

    # --- Contract term & fees ----------------------------------------------
    {"token": "contract_start_date",   "label": "Contract start date",   "source_field": "contract.start_date",     "sample_value": "1 January 2026"},
    {"token": "contract_end_date",     "label": "Contract end date",     "source_field": "contract.end_date",       "sample_value": "31 December 2030"},
    {"token": "contract_length",       "label": "Contract length",       "source_field": "contract.term_length",    "sample_value": "5 years"},
    {"token": "purchase_fee",          "label": "Purchase fee",          "source_field": "contract.purchase_fee",   "sample_value": "£15,000"},
    {"token": "monthly_fee",           "label": "Monthly fee",           "source_field": "contract.monthly_fee",    "sample_value": "£250"},
    {"token": "renewal_fee",           "label": "Renewal fee",           "source_field": "contract.renewal_fee",    "sample_value": "£3,500"},

    # --- Reference ----------------------------------------------------------
    {"token": "contract_reference",    "label": "Contract reference",    "source_field": "contract.reference",      "sample_value": "CM-2026-000123"},
]


def registry() -> List[Dict[str, str]]:
    """Public accessor — callers should treat the returned list as read-only."""
    return list(PLACEHOLDER_REGISTRY)


def sample_values() -> Dict[str, str]:
    """Convenience map used by the preview substitution step."""
    return {p["token"]: p["sample_value"] for p in PLACEHOLDER_REGISTRY}


VALID_TOKENS = frozenset(p["token"] for p in PLACEHOLDER_REGISTRY)
