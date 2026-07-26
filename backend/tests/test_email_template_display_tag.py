"""Regression: Email-template Display Name + colour tag pill.

Locks the invariants surfaced when HQ asked for clearer template
identification in the Reply-with-template dropdown:

* Backend accepts + round-trips ``display_name`` and ``display_color``.
* ``display_color`` is validated against the 9-value palette (3 greens,
  3 oranges, 3 reds). Any other value → 400.
* Setting ``display_color=null`` clears the colour cleanly.
* Empty ``display_name`` string collapses to ``None`` so the frontend
  chip never renders "".
* Static frontend checks: the Reply dropdown renders through the
  ``TemplatePicker`` custom listbox (not a native <select>) so the
  coloured pill actually paints, and the templates page rail is wider
  than the previous ``w-72`` to fit the pill without truncation.
"""
from __future__ import annotations

import os
import re
from pathlib import Path

import pytest
import requests


BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
ADMIN_EMAIL = "admin@creativemojo.co.uk"
ADMIN_PASSWORD = "CreativeMojo2026!"

if not BASE_URL:
    raise RuntimeError("REACT_APP_BACKEND_URL must be set")


def _login():
    s = requests.Session()
    r = s.post(f"{BASE_URL}/api/auth/login",
               json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=15)
    r.raise_for_status()
    tok = r.json().get("access_token") or r.json().get("token")
    s.headers.update({"Authorization": f"Bearer {tok}"})
    return s


@pytest.fixture(scope="module")
def admin():
    return _login()


@pytest.fixture(scope="module")
def template_id(admin):
    """A disposable template we can freely mutate."""
    r = admin.post(f"{BASE_URL}/api/email-templates",
                   json={"name": "regression-display-tag",
                         "subject": "test", "body_html": ""},
                   timeout=15)
    assert r.status_code == 200, r.text
    tid = r.json()["id"]
    yield tid
    admin.delete(f"{BASE_URL}/api/email-templates/{tid}", timeout=15)


ALL_PALETTE = [
    "green_1", "green_2", "green_3",
    "orange_1", "orange_2", "orange_3",
    "red_1", "red_2", "red_3",
]


class TestBackendDisplayFields:
    def test_patch_accepts_display_name_and_color(self, admin, template_id):
        r = admin.patch(
            f"{BASE_URL}/api/email-templates/{template_id}",
            json={"display_name": "BLANK INTRO", "display_color": "green_3"},
            timeout=15,
        )
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["display_name"] == "BLANK INTRO"
        assert d["display_color"] == "green_3"

    def test_list_includes_display_fields(self, admin, template_id):
        r = admin.get(f"{BASE_URL}/api/email-templates", timeout=15)
        assert r.status_code == 200
        row = next(t for t in r.json()["items"] if t["id"] == template_id)
        assert row["display_name"] == "BLANK INTRO"
        assert row["display_color"] == "green_3"

    @pytest.mark.parametrize("color", ALL_PALETTE)
    def test_all_palette_values_accepted(self, admin, template_id, color):
        r = admin.patch(
            f"{BASE_URL}/api/email-templates/{template_id}",
            json={"display_color": color}, timeout=15,
        )
        assert r.status_code == 200, r.text
        assert r.json()["display_color"] == color

    @pytest.mark.parametrize("bad", ["purple_5", "GREEN_1", "blue", "green_4", 42])
    def test_invalid_colors_rejected(self, admin, template_id, bad):
        r = admin.patch(
            f"{BASE_URL}/api/email-templates/{template_id}",
            json={"display_color": bad}, timeout=15,
        )
        assert r.status_code == 400
        assert "display_color" in r.text.lower()

    def test_null_color_clears(self, admin, template_id):
        r = admin.patch(
            f"{BASE_URL}/api/email-templates/{template_id}",
            json={"display_color": None}, timeout=15,
        )
        assert r.status_code == 200
        assert r.json()["display_color"] is None

    def test_empty_display_name_collapses_to_null(self, admin, template_id):
        r = admin.patch(
            f"{BASE_URL}/api/email-templates/{template_id}",
            json={"display_name": "   "}, timeout=15,
        )
        assert r.status_code == 200
        assert r.json()["display_name"] is None


class TestFrontendWiring:
    @pytest.fixture(scope="class")
    def modal_src(self):
        return Path("/app/frontend/src/components/ReplyWithTemplateModal.jsx").read_text()

    @pytest.fixture(scope="class")
    def page_src(self):
        return Path("/app/frontend/src/pages/EmailTemplatesPage.jsx").read_text()

    @pytest.fixture(scope="class")
    def colors_src(self):
        return Path("/app/frontend/src/lib/emailTemplateColors.js").read_text()

    def test_palette_module_exports_all_nine_colours(self, colors_src):
        for c in ALL_PALETTE:
            assert f'value: "{c}"' in colors_src, f"Missing palette entry {c!r}"

    def test_reply_modal_uses_custom_picker_not_native_select(self, modal_src):
        # Native <select> can't paint per-option backgrounds cross-browser.
        # The picker must be the custom TemplatePicker listbox.
        assert "TemplatePicker" in modal_src, (
            "ReplyWithTemplateModal must use the TemplatePicker custom listbox"
        )
        # Verify the picker renders a DisplayNamePill for the selected + list rows.
        assert "DisplayNamePill" in modal_src, (
            "ReplyWithTemplateModal must render the coloured DisplayNamePill"
        )
        # The old native <select> for the template picker must be gone.
        # (Other native selects in the file — pipeline stage, etc — are fine.)
        assert 'data-testid="reply-template-picker-button"' in modal_src, (
            "Picker button test-id missing"
        )
        # Sanity — no stray old-style <select value={selectedId ...
        assert not re.search(
            r'<select[^>]*value=\{selectedId', modal_src,
        ), "Legacy native <select> for the template picker is still present"

    def test_templates_page_rail_widened_to_at_least_w_96(self, page_src):
        # Old rail was ``w-72``. The new pill needs more room — must be
        # w-96 or wider (any larger Tailwind width is fine).
        assert re.search(
            r'<div className="w-(96|\[\d+rem\]|1/3|1/4|full)\s+border-r border-stone-200', page_src,
        ), "Templates page rail must be widened from w-72"

    def test_templates_page_renders_display_pill_on_rows(self, page_src):
        assert "<DisplayNamePill" in page_src, (
            "EmailTemplatesPage must render the coloured DisplayNamePill "
            "on each row of the list rail"
        )

    def test_templates_page_has_display_name_input(self, page_src):
        assert 'data-testid="template-display-name"' in page_src, (
            "EmailTemplatesPage must expose a display_name input in the editor"
        )

    def test_templates_page_has_color_picker(self, page_src):
        # Swatch test-ids are interpolated at runtime as
        # ``template-display-color-${opt.value}``. Assert the interpolation
        # is present + the DISPLAY_COLOR_OPTIONS import is wired.
        assert "template-display-color-${opt.value}" in page_src, (
            "Colour swatch test-ids must be interpolated per DISPLAY_COLOR_OPTIONS"
        )
        assert "DISPLAY_COLOR_OPTIONS.map" in page_src, (
            "Editor must iterate DISPLAY_COLOR_OPTIONS for the swatch picker"
        )
        assert 'template-display-color-none' in page_src, (
            "Neutral (no colour) swatch missing from the editor picker"
        )
