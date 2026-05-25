"""Generic CSV parser for per-franchisee bank statement upload.

Each franchisee may bank with a different provider (HSBC, Lloyds,
Starling, Monzo, Barclays, NatWest, …) so we can't hard-code one
layout the way the admin's HSBC-only parser does.

Heuristics (in order of confidence):

1. Try to find a header row — if any cell contains the words
   "date", "amount" or "description"/"narrative"/"reference" we
   treat that row as headers and map by name.

2. Otherwise infer by column shape:
   - first column matching DD/MM/YYYY or YYYY-MM-DD → date
   - last numeric column → amount  (negative = debit)
   - the longest text column → description
   - if two numeric columns exist, treat them as (debit, credit)
     and combine into a signed amount.

3. Skip blank rows / header repeats / opening-balance markers.

Returns a list of {date, description, amount, transaction_type, raw}.
"""
from __future__ import annotations

import csv as _csv
import hashlib
import io
import re
from typing import List, Optional

ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
UK_DATE_RE = re.compile(r"^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$")
NUM_RE = re.compile(r"^-?[£$€]?-?[\d,]+(\.\d+)?$")


def _is_date(cell: str) -> bool:
    if not cell:
        return False
    c = cell.strip()
    return bool(ISO_DATE_RE.match(c) or UK_DATE_RE.match(c))


def _to_iso(cell: str) -> Optional[str]:
    c = cell.strip()
    if ISO_DATE_RE.match(c):
        return c
    m = UK_DATE_RE.match(c)
    if not m:
        return None
    parts = re.split(r"[/-]", c)
    if len(parts) != 3:
        return None
    d, mo, y = parts
    y = y if len(y) == 4 else ("20" + y if int(y) < 70 else "19" + y)
    try:
        return f"{int(y):04d}-{int(mo):02d}-{int(d):02d}"
    except ValueError:
        return None


def _to_amount(cell: str) -> Optional[float]:
    if cell is None:
        return None
    c = cell.strip().replace("£", "").replace("$", "").replace("€", "").replace(",", "").replace(" ", "")
    if not c or c in {"-", "—"}:
        return None
    # Parentheses denote negatives in some exports e.g. "(123.45)"
    if c.startswith("(") and c.endswith(")"):
        c = "-" + c[1:-1]
    try:
        return float(c)
    except ValueError:
        return None


def _build_fingerprint(date: str, amount: float, description: str) -> str:
    sign = "+" if amount >= 0 else "-"
    key = f"{date}|{sign}{abs(amount):.2f}|{(description or '').lower()[:120]}"
    return hashlib.sha256(key.encode()).hexdigest()[:24]


def parse_bank_csv(csv_bytes: bytes) -> List[dict]:
    """Return a list of normalised transactions:
       {date, description, amount, transaction_type, fingerprint, raw}.
    Amount is always positive; sign carried by transaction_type."""
    try:
        text = csv_bytes.decode("utf-8-sig", errors="replace")
    except Exception:
        text = csv_bytes.decode("latin-1", errors="replace")
    reader = list(_csv.reader(io.StringIO(text)))
    if not reader:
        return []

    # ---------- 1. Header detection
    headers_lc: List[str] = []
    body = reader
    head = [c.strip().lower() for c in reader[0]]
    if any(kw in cell for cell in head for kw in ("date", "amount", "debit", "credit", "description", "narrative", "reference", "details")):
        headers_lc = head
        body = reader[1:]

    date_idx: Optional[int] = None
    amt_idx: Optional[int] = None
    debit_idx: Optional[int] = None
    credit_idx: Optional[int] = None
    desc_idx: Optional[int] = None

    if headers_lc:
        for i, h in enumerate(headers_lc):
            if date_idx is None and ("date" in h):
                date_idx = i
            elif debit_idx is None and h in {"debit", "money out", "paid out", "withdrawn"}:
                debit_idx = i
            elif credit_idx is None and h in {"credit", "money in", "paid in", "deposited"}:
                credit_idx = i
            elif amt_idx is None and h in {"amount", "value"}:
                amt_idx = i
            elif desc_idx is None and any(k in h for k in ("description", "narrative", "details", "reference", "payee", "memo")):
                desc_idx = i

    # ---------- 2. Shape inference fallback
    if date_idx is None or (amt_idx is None and (debit_idx is None or credit_idx is None)):
        # Sample first 20 non-empty rows to figure out column types
        sample = [r for r in body[:40] if any(c.strip() for c in r)]
        if not sample:
            return []
        ncols = max(len(r) for r in sample)
        col_kinds: List[str] = []
        for c in range(ncols):
            dates = numbers = total = 0
            max_text_len = 0
            for r in sample:
                if c >= len(r):
                    continue
                cell = r[c].strip()
                if not cell:
                    continue
                total += 1
                if _is_date(cell):
                    dates += 1
                elif _to_amount(cell) is not None:
                    numbers += 1
                if len(cell) > max_text_len:
                    max_text_len = len(cell)
            if total == 0:
                col_kinds.append("empty")
            elif dates >= max(2, total * 0.5):
                col_kinds.append("date")
            elif numbers >= max(2, total * 0.7):
                col_kinds.append("number")
            else:
                col_kinds.append(("text", max_text_len))

        if date_idx is None:
            for i, k in enumerate(col_kinds):
                if k == "date":
                    date_idx = i
                    break
        # collect numeric columns
        numeric_cols = [i for i, k in enumerate(col_kinds) if k == "number"]
        if amt_idx is None and debit_idx is None and credit_idx is None:
            if len(numeric_cols) == 1:
                amt_idx = numeric_cols[0]
            elif len(numeric_cols) >= 2:
                # Heuristic: typical UK CSVs put debit before credit
                debit_idx, credit_idx = numeric_cols[0], numeric_cols[1]
        if desc_idx is None:
            text_cols = [(i, k[1]) for i, k in enumerate(col_kinds) if isinstance(k, tuple)]
            if text_cols:
                desc_idx = max(text_cols, key=lambda x: x[1])[0]

    if date_idx is None or (amt_idx is None and (debit_idx is None or credit_idx is None)):
        return []  # couldn't make sense of the file

    # ---------- 3. Walk rows
    txns: List[dict] = []
    for row in body:
        if not any(c.strip() for c in row):
            continue
        try:
            date_cell = row[date_idx] if date_idx < len(row) else ""
        except IndexError:
            continue
        date = _to_iso(date_cell)
        if not date:
            continue  # header repeat / opening balance / footer

        if amt_idx is not None and amt_idx < len(row):
            amt = _to_amount(row[amt_idx])
        elif debit_idx is not None or credit_idx is not None:
            debit = _to_amount(row[debit_idx]) if debit_idx is not None and debit_idx < len(row) else None
            credit = _to_amount(row[credit_idx]) if credit_idx is not None and credit_idx < len(row) else None
            if credit and not debit:
                amt = abs(credit)
            elif debit and not credit:
                amt = -abs(debit)
            else:
                amt = None
        else:
            amt = None

        if amt is None or amt == 0:
            continue

        desc = ""
        if desc_idx is not None and desc_idx < len(row):
            desc = row[desc_idx].strip()
        if not desc:
            # fall back to joining all non-numeric, non-date cells
            others = []
            for i, cell in enumerate(row):
                if i in {date_idx, amt_idx, debit_idx, credit_idx}:
                    continue
                if cell.strip():
                    others.append(cell.strip())
            desc = " ".join(others)
        desc = desc or "(no description)"

        direction = "CREDIT" if amt > 0 else "DEBIT"
        amt_abs = round(abs(amt), 2)
        txns.append({
            "date": date,
            "description": desc,
            "amount": amt_abs,
            "transaction_type": direction,
            "fingerprint": _build_fingerprint(date, amt, desc),
            "raw": ",".join(row),
        })
    txns.sort(key=lambda t: t["date"])
    return txns
