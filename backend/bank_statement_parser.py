"""HSBC UK Personal statement PDF parser.

Real HSBC personal statements wrap each transaction across several
physical lines. A typical day group looks like:

    13 Apr 26 DD AIRBAND                  55.00
              CR PAYPAL
                  PPWDL4LFJ2225Z7Z32      65.00
              ))) COSTA COFFEE 43011
                  MINEHEAD                 2.95
                                                      3,428.15

The first column is shared by every transaction in the day. Each row
inside the group starts with a *prefix* that tells you the type:

    DD   Direct Debit         (DEBIT)
    CR   Credit               (CREDIT)
    VIS  Visa debit           (DEBIT)
    BP   Bill Payment         (DEBIT)
    SO   Standing Order       (DEBIT)
    )))  Contactless          (DEBIT)
    DR   Debit fee            (DEBIT)
    INT'L  International (debit, follows a prior VIS / ))) line)

The amount lives on the prefix line OR on a continuation line. The
running balance only appears at the end of a day group.

If parsing produces no transactions, the calling code keeps the raw
text on the statement document so we can iterate.
"""
from __future__ import annotations

import hashlib
import io
import re
from dataclasses import dataclass
from typing import Optional

import pdfplumber


# Two-decimal money. Allows commas in thousands. Requires the decimal so we
# don't accidentally catch dates or postcode numbers.
AMOUNT_RE = re.compile(r"\d+(?:,\d{3})*\.\d{2}\b")

DATE_RE = re.compile(
    r"^(?P<d>\d{1,2})\s+(?P<m>Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(?P<y>\d{2,4})\b",
    re.IGNORECASE,
)

# Period header: "11 April to 10 May 2026" — note the long-form month and
# the year only appearing once at the end.
PERIOD_RE = re.compile(
    r"(?P<d1>\d{1,2})\s+(?P<m1>January|February|March|April|May|June|"
    r"July|August|September|October|November|December)\s+"
    r"(?:(?P<y1>\d{4})\s+)?"
    r"to\s+"
    r"(?P<d2>\d{1,2})\s+(?P<m2>January|February|March|April|May|June|"
    r"July|August|September|October|November|December)\s+(?P<y2>\d{4})",
    re.IGNORECASE,
)

MONTH_MAP = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}
LONG_MONTH_MAP = {
    "january": 1, "february": 2, "march": 3, "april": 4, "may": 5, "june": 6,
    "july": 7, "august": 8, "september": 9, "october": 10, "november": 11,
    "december": 12,
}

# Transaction-type prefixes. Order matters: longer first so "INT'L" is
# tried before "I".
PREFIXES = [
    ("CR",      "CREDIT"),
    ("DD",      "DEBIT"),
    ("VIS",     "DEBIT"),
    ("BP",      "DEBIT"),
    ("SO",      "DEBIT"),
    (")))",     "DEBIT"),
    ("DR",      "DEBIT"),
    ("INT'L",   "DEBIT"),
    ("ATM",     "DEBIT"),
    ("CHQ",     "DEBIT"),
    ("TFR",     "DEBIT"),
]

# Lines that should be ignored entirely. Lower-cased substring match.
IGNORE_SUBSTRINGS = (
    "contact tel ",
    "see reverse",
    "text phone",
    "used by deaf",
    "www.hsbc",
    "your statement",
    "account name",
    "your hsbc",
    "your business",
    "international bank account",
    "bank identifier",
    "date payment type",
    "the broadway muswell hill",
    "balancebroughtforward",
    "balancecarriedforward",
    "balance brought forward",
    "balance carried forward",
    "page ",
    "information about the financial",
    "personal banking customers",
)


@dataclass
class ParsedTransaction:
    date: str                # YYYY-MM-DD
    description: str
    amount: float
    transaction_type: str    # CREDIT / DEBIT
    raw: str
    prefix: str


@dataclass
class ParsedStatement:
    transactions: list[ParsedTransaction]
    period_from: Optional[str]
    period_to: Optional[str]
    opening_balance: Optional[float]
    closing_balance: Optional[float]
    raw_text: str
    page_count: int


# ----------------- helpers -----------------

def _to_float(s: str) -> float:
    return float(s.replace("£", "").replace(",", "").strip())


def _parse_iso(d: int, month: str, year: str | int) -> str:
    y = int(year)
    if y < 100:
        y += 2000
    mm = MONTH_MAP[month.lower()[:3]]
    return f"{y:04d}-{mm:02d}-{d:02d}"


def _match_prefix(line: str) -> tuple[str, str, str] | None:
    """If `line` starts with a recognised prefix, return
    (prefix, direction, remainder). Otherwise None."""
    for prefix, direction in PREFIXES:
        if line.startswith(prefix + " "):
            return prefix, direction, line[len(prefix) + 1:].strip()
        if line == prefix:  # bare prefix on its own (rare)
            return prefix, direction, ""
    return None


def _should_ignore(line: str) -> bool:
    low = line.lower().strip()
    if not low:
        return True
    for s in IGNORE_SUBSTRINGS:
        if s in low:
            return True
    return False


# ----------------- main parser -----------------

def parse_hsbc_personal(pdf_bytes: bytes) -> ParsedStatement:
    raw_text_parts: list[str] = []
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        page_count = len(pdf.pages)
        for page in pdf.pages:
            raw_text_parts.append(page.extract_text() or "")
    raw_text = "\n".join(raw_text_parts)

    # ----- period -----
    period_from = period_to = None
    pm = PERIOD_RE.search(raw_text)
    if pm:
        y_end = pm.group("y2")
        y_start = pm.group("y1") or y_end
        period_from = _parse_iso(int(pm.group("d1")), pm.group("m1")[:3], y_start)
        period_to = _parse_iso(int(pm.group("d2")), pm.group("m2")[:3], y_end)

    # ----- opening / closing balance (whitespace-collapsed lookup) -----
    flat = re.sub(r"\s+", "", raw_text)
    opening_balance = closing_balance = None
    om = re.search(r"OpeningBalance£?(-?\d[\d,]*\.\d{2})", flat)
    if om:
        opening_balance = _to_float(om.group(1))
    cm = re.search(r"ClosingBalance£?(-?\d[\d,]*\.\d{2})", flat)
    if cm:
        closing_balance = _to_float(cm.group(1))

    # ----- transaction walker -----
    transactions: list[ParsedTransaction] = []
    current_date: Optional[str] = None
    current: Optional[dict] = None

    def _flush():
        """Push the current transaction onto the list if it has an amount."""
        nonlocal current
        if current and current.get("amount") is not None:
            transactions.append(ParsedTransaction(
                date=current["date"],
                description=re.sub(r"\s{2,}", " ", current["desc"].strip()) or "(no description)",
                amount=round(current["amount"], 2),
                transaction_type=current["direction"],
                raw=current["raw"],
                prefix=current["prefix"],
            ))
        current = None

    for raw_line in raw_text.splitlines():
        line = raw_line.strip()
        if _should_ignore(line):
            # An ignored line (header / footer / "balance carried forward")
            # also closes any open transaction so it can't bleed into the
            # next page's first transaction.
            _flush()
            continue

        # ---- date prefix? ----
        dm = DATE_RE.match(line)
        if dm:
            _flush()
            try:
                current_date = _parse_iso(int(dm.group("d")), dm.group("m"), dm.group("y"))
            except (KeyError, ValueError):
                continue
            line = line[dm.end():].strip()
            if not line:
                continue

        if not current_date:
            # We're still before the first date — skip preamble.
            continue

        # ---- new transaction prefix? ----
        prefix_match = _match_prefix(line)
        if prefix_match:
            _flush()
            prefix, direction, remainder = prefix_match
            current = {
                "date": current_date,
                "desc": remainder,
                "amount": None,
                "direction": direction,
                "prefix": prefix,
                "raw": raw_line,
            }
            # Look for amount on this line. If there are >=2 amounts the
            # last one is the running balance, so use the second-to-last.
            amounts = AMOUNT_RE.findall(line)
            if amounts:
                if len(amounts) >= 2:
                    current["amount"] = _to_float(amounts[-2])
                    # Trailing balance — close out the day group here. The
                    # tx is complete (single-line entry with balance).
                    _flush()
                else:
                    current["amount"] = _to_float(amounts[0])
                # Strip amount text from desc
                current and (current.update(
                    {"desc": AMOUNT_RE.sub("", current["desc"]).strip()},
                ) if current else None)
            continue

        # ---- continuation line ----
        if not current:
            # Stray line with no parent transaction — ignore.
            continue
        amounts = AMOUNT_RE.findall(line)
        if amounts:
            if len(amounts) >= 2:
                # ending of the day group: last = balance, prev = tx amount
                tx_amt = _to_float(amounts[-2])
                # The amount on the prefix line was probably a placeholder
                # (e.g. EUR amount) — the GBP amount here is authoritative.
                current["amount"] = tx_amt
                # Description portion (drop both trailing numbers)
                text_part = AMOUNT_RE.sub("", line).strip()
                if text_part:
                    current["desc"] = (current["desc"] + " " + text_part).strip()
                _flush()
            else:
                # Single amount — this is the tx amount (or replaces an
                # earlier placeholder e.g. for foreign currency where the
                # GBP equivalent is on a later line).
                amt = _to_float(amounts[0])
                # For foreign-currency wraps, the GBP "Visa Rate" amount
                # comes LATER and is smaller than the EUR amount. Always
                # overwriting handles this correctly because the GBP line
                # is always the last continuation before the next tx.
                current["amount"] = amt
                text_part = AMOUNT_RE.sub("", line).strip()
                if text_part:
                    current["desc"] = (current["desc"] + " " + text_part).strip()
        else:
            current["desc"] = (current["desc"] + " " + line).strip()

    _flush()

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
    """Stable hash used to dedupe transactions across re-uploads."""
    sign = "+" if tx.transaction_type == "CREDIT" else "-"
    key = f"{tx.date}|{sign}{tx.amount:.2f}|{tx.description.lower()[:120]}"
    return hashlib.sha256(key.encode()).hexdigest()[:24]


# =============== CSV (transaction-history export) ===============
# HSBC's "Download Transaction History" export is a 3-column CSV:
#   DD/MM/YYYY , description , signed_amount
# Negative = debit, positive = credit. No header. Massively more reliable
# than parsing PDFs, so this is the recommended import path.

import csv as _csv  # noqa: E402

def parse_hsbc_csv(csv_bytes: bytes) -> ParsedStatement:
    text = csv_bytes.decode("utf-8-sig", errors="replace")
    # Some HSBC exports include a header row, some don't. Detect by trying
    # to parse the first row's last cell as a number.
    reader = list(_csv.reader(text.splitlines()))
    if not reader:
        return ParsedStatement([], None, None, None, None, text, 0)
    # Skip header if first row's third column isn't a number
    if len(reader[0]) >= 3:
        try:
            float(reader[0][2].replace(",", ""))
        except ValueError:
            reader = reader[1:]

    transactions: list[ParsedTransaction] = []
    for row in reader:
        if len(row) < 3:
            continue
        date_str, desc, amount_str = row[0].strip(), row[1].strip(), row[2].strip()
        # DD/MM/YYYY → YYYY-MM-DD
        try:
            d, m, y = date_str.split("/")
            iso = f"{int(y):04d}-{int(m):02d}-{int(d):02d}"
        except ValueError:
            continue
        try:
            amt = float(amount_str.replace(",", "").replace("£", ""))
        except ValueError:
            continue
        direction = "CREDIT" if amt > 0 else "DEBIT"
        transactions.append(ParsedTransaction(
            date=iso,
            description=desc or "(no description)",
            amount=round(abs(amt), 2),
            transaction_type=direction,
            raw=",".join(row),
            prefix="CSV",
        ))
    # Sort oldest → newest so monthly aggregation comes out chronologically.
    transactions.sort(key=lambda t: t.date)
    return ParsedStatement(
        transactions=transactions,
        period_from=transactions[0].date if transactions else None,
        period_to=transactions[-1].date if transactions else None,
        opening_balance=None,
        closing_balance=None,
        raw_text=text,
        page_count=0,
    )
