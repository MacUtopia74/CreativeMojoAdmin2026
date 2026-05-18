"""HSBC UK Personal statement PDF parser.

Extracts transactions from an HSBC personal current-account statement PDF
into a list of dicts compatible with the existing `banking_transactions`
collection (same shape as the TrueLayer integration produced).

HSBC's layout — the parser handles the following pattern (rows can wrap
onto a second narrative line, which we stitch back to the previous row):

    Date    Payment type and details        Paid out    Paid in    Balance
    12 Mar 25  ))) BP COSTA COFFEE           3.75                   192.45
    13 Mar 25  CR SALARY ABC LTD                          2500.00  2692.45

If parsing fails for a particular statement, the raw extracted text is
saved on the statement document so we can iterate. The parser is also
deliberately permissive — unknown rows are skipped rather than crashing
the whole upload.
"""
from __future__ import annotations

import hashlib
import io
import re
from dataclasses import dataclass
from datetime import datetime
from typing import Iterable, Optional

import pdfplumber


# Line types the parser recognises
DATE_RE = re.compile(
    r"^(?P<d>\d{1,2})\s*(?P<m>Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s*(?P<y>\d{2,4})\b",
    re.IGNORECASE,
)
# Amount pattern: optional minus, optional £, optional comma thousands, two
# decimals. Critically `\d+` so amounts >999 without comma separators (e.g.
# "2500.00" rather than "2,500.00") parse correctly — HSBC PDFs are
# inconsistent about thousands separators in the extracted text stream.
AMOUNT_RE = re.compile(r"-?£?\d+(?:,\d{3})*\.\d{2}\b")

MONTH_MAP = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}


@dataclass
class ParsedTransaction:
    date: str                # YYYY-MM-DD
    description: str
    amount: float            # signed: positive = credit, negative = debit
    transaction_type: str    # CREDIT / DEBIT
    raw: str                 # original line — useful for debugging


@dataclass
class ParsedStatement:
    transactions: list[ParsedTransaction]
    period_from: Optional[str]
    period_to: Optional[str]
    opening_balance: Optional[float]
    closing_balance: Optional[float]
    raw_text: str
    page_count: int


# ---------------- helpers ----------------

def _to_float(s: str) -> float:
    return float(s.replace("£", "").replace(",", "").strip())


def _parse_iso_date(d: int, m: str, y: str) -> str:
    year = int(y)
    if year < 100:
        year += 2000
    mm = MONTH_MAP[m.lower()[:3]]
    return f"{year:04d}-{mm:02d}-{d:02d}"


# ---------------- main parser ----------------

def parse_hsbc_personal(pdf_bytes: bytes) -> ParsedStatement:
    """Pull transactions out of an HSBC UK Personal statement PDF.

    Strategy:
        1. Extract text line-by-line with pdfplumber (preserves x-position
           on most modern HSBC PDFs).
        2. For each line that begins with a date, find every monetary
           amount in the row. The last amount is the running balance;
           the one(s) before it are paid-out / paid-in (HSBC always shows
           one of those two, never both).
        3. Continuation lines (no leading date) are appended to the
           previous transaction's description so wrapped narratives stay
           legible.
    """
    transactions: list[ParsedTransaction] = []
    last_balance: Optional[float] = None
    period_from = period_to = None
    opening_balance = closing_balance = None

    raw_text_parts: list[str] = []
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        page_count = len(pdf.pages)
        for page in pdf.pages:
            raw_text_parts.append(page.extract_text() or "")
    raw_text = "\n".join(raw_text_parts)

    # ---- statement period (top-of-document metadata) ----
    period_match = re.search(
        r"(?:From|Period)\s*[:\-]?\s*(\d{1,2}\s*[A-Za-z]{3}\s*\d{2,4})\s*"
        r"(?:to|\-|–)\s*(\d{1,2}\s*[A-Za-z]{3}\s*\d{2,4})",
        raw_text, re.IGNORECASE,
    )
    if period_match:
        for idx, key in ((1, "period_from"), (2, "period_to")):
            m = DATE_RE.search(period_match.group(idx))
            if m:
                val = _parse_iso_date(int(m.group("d")), m.group("m"), m.group("y"))
                if key == "period_from":
                    period_from = val
                else:
                    period_to = val

    # Track balance from opening line to infer direction when amounts are
    # ambiguous (HSBC reliably prints the running balance after each tx).
    opening_match = re.search(r"Opening Balance\s*£?(\d[\d,]*\.\d{2})",
                              raw_text, re.IGNORECASE)
    if opening_match:
        opening_balance = _to_float(opening_match.group(1))
        last_balance = opening_balance
    closing_match = re.search(r"Closing Balance\s*£?(\d[\d,]*\.\d{2})",
                              raw_text, re.IGNORECASE)
    if closing_match:
        closing_balance = _to_float(closing_match.group(1))

    # ---- transaction extraction ----
    for raw_line in raw_text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        m = DATE_RE.match(line)
        if not m:
            # Continuation line — append to last transaction's description
            # but only if it doesn't look like a header / footer.
            if (transactions and len(line) < 80
                    and not line.lower().startswith(("page", "your hsbc", "balance"))):
                transactions[-1].description = (
                    transactions[-1].description + " " + line
                ).strip()
            continue
        try:
            tx_date = _parse_iso_date(int(m.group("d")), m.group("m"), m.group("y"))
        except (KeyError, ValueError):
            continue
        # Strip the date prefix
        remainder = line[m.end():].strip()
        amounts = AMOUNT_RE.findall(remainder)
        if len(amounts) < 2:
            # Pure narrative continuation that happens to start with a date
            continue
        balance_val = _to_float(amounts[-1])
        # The other amount(s) on the line are paid-out / paid-in. HSBC
        # only ever fills one column. With the running balance we can
        # infer the direction even if column alignment is messy.
        movement_str = amounts[-2]
        movement = _to_float(movement_str)
        # Figure out direction
        signed: float
        if last_balance is None:
            # No reference balance yet — heuristic: look for explicit CR/DR
            # markers in the line ("CR" = credit, two letters at line end
            # mean debit type code). Default to debit if unclear.
            if re.search(r"\bCR\b|\bCREDIT\b|\)\)\)\s*CR\b", remainder, re.IGNORECASE):
                signed = movement
            else:
                signed = -movement
        else:
            # Direction = sign of (new_balance - last_balance), within a
            # small tolerance for rounding.
            delta = balance_val - last_balance
            if abs(delta - movement) < 0.01:
                signed = movement  # credit
            elif abs(delta + movement) < 0.01:
                signed = -movement  # debit
            else:
                # Balance jump doesn't match — could be a multi-tx line we
                # mis-parsed. Fall back to CR/DR marker.
                if re.search(r"\bCR\b|\bCREDIT\b", remainder, re.IGNORECASE):
                    signed = movement
                else:
                    signed = -movement
        last_balance = balance_val
        # Description = the line minus the trailing amounts
        desc = AMOUNT_RE.sub("", remainder).strip()
        # HSBC marker normalisation
        desc = re.sub(r"\s{2,}", " ", desc).strip(" -·–")
        transactions.append(ParsedTransaction(
            date=tx_date,
            description=desc or "(no description)",
            amount=round(abs(signed), 2),
            transaction_type="CREDIT" if signed > 0 else "DEBIT",
            raw=raw_line,
        ))

    # Infer statement period from first/last tx if metadata wasn't found.
    if transactions:
        if not period_from:
            period_from = transactions[0].date
        if not period_to:
            period_to = transactions[-1].date

    return ParsedStatement(
        transactions=transactions,
        period_from=period_from,
        period_to=period_to,
        opening_balance=opening_balance,
        closing_balance=closing_balance,
        raw_text=raw_text,
        page_count=page_count,
    )


def transaction_fingerprint(tx: ParsedTransaction) -> str:
    """Stable hash used to dedupe transactions across re-uploads.
    Combines date + cleaned description + signed amount so two statements
    overlapping by a day don't double-count anything."""
    sign = "+" if tx.transaction_type == "CREDIT" else "-"
    key = f"{tx.date}|{sign}{tx.amount:.2f}|{tx.description.lower()[:120]}"
    return hashlib.sha256(key.encode()).hexdigest()[:24]
