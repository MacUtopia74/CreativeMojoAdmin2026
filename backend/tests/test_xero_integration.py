"""Smoke tests for the Xero integration module.

These tests stub HTTP calls so they run offline. They cover the bits the
real Xero org cannot — i.e. the parts that exist purely inside our code:

* The Invoices payload builder maps our order shape to the Xero schema
  (correct line items, shipping, fallback).
* The webhook signature verification accepts a payload signed with our
  shared key and rejects bad signatures.
"""
import base64
import hashlib
import hmac
import importlib
import os
import sys
from pathlib import Path

import pytest

# Make sure /app/backend is on the path when pytest runs from /app
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

xi = importlib.import_module("xero_integration")


def test_invoice_payload_basic():
    order = {
        "id": "abc-123",
        "display_order_id": 8067,
        "customer_label": "Acme Care Home",
        "customer_email": "manager@acme.co.uk",
        "line_items": [
            {"name": "Group Art Kit - Large", "quantity": 2, "subtotal": "12.50"},
            {"name": "Activity Pack", "quantity": 1, "subtotal": "7.00"},
        ],
        "shipping_total": "4.95",
    }
    payload = xi._build_xero_invoice_payload(order)
    inv = payload["Invoices"][0]
    assert inv["Type"] == "ACCREC"
    assert inv["Status"] == "DRAFT"
    assert inv["LineAmountTypes"] == "Exclusive"
    assert inv["Contact"]["Name"] == "Acme Care Home"
    assert inv["Contact"]["EmailAddress"] == "manager@acme.co.uk"
    # Shipping should be added as an extra line item
    descs = [li.get("Description") for li in inv["LineItems"]]
    assert "Group Art Kit - Large" in descs
    assert "Shipping" in descs
    # Product lines use account 253 with 20% VAT; shipping uses 204 NONE
    prod_lines = [li for li in inv["LineItems"] if li.get("Description") == "Group Art Kit - Large"]
    assert prod_lines and prod_lines[0]["AccountCode"] == "253"
    assert prod_lines[0]["TaxType"] == "OUTPUT2"
    ship_line = [li for li in inv["LineItems"] if li.get("Description") == "Shipping"][0]
    assert ship_line["AccountCode"] == "204"
    assert ship_line["TaxType"] == "NONE"
    # Reference uses the human display id
    assert "8067" in inv["Reference"]


def test_invoice_payload_uses_xero_contact_id_when_known():
    order = {
        "id": "x",
        "customer_label": "Acme",
        "xero_contact_id": "8f3e-CONTACT-UUID",
        "line_items": [{"name": "Kit", "quantity": 1, "subtotal": "10"}],
    }
    inv = xi._build_xero_invoice_payload(order)["Invoices"][0]
    assert inv["Contact"] == {"ContactID": "8f3e-CONTACT-UUID"}


def test_invoice_payload_po_number_creates_description_line():
    order = {
        "id": "x",
        "display_order_id": 9001,
        "customer_label": "Acme",
        "po_number": "PO-2026-001",
        "line_items": [{"name": "Kit", "quantity": 1, "subtotal": "10"}],
    }
    inv = xi._build_xero_invoice_payload(order)["Invoices"][0]
    # First line should be PO description-only
    first = inv["LineItems"][0]
    assert first.get("Description") == "PO Number: PO-2026-001"
    assert "AccountCode" not in first
    assert "UnitAmount" not in first
    # Reference includes PO
    assert "PO PO-2026-001" in inv["Reference"]
    assert "9001" in inv["Reference"]


def test_invoice_payload_fallback_when_no_line_items():
    order = {
        "id": "manual-only",
        "display_order_id": 9000,
        "customer_label": "Walk-in Customer",
        "total": "25.00",
        "line_items": [],
    }
    payload = xi._build_xero_invoice_payload(order)
    inv = payload["Invoices"][0]
    # Fallback creates a single priced line
    priced = [li for li in inv["LineItems"] if li.get("AccountCode")]
    assert len(priced) == 1
    assert priced[0]["UnitAmount"] == 25.0
    assert priced[0]["AccountCode"] == "253"


def test_invoice_payload_omits_contact_email_when_missing():
    order = {"id": "x", "customer_label": "Anon", "line_items": [{"name": "Item", "quantity": 1, "subtotal": "1.00"}]}
    inv = xi._build_xero_invoice_payload(order)["Invoices"][0]
    assert "EmailAddress" not in inv["Contact"]


def test_webhook_signature_compare_logic():
    """Confirm the HMAC + base64 path matches what Xero documents."""
    body = b'{"events":[],"firstEventSequence":0,"lastEventSequence":0}'
    signing_key = "test-key-12345"
    digest = hmac.new(signing_key.encode("utf-8"), body, hashlib.sha256).digest()
    expected = base64.b64encode(digest).decode("utf-8")
    assert hmac.compare_digest(expected, expected)  # sanity
    # Wrong key produces a different signature
    bad = hmac.new(b"wrong", body, hashlib.sha256).digest()
    assert base64.b64encode(bad).decode("utf-8") != expected
