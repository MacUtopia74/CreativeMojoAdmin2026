"""Shared Resend configuration.

Lives outside both ``resend_routes`` and ``portal_marketing_routes`` so
either module can pull the API key without re-importing the other (the
static analyser flagged the previous deferred-import pattern as a
circular dependency).
"""
from __future__ import annotations

import os

RESEND_API_KEY = os.environ.get("RESEND_API_KEY", "")
RESEND_FROM_EMAIL = os.environ.get("RESEND_FROM_EMAIL", "")
RESEND_FROM_NAME = os.environ.get("RESEND_FROM_NAME", "Creative Mojo")
RESEND_WEBHOOK_SECRET = os.environ.get("RESEND_WEBHOOK_SECRET", "")
