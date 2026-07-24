"""Contract Value Resolver — Phase 1C Turn B.

Turns a (template, contract, franchisee) triplet into a **fully-typed,
formatted set of marker values** and freezes them BY VALUE into the
contract's ``contract_variables`` snapshot. Once frozen, downstream
edits to the franchisee's live Hub profile do NOT alter the contract —
only an explicit HQ ``refresh`` (with a written reason) can update
frozen variables, and every refresh is audit-logged.

Design pillars
--------------

* **Three value buckets** (per HQ directive):
    Bucket A — identity/contact — resolved from the franchisee record.
    Bucket B — contract-specific values (monthly fee, dates, HQ
               signatory, guarantor, special terms) — resolved from
               the contract record.
    Bucket C — system-generated (agreement date, contract reference,
               territory-map hyperlink) — resolved deterministically
               here, with per-contract HQ overrides where allowed.

* **Never guess.** Every resolved value carries provenance: ``source``
  ("franchisees.first_name", "contracts.monthly_fee",
  "system:issue_date", …) plus ``resolver`` ("field", "currency",
  "date", "hyperlink", "system:cm_year_franchise_ref", …). Missing
  values surface as errors — issuance is blocked until HQ resolves
  each one, either by editing the source record or via an explicit
  override on the contract.

* **Hard-fail on TERRITORY_MAP_URL without a frozen snapshot.** If
  the template contains this marker, the contract MUST have a
  ``frozen_territory_snapshot_id`` + ``frozen_territory_map_url``
  already recorded (via ``freeze-territory``). Otherwise the resolver
  returns an error and refuses to freeze — this guarantees issued
  PDFs never carry a link that follows the franchisee's live territory.

* **Idempotent.** Two consecutive resolves against the same inputs
  produce identical output — dates use ``at`` (defaulted to now UTC)
  so callers can pin the value if needed.
"""
from __future__ import annotations

import hashlib
import logging
import re
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Errors / typed report shape
# ---------------------------------------------------------------------------
@dataclass
class ResolvedValue:
    code: str
    # ``value`` is what the PDF renderer will print. For most types this
    # is a formatted string; for ``hyperlink`` it is a dict
    # ``{url, display, snapshot_id, url_sha256}``.
    value: Any
    raw_value: Any = None
    source: str = ""
    resolver: str = ""
    format_applied: Optional[Dict[str, Any]] = None
    warning: Optional[str] = None


@dataclass
class ResolutionError:
    code: str
    reason: str
    severity: str = "error"  # "error" | "warning"
    hint: Optional[str] = None


@dataclass
class ResolutionReport:
    resolved: Dict[str, ResolvedValue] = field(default_factory=dict)
    errors: List[ResolutionError] = field(default_factory=list)
    warnings: List[ResolutionError] = field(default_factory=list)
    resolved_at: str = ""
    resolved_by: str = ""
    template_id: str = ""
    template_version: Optional[int] = None
    template_pdf_sha256: Optional[str] = None
    contract_id: str = ""
    franchisee_id: str = ""

    def is_valid(self) -> bool:
        return len(self.errors) == 0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "resolved_at": self.resolved_at,
            "resolved_by": self.resolved_by,
            "template_id": self.template_id,
            "template_version": self.template_version,
            "template_pdf_sha256": self.template_pdf_sha256,
            "contract_id": self.contract_id,
            "franchisee_id": self.franchisee_id,
            "values": {c: asdict(rv) for c, rv in self.resolved.items()},
            "errors": [asdict(e) for e in self.errors],
            "warnings": [asdict(w) for w in self.warnings],
        }


# ---------------------------------------------------------------------------
# Format helpers (pure functions; deterministic; no side effects)
# ---------------------------------------------------------------------------
_CASING_APPLIERS = {
    "upper": str.upper,
    "lower": str.lower,
    "title": str.title,
    "as_is": lambda s: s,
}


def _apply_casing(s: str, casing: Optional[str]) -> str:
    fn = _CASING_APPLIERS.get((casing or "as_is").lower(), lambda x: x)
    return fn(s)


def _to_date(v: Any) -> Optional[date]:
    """Best-effort date coercion. Accepts date, datetime, or common
    string forms (ISO date, ISO datetime). Returns None if unusable."""
    if v is None or v == "":
        return None
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    s = str(v).strip()
    if not s:
        return None
    # ISO forms — datetime.fromisoformat handles both "2026-08-01" and
    # "2026-08-01T10:00:00" (Python 3.11 also accepts "Z" suffix).
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).date()
    except ValueError:
        pass
    # Common UK format dd/MM/yyyy
    m = re.match(r"^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$", s)
    if m:
        d, mo, y = (int(x) for x in m.groups())
        try:
            return date(y, mo, d)
        except ValueError:
            return None
    return None


# Placeholder characters that will never occur in HQ-authored patterns.
_DATE_TOKENS = [
    ("MMMM", "\x01"),
    ("MMM",  "\x02"),
    ("MM",   "\x03"),
    ("yyyy", "\x04"),
    ("yy",   "\x05"),
    ("dd",   "\x06"),
    ("d",    "\x07"),
]


def _format_date(d: date, pattern: str) -> str:
    """Format a ``date`` using a small pattern language:

        d     — day, no leading zero (1)
        dd    — day, zero-padded (01)
        MM    — month number, zero-padded (08)
        MMM   — month abbreviation (Aug)
        MMMM  — full month name (August)
        yy    — 2-digit year (26)
        yyyy  — 4-digit year (2026)

    Special: ``iso`` → ``date.isoformat()`` (``2026-08-01``).
    """
    pattern = (pattern or "d MMMM yyyy").strip()
    if pattern.lower() == "iso":
        return d.isoformat()
    tmp = pattern
    # Longest tokens first via placeholders, so ``dd`` never eats
    # ``d`` twice and month names don't get chewed by day/year passes.
    for tok, ph in _DATE_TOKENS:
        tmp = tmp.replace(tok, ph)
    values = {
        "\x01": d.strftime("%B"),
        "\x02": d.strftime("%b"),
        "\x03": f"{d.month:02d}",
        "\x04": f"{d.year:04d}",
        "\x05": f"{d.year % 100:02d}",
        "\x06": f"{d.day:02d}",
        "\x07": f"{d.day}",
    }
    for ph, val in values.items():
        tmp = tmp.replace(ph, val)
    return tmp


_CURRENCY_SYMBOLS = {"GBP": "£", "USD": "$", "EUR": "€"}


def _format_currency(v: Any, fmt: Optional[Dict[str, Any]]) -> str:
    fmt = fmt or {}
    symbol = _CURRENCY_SYMBOLS.get((fmt.get("currency") or "GBP").upper(), "")
    decimals = int(fmt.get("decimals", 2))
    thousand = bool(fmt.get("thousand_sep", True))
    # Preserve exact decimals via Decimal quantisation — floats can drift.
    d = Decimal(str(v))
    q = Decimal(10) ** -decimals
    d = d.quantize(q)
    n = f"{d:,.{decimals}f}" if thousand else f"{d:.{decimals}f}"
    return f"{symbol}{n}"


def _format_integer(v: Any, fmt: Optional[Dict[str, Any]]) -> str:
    fmt = fmt or {}
    thousand = bool(fmt.get("thousand_sep", False))
    n = int(v)
    return f"{n:,}" if thousand else f"{n}"


def _format_decimal(v: Any, fmt: Optional[Dict[str, Any]]) -> str:
    fmt = fmt or {}
    decimals = int(fmt.get("decimals", 2))
    thousand = bool(fmt.get("thousand_sep", True))
    d = Decimal(str(v))
    q = Decimal(10) ** -decimals
    d = d.quantize(q)
    return f"{d:,.{decimals}f}" if thousand else f"{d:.{decimals}f}"


def _assemble_address_block(fr: Dict[str, Any], join: str = ", ") -> str:
    """UK-order address string in the order HQ authors: street, city,
    county, postcode, country. Blank / null components dropped
    cleanly — no double commas, no trailing separators."""
    parts = [
        fr.get("address_street"),
        fr.get("city"),
        fr.get("county"),
        fr.get("postcode"),
        fr.get("country"),
    ]
    cleaned: List[str] = []
    for p in parts:
        if p is None:
            continue
        s = str(p).strip()
        # Historical Airtable rows sometimes have trailing commas.
        s = s.rstrip(",").strip()
        if s:
            cleaned.append(s)
    return join.join(cleaned)


# ---------------------------------------------------------------------------
# Field lookups
# ---------------------------------------------------------------------------
# Manual markers (Bucket B) — the field on the contract record shares
# the same name as the code in lower case.
def _manual_field_name(code: str) -> str:
    return code.lower()


def _read_field(record: Dict[str, Any], dotted: str) -> Any:
    """Read ``record`` by a dotted path like ``franchisees.first_name``.
    We ignore the collection prefix (``franchisees.`` / ``contracts.``)
    because the caller has already selected the right record."""
    parts = dotted.split(".")
    if len(parts) < 2:
        return None
    field = parts[-1]
    return record.get(field)


def _is_missing(v: Any) -> bool:
    if v is None:
        return True
    if isinstance(v, str) and not v.strip():
        return True
    return False


# ---------------------------------------------------------------------------
# System-generated resolvers
# ---------------------------------------------------------------------------
def _resolve_issue_date(
    contract: Dict[str, Any],
    at: datetime,
    library_format: Optional[Dict[str, Any]],
) -> Tuple[str, date, Dict[str, Any], Optional[str]]:
    """AGREEMENT_DATE — defaults to ``at`` (issue date), overridable by
    ``contract.agreement_date``. Returns
    (formatted_string, raw_date, format_applied, override_note)."""
    override = contract.get("agreement_date")
    if not _is_missing(override):
        d = _to_date(override)
        if d is None:
            raise ValueError(f"agreement_date override could not be parsed: {override!r}")
        note = "HQ override on contract.agreement_date"
    else:
        d = at.astimezone(timezone.utc).date() if at.tzinfo else at.date()
        note = None
    pattern = (library_format or {}).get("date_pattern", "d MMMM yyyy")
    return _format_date(d, pattern), d, {"date_pattern": pattern}, note


def _resolve_contract_reference(
    contract: Dict[str, Any],
    franchisee: Dict[str, Any],
    issue_date: date,
    library_format: Optional[Dict[str, Any]],
) -> Tuple[str, str, Dict[str, Any], Optional[str]]:
    """CONTRACT_REFERENCE — ``CM-{YYYY}-{franchise_number}`` (zero-padded
    to 4 digits when numeric), overridable by
    ``contract.contract_reference``. Casing per format (default upper)."""
    override = contract.get("contract_reference")
    if not _is_missing(override):
        raw = str(override).strip()
        note = "HQ override on contract.contract_reference"
    else:
        fn = franchisee.get("franchise_number")
        if _is_missing(fn):
            raise ValueError(
                "franchisees.franchise_number is missing — required to "
                "auto-generate CONTRACT_REFERENCE. Add the number or "
                "supply an HQ override via contract.contract_reference."
            )
        # Franchise numbers are typically stored as strings ("0094") but
        # we accept ints too — normalise to 4-digit zero-padded when
        # numeric, otherwise use as authored.
        fn_str = str(fn).strip()
        if fn_str.isdigit():
            fn_str = fn_str.zfill(4)
        raw = f"CM-{issue_date.year:04d}-{fn_str}"
        note = None
    casing = (library_format or {}).get("casing", "upper")
    formatted = _apply_casing(raw, casing)
    return formatted, raw, {"casing": casing, "template": "CM-{year}-{franchise_number}"}, note


def _resolve_territory_map_hyperlink(
    contract: Dict[str, Any],
    library_format: Optional[Dict[str, Any]],
) -> Tuple[Dict[str, Any], Dict[str, Any], Dict[str, Any]]:
    """TERRITORY_MAP_URL — pulled from the FROZEN snapshot stored on
    the contract record (see Turn A ``freeze-territory``). Raises
    ``ValueError`` if the required fields are missing — the caller
    translates this into a hard error on the report."""
    snap_id = contract.get("frozen_territory_snapshot_id")
    url = contract.get("frozen_territory_map_url")
    url_sha = contract.get("frozen_territory_map_url_sha256")
    if _is_missing(snap_id) or _is_missing(url) or _is_missing(url_sha):
        raise ValueError(
            "Template contains [[TERRITORY_MAP_URL]] but this contract "
            "does not have a frozen territory snapshot yet. Call "
            "POST /admin/contracts/{id}/freeze-territory before "
            "resolving variables — issuance is blocked otherwise."
        )
    default_display = (library_format or {}).get(
        "display_text_default", "View Agreed Territory Map",
    )
    display = contract.get("frozen_territory_map_url_display_text") or default_display
    value = {
        "url": url,
        "display": str(display),
        "snapshot_id": snap_id,
        "url_sha256": url_sha,
    }
    raw = {"snapshot_id": snap_id, "url": url}
    fmt = {
        "display_text_default": default_display,
        "casing": (library_format or {}).get("casing", "as_is"),
    }
    return value, raw, fmt


# ---------------------------------------------------------------------------
# Main resolver
# ---------------------------------------------------------------------------
def resolve_contract_variables(
    template: Dict[str, Any],
    contract: Dict[str, Any],
    franchisee: Dict[str, Any],
    library_entries: Iterable[Dict[str, Any]],
    *,
    actor: str = "system:resolver",
    at: Optional[datetime] = None,
) -> ResolutionReport:
    """Resolve every unique marker code declared on the template.

    Never mutates any input dict. Returns a report; the caller decides
    whether to freeze it onto the contract (via
    ``freeze_report_into_contract``) or discard (preview flow).
    """
    at = at or datetime.now(timezone.utc)
    report = ResolutionReport(
        resolved_at=at.astimezone(timezone.utc).isoformat(),
        resolved_by=actor,
        template_id=template.get("id") or "",
        template_version=template.get("approved_version") or template.get("current_version"),
        template_pdf_sha256=template.get("pdf_sha256"),
        contract_id=contract.get("id") or "",
        franchisee_id=franchisee.get("id") or "",
    )

    lib_by_code = {e["code"]: e for e in library_entries}
    codes = _unique_codes_in_template(template)
    # Determine issue date once for CONTRACT_REFERENCE cross-reference
    issue_date = at.astimezone(timezone.utc).date() if at.tzinfo else at.date()
    agr_override = contract.get("agreement_date")
    if not _is_missing(agr_override):
        parsed = _to_date(agr_override)
        if parsed is not None:
            issue_date = parsed

    for code in sorted(codes):
        lib = lib_by_code.get(code)
        if not lib:
            report.errors.append(ResolutionError(
                code=code,
                reason=(
                    f"Marker '{code}' is not in the Marker Library. Add "
                    "it via /admin/markers-library before resolving."
                ),
                hint="Marker library entry missing.",
            ))
            continue

        try:
            rv = _resolve_one(code, lib, contract, franchisee, at, issue_date)
        except _MissingRequired as exc:
            report.errors.append(ResolutionError(
                code=code, reason=str(exc), hint=exc.hint,
            ))
            continue
        except _WarnDegraded as exc:
            report.warnings.append(ResolutionError(
                code=code, reason=str(exc), severity="warning", hint=exc.hint,
            ))
            # Still capture the degraded value if provided
            if exc.value is not None:
                report.resolved[code] = exc.value
            continue
        except ValueError as exc:
            report.errors.append(ResolutionError(
                code=code, reason=str(exc),
                hint="Fix the source field or add an HQ override on the contract.",
            ))
            continue
        except Exception as exc:  # noqa: BLE001 — defensive; never crash the resolver
            logger.exception("Unexpected resolver error for %s", code)
            report.errors.append(ResolutionError(
                code=code, reason=f"Unexpected resolver error: {exc}",
            ))
            continue
        report.resolved[code] = rv

    return report


class _MissingRequired(Exception):
    def __init__(self, msg: str, hint: Optional[str] = None):
        super().__init__(msg)
        self.hint = hint


class _WarnDegraded(Exception):
    """A soft failure that still produces a usable value (e.g. optional
    address components missing) but that HQ should see in the report."""

    def __init__(self, msg: str, value: Optional[ResolvedValue] = None, hint: Optional[str] = None):
        super().__init__(msg)
        self.value = value
        self.hint = hint


def _unique_codes_in_template(template: Dict[str, Any]) -> Set[str]:
    codes: Set[str] = set()
    for m in template.get("markers") or []:
        c = m.get("code")
        if c:
            codes.add(c)
    return codes


def _resolve_one(
    code: str,
    lib: Dict[str, Any],
    contract: Dict[str, Any],
    franchisee: Dict[str, Any],
    at: datetime,
    issue_date: date,
) -> ResolvedValue:
    """Dispatch a single code by ``value_source`` + ``formula``."""
    value_source = (lib.get("value_source") or "").lower()
    data_type = (lib.get("data_type") or "string").lower()
    lib_format = lib.get("format") or {}

    # ------------------------------------------------------------------
    # System-generated (Bucket C)
    # ------------------------------------------------------------------
    if value_source == "system_generated":
        formula = lib.get("formula")
        if formula == "issue_date":
            fmt_val, raw, applied, note = _resolve_issue_date(contract, at, lib_format)
            return ResolvedValue(
                code=code,
                value=fmt_val,
                raw_value=raw.isoformat() if isinstance(raw, date) else raw,
                source="contracts.agreement_date" if not _is_missing(contract.get("agreement_date")) else "system:issue_date",
                resolver="system:issue_date",
                format_applied=applied,
                warning=note,
            )
        if formula == "cm_year_franchise_ref":
            fmt_val, raw, applied, note = _resolve_contract_reference(
                contract, franchisee, issue_date, lib_format,
            )
            return ResolvedValue(
                code=code,
                value=fmt_val,
                raw_value=raw,
                source=(
                    "contracts.contract_reference"
                    if not _is_missing(contract.get("contract_reference"))
                    else "system:cm_year_franchise_ref"
                ),
                resolver="system:cm_year_franchise_ref",
                format_applied=applied,
                warning=note,
            )
        if formula == "frozen_territory_map_link":
            try:
                value, raw, applied = _resolve_territory_map_hyperlink(contract, lib_format)
            except ValueError as exc:
                # Elevate to a HARD failure per HQ directive
                raise _MissingRequired(
                    str(exc),
                    hint=(
                        "Freeze the contract's territory first: "
                        "POST /admin/contracts/{id}/freeze-territory."
                    ),
                ) from exc
            return ResolvedValue(
                code=code,
                value=value,
                raw_value=raw,
                source="contracts.frozen_territory_snapshot_id",
                resolver="system:frozen_territory_map_link",
                format_applied=applied,
            )
        raise _MissingRequired(
            f"Unknown system-generated formula: {formula!r}",
            hint="Library entry has an unrecognised `formula` value.",
        )

    # ------------------------------------------------------------------
    # Manual (Bucket B) — pulled from the contract record
    # ------------------------------------------------------------------
    if value_source == "manual":
        field = _manual_field_name(code)
        val = contract.get(field)
        if _is_missing(val):
            raise _MissingRequired(
                f"Manual field 'contracts.{field}' is empty on this contract. "
                "HQ must enter this value on the draft before issuance.",
                hint=f"Edit the contract draft and set {field}.",
            )
        return _format_typed(
            code=code,
            raw=val,
            data_type=data_type,
            lib_format=lib_format,
            source=f"contracts.{field}",
            resolver_prefix="manual",
        )

    # ------------------------------------------------------------------
    # Automatic (Bucket A) — franchisee OR contract by data_field
    # ------------------------------------------------------------------
    if value_source == "automatic":
        data_field = lib.get("data_field") or ""
        # Virtual field — assembled from primitive components
        if data_field == "franchisees.address_block":
            joined = _assemble_address_block(franchisee, lib_format.get("join") or ", ")
            if not joined:
                raise _MissingRequired(
                    "franchisees.address_block cannot be assembled — every "
                    "component (address_street, city, postcode) is empty.",
                    hint="Fill in the franchisee's address on the Hub profile.",
                )
            return ResolvedValue(
                code=code,
                value=_apply_casing(joined, lib_format.get("casing")),
                raw_value=joined,
                source="franchisees.address_block (assembled)",
                resolver="auto:address_block",
                format_applied={"join": lib_format.get("join") or ", ", "casing": lib_format.get("casing", "as_is")},
            )
        # Virtual field — assembled full name from first + last
        if data_field == "franchisees.full_name" or "+" in data_field:
            # Support the library's ``franchisees.first_name+franchisees.last_name``
            # syntax by resolving each dotted component and joining
            # with the format's ``join`` (defaults to a single space).
            join_char = lib_format.get("join") or " "
            if "+" in data_field:
                parts_specs = [p.strip() for p in data_field.split("+")]
            else:
                parts_specs = ["franchisees.first_name", "franchisees.last_name"]
            pieces: List[str] = []
            for spec in parts_specs:
                if not spec.startswith("franchisees."):
                    raise _MissingRequired(
                        f"Composite data_field '{data_field}' includes a non-franchisee "
                        f"component '{spec}' — only franchisee fields are supported here.",
                    )
                v = _read_field(franchisee, spec)
                if not _is_missing(v):
                    pieces.append(str(v).strip())
            if not pieces:
                raise _MissingRequired(
                    f"Franchisee has none of the components required for {code}.",
                )
            joined = join_char.join(pieces)
            return ResolvedValue(
                code=code,
                value=_apply_casing(joined, lib_format.get("casing")),
                raw_value=joined,
                source="franchisees.full_name (assembled)",
                resolver="auto:composite",
                format_applied={"join": join_char, "casing": lib_format.get("casing", "as_is")},
            )

        # Primitive dotted-field access — either "franchisees.*" or "contracts.*"
        if data_field.startswith("franchisees."):
            record = franchisee
            source_prefix = "franchisees"
        elif data_field.startswith("contracts."):
            record = contract
            source_prefix = "contracts"
        else:
            raise _MissingRequired(
                f"Library entry for {code} has an unsupported data_field "
                f"'{data_field}'. Expected 'franchisees.*' or 'contracts.*'.",
            )
        raw = _read_field(record, data_field)
        if _is_missing(raw):
            # Fallback semantics — some fields are known-optional and
            # HQ will provide them manually via the contract record if
            # needed. The library entry's ``fallback_on_missing`` flag
            # gates this.
            fallback = lib.get("fallback_on_missing")
            hint = (
                "Fill this on the Hub franchisee profile."
                if source_prefix == "franchisees"
                else "Fill this on the contract draft."
            )
            raise _MissingRequired(
                f"{data_field} is empty. {hint}",
                hint=(
                    "This marker permits manual fallback — you can also "
                    f"set contracts.{_manual_field_name(code)} directly."
                    if fallback else hint
                ),
            )
        source = f"{source_prefix}.{data_field.split('.', 1)[1]}"
        return _format_typed(
            code=code,
            raw=raw,
            data_type=data_type,
            lib_format=lib_format,
            source=source,
            resolver_prefix="auto",
        )

    # ------------------------------------------------------------------
    # Calculated (Bucket A subtype) — not used yet, safe placeholder
    # ------------------------------------------------------------------
    if value_source == "calculated":
        raise _MissingRequired(
            f"Marker {code} is 'calculated' but no calculator is registered.",
            hint="Extend the resolver to handle this formula.",
        )

    raise _MissingRequired(
        f"Unsupported value_source '{value_source}' for {code}.",
    )


def _format_typed(
    *,
    code: str,
    raw: Any,
    data_type: str,
    lib_format: Dict[str, Any],
    source: str,
    resolver_prefix: str,
) -> ResolvedValue:
    """Format a primitive raw value according to ``data_type``."""
    if data_type == "date":
        d = _to_date(raw)
        if d is None:
            raise ValueError(f"Value {raw!r} is not a recognisable date.")
        pattern = lib_format.get("date_pattern", "d MMMM yyyy")
        return ResolvedValue(
            code=code,
            value=_format_date(d, pattern),
            raw_value=d.isoformat(),
            source=source,
            resolver=f"{resolver_prefix}:date",
            format_applied={"date_pattern": pattern},
        )
    if data_type == "currency":
        formatted = _format_currency(raw, lib_format)
        return ResolvedValue(
            code=code,
            value=formatted,
            raw_value=float(Decimal(str(raw))),
            source=source,
            resolver=f"{resolver_prefix}:currency",
            format_applied={k: lib_format.get(k) for k in ("currency", "decimals", "thousand_sep")},
        )
    if data_type == "integer":
        return ResolvedValue(
            code=code,
            value=_format_integer(raw, lib_format),
            raw_value=int(raw),
            source=source,
            resolver=f"{resolver_prefix}:integer",
            format_applied={"thousand_sep": bool(lib_format.get("thousand_sep", False))},
        )
    if data_type == "decimal":
        return ResolvedValue(
            code=code,
            value=_format_decimal(raw, lib_format),
            raw_value=float(Decimal(str(raw))),
            source=source,
            resolver=f"{resolver_prefix}:decimal",
            format_applied={
                "decimals": int(lib_format.get("decimals", 2)),
                "thousand_sep": bool(lib_format.get("thousand_sep", True)),
            },
        )
    if data_type == "multiline_text":
        s = str(raw)
        casing = lib_format.get("casing", "as_is")
        return ResolvedValue(
            code=code,
            value=_apply_casing(s, casing),
            raw_value=s,
            source=source,
            resolver=f"{resolver_prefix}:multiline",
            format_applied={"casing": casing, "max_lines": lib_format.get("max_lines")},
        )
    # Default: string
    s = str(raw)
    casing = lib_format.get("casing", "as_is")
    return ResolvedValue(
        code=code,
        value=_apply_casing(s, casing),
        raw_value=s,
        source=source,
        resolver=f"{resolver_prefix}:string",
        format_applied={"casing": casing},
    )


# ---------------------------------------------------------------------------
# Freeze helpers — persist the report onto the contract record
# ---------------------------------------------------------------------------
async def freeze_report_into_contract(
    db,
    *,
    contract_id: str,
    report: ResolutionReport,
    actor: str,
    at: datetime,
    reason: Optional[str] = None,
    is_refresh: bool = False,
) -> Dict[str, Any]:
    """Persist a resolution report onto ``contracts.contract_variables``.

    Never called when ``report.is_valid() is False`` — the caller
    (route handler) is expected to return the errors instead.

    On ``is_refresh=True`` this pushes the previous snapshot's
    ``resolved_at`` + ``resolved_by`` + ``reason`` into
    ``contract_variables.refresh_history`` for auditing.
    """
    now = at.astimezone(timezone.utc).isoformat()
    prev_doc = await db["contracts"].find_one({"id": contract_id}, {"_id": 0, "contract_variables": 1})
    previous = (prev_doc or {}).get("contract_variables") or None

    history_entry: Optional[Dict[str, Any]] = None
    if is_refresh and previous:
        history_entry = {
            "previous_resolved_at": previous.get("resolved_at"),
            "previous_resolved_by": previous.get("resolved_by"),
            "refreshed_at": now,
            "refreshed_by": actor,
            "reason": reason or "no reason provided",
            "previous_values_sha256": _hash_values(previous.get("values") or {}),
        }

    frozen = report.to_dict()
    # Preserve any existing refresh_history and append the new entry
    existing_history = (previous or {}).get("refresh_history") or []
    if history_entry:
        existing_history = list(existing_history) + [history_entry]
    frozen["refresh_history"] = existing_history
    frozen["values_sha256"] = _hash_values(frozen["values"])

    await db["contracts"].update_one(
        {"id": contract_id},
        {"$set": {
            "contract_variables": frozen,
            "updated_at": now,
            "updated_by": actor,
        }},
    )
    return frozen


def _hash_values(values: Dict[str, Any]) -> str:
    """Deterministic SHA-256 of the resolved-values dict — used to
    detect no-op refreshes and to include in the audit trail."""
    import json
    encoded = json.dumps(values, sort_keys=True, default=str, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()
