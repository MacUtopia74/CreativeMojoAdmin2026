"""Regression: follow-up template classifier + counter increment gating.

The user's rule (Feb 2026):

> follow_up_sent_count is only increased by the intended follow-up
> email template. An unrelated templated email (AREA TAKEN, BLANK
> INTRO, SETUP, OVERSEAS, …) must NOT mark Follow-up Email 1 as sent
> and must NOT pull the contact out of Follow-up Due.

The identifying tag is the template's ``display_name == "FOLLOW UP"``
(case-insensitive, whitespace-trimmed).

We keep this test lightweight and hermetic:

* **Unit tests** hit the pure classifier directly — this is the
  single source of truth used by ``resend_routes.send_reply`` and
  guards against a future refactor loosening the check.
* **Wire-up test** reads the actual ``resend_routes.py`` source and
  asserts it delegates to ``is_follow_up_template`` (not a copy).
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, "/app/backend")
import follow_up_workflow as fw  # noqa: E402


class TestIsFollowUpTemplate:
    @pytest.mark.parametrize("display_name", [
        "FOLLOW UP",
        "follow up",
        "Follow Up",
        "  FOLLOW UP  ",
        "  follow up ",
        "\tFOLLOW UP\n",
    ])
    def test_positive_cases(self, display_name):
        assert fw.is_follow_up_template({"display_name": display_name}) is True

    @pytest.mark.parametrize("display_name", [
        "AREA TAKEN",
        "BLANK INTRO",
        "SETUP",
        "OVERSEAS",
        "FOLLOWUP",   # missing space — must NOT match
        "FOLLOW-UP",  # hyphenated variant — must NOT match
        "FOLLOW UP 2",
        "second follow up",
        "",
        "   ",
        None,
    ])
    def test_negative_cases(self, display_name):
        assert fw.is_follow_up_template({"display_name": display_name}) is False

    def test_none_template_returns_false(self):
        assert fw.is_follow_up_template(None) is False

    def test_missing_display_name_key_returns_false(self):
        assert fw.is_follow_up_template({}) is False

    def test_non_string_display_name_returns_false(self):
        # Defensive: if somehow the field is stored as a number/dict, the
        # classifier must not crash and must fall through to False.
        for bad in (42, True, {"nope": "no"}, ["FOLLOW UP"]):
            assert fw.is_follow_up_template({"display_name": bad}) is False


class TestSendReplyUsesClassifier:
    """Guards against a refactor where someone inlines a copy of the
    check inside ``send_reply`` and forgets to update it. The whole
    point of the pure helper is a single source of truth."""

    @pytest.fixture(scope="class")
    def source(self):
        return Path("/app/backend/resend_routes.py").read_text()

    def test_send_reply_imports_and_calls_the_helper(self, source):
        assert "from follow_up_workflow import is_follow_up_template" in source, (
            "send_reply must import the shared classifier"
        )
        # And it must actually be invoked on the fetched template row.
        assert "_is_fu(tpl)" in source or "is_follow_up_template(tpl)" in source, (
            "send_reply must call the classifier on the loaded template"
        )

    def test_no_inline_string_comparison_remains(self, source):
        # Historically the check was ``dn == "FOLLOW UP"`` inline —
        # anyone reintroducing that pattern in send_reply loses the
        # test coverage above.
        assert '== "FOLLOW UP"' not in source, (
            "Inline string comparison found — use is_follow_up_template() instead"
        )

    def test_counter_bump_and_pipeline_flip_gated_on_helper(self, source):
        # The critical write-paths must be inside the ``if
        # is_follow_up_template:`` branch. We look for the branch text
        # and the guarded writes.
        idx = source.find("if is_follow_up_template:")
        assert idx > 0, "is_follow_up_template branch missing from send_reply"
        tail = source[idx:idx + 3000]
        assert '"$inc": {"follow_up_sent_count": 1}' in tail, (
            "follow_up_sent_count increment must live inside the is_follow_up_template branch"
        )
        assert '"pipeline_status": "follow_up_due"' in tail, (
            "pipeline flip must live inside the is_follow_up_template branch"
        )
        assert '"follow_up_index"' in tail, (
            "follow_up_index stamping must live inside the is_follow_up_template branch"
        )
