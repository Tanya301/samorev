"""Tests for lib/review_memory.py — extraction logic with fixture data."""
from __future__ import annotations

import sys
from pathlib import Path


# Make lib importable without installing anything
sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))

from review_memory import (  # noqa: E402
    build_context,
    extract_discussion,
    extract_prior_reviews,
)

# ---------------------------------------------------------------------------
# Fixtures — sample GitLab notes payloads
# ---------------------------------------------------------------------------

REV_REPORT_BODY = """\
## REV Code Review Report

BLOCKING ISSUES (2)

**CRITICAL** `src/auth.py:42` — SQL injection via unsanitised user input
> Evidence: `query = f"SELECT * FROM users WHERE id={user_id}"`

**Fix:** Use parameterised queries: `cursor.execute("SELECT * FROM users WHERE id=%s", (user_id,))`

---

**HIGH** `src/utils.py:101` — Resource leak: file handle never closed
> Evidence: `f = open(path)` with no corresponding close

**Fix:** Use `with open(path) as f:` to ensure the handle is closed.

---

PASSED checks: style, docs
"""

REV_REPORT_BODY_PASSING = """\
## REV Code Review Report

No blocking issues found.

**LOW** `tests/test_auth.py:5` — Missing edge-case test for empty input

**Fix:** Add `test_empty_input` covering the `""` case.
"""

HUMAN_NOTE_1 = "LGTM, nice refactor. Merging after CI."
HUMAN_NOTE_2 = "Can you add a test for the edge case where `user_id` is None?"
SHORT_NOTE = ":+1:"  # Only 3 chars — should be skipped
SYSTEM_NOTE = {"system": True, "body": "assigned to @alice", "author": {"name": "GitLab"}, "created_at": "2024-01-01T10:00:00.000Z"}


def _make_note(body: str, system: bool = False, author: str = "Alice", created: str = "2024-01-15T12:00:00.000Z") -> dict:
    return {
        "body": body,
        "system": system,
        "author": {"name": author},
        "created_at": created,
    }


# ---------------------------------------------------------------------------
# extract_prior_reviews
# ---------------------------------------------------------------------------

class TestExtractPriorReviews:
    def test_no_rev_reports_returns_sentinel(self):
        notes = [_make_note("Just a comment"), _make_note("Another comment")]
        result = extract_prior_reviews(notes)
        assert result == "NO_PRIOR_REVIEWS"

    def test_single_rev_report_extracted(self):
        notes = [_make_note(REV_REPORT_BODY)]
        result = extract_prior_reviews(notes)
        assert "Previous REV Review" in result
        assert "[CRITICAL]" in result
        assert "src/auth.py:42" in result
        assert "[HIGH]" in result
        assert "src/utils.py:101" in result

    def test_fix_suggestion_included(self):
        notes = [_make_note(REV_REPORT_BODY)]
        result = extract_prior_reviews(notes)
        assert "Fix:" in result
        assert "parameterised" in result

    def test_blocked_result_detected(self):
        notes = [_make_note(REV_REPORT_BODY)]
        result = extract_prior_reviews(notes)
        assert "BLOCKED (2 blocking issues)" in result

    def test_passing_result_detected(self):
        notes = [_make_note(REV_REPORT_BODY_PASSING)]
        result = extract_prior_reviews(notes)
        assert "PASSED" in result
        assert "[LOW]" in result

    def test_at_most_two_reports_extracted(self):
        # Three REV report notes — only first two should appear
        notes = [
            _make_note(REV_REPORT_BODY, created="2024-01-15T12:00:00.000Z"),
            _make_note(REV_REPORT_BODY_PASSING, created="2024-01-14T12:00:00.000Z"),
            _make_note(REV_REPORT_BODY, created="2024-01-13T12:00:00.000Z"),
        ]
        result = extract_prior_reviews(notes)
        # Count header lines as a proxy for number of reviews included
        assert result.count("--- Previous REV Review") == 2

    def test_non_rev_notes_ignored(self):
        notes = [
            _make_note("Regular human comment"),
            _make_note(REV_REPORT_BODY),
        ]
        result = extract_prior_reviews(notes)
        assert "Regular human comment" not in result
        assert "[CRITICAL]" in result

    def test_issue_text_truncated_at_200_chars(self):
        long_issue = "x" * 300
        body = f"## REV Code Review Report\n\n**HIGH** `file.py:1` — {long_issue}\n"
        notes = [_make_note(body)]
        result = extract_prior_reviews(notes)
        # Entry should exist but issue text capped
        assert "[HIGH]" in result
        # The issue portion should not exceed 200 chars (plus label overhead)
        for line in result.splitlines():
            if line.startswith("- [HIGH]"):
                issue_part = line.split(": ", 1)[1] if ": " in line else ""
                assert len(issue_part) <= 210  # some slack for Fix: suffix


# ---------------------------------------------------------------------------
# extract_discussion
# ---------------------------------------------------------------------------

class TestExtractDiscussion:
    def test_no_notes_returns_sentinel(self):
        result = extract_discussion([])
        assert result == "NO_DISCUSSION"

    def test_system_notes_skipped(self):
        notes = [SYSTEM_NOTE]
        result = extract_discussion(notes)
        assert result == "NO_DISCUSSION"

    def test_short_notes_skipped(self):
        notes = [_make_note(SHORT_NOTE)]
        result = extract_discussion(notes)
        assert result == "NO_DISCUSSION"

    def test_rev_reports_skipped(self):
        notes = [_make_note(REV_REPORT_BODY)]
        result = extract_discussion(notes)
        assert result == "NO_DISCUSSION"

    def test_human_note_included(self):
        notes = [_make_note(HUMAN_NOTE_1, author="Bob")]
        result = extract_discussion(notes)
        assert "@Bob" in result
        assert HUMAN_NOTE_1 in result

    def test_at_most_five_notes(self):
        notes = [_make_note(f"Comment number {i} with enough text", author=f"User{i}") for i in range(10)]
        result = extract_discussion(notes)
        assert result.count("@User") == 5

    def test_long_note_truncated(self):
        long_body = "A" * 1500
        notes = [_make_note(long_body, author="Alice")]
        result = extract_discussion(notes)
        assert "... [truncated]" in result
        # The note content in output should not exceed 1000 + len("... [truncated]") + overhead
        note_content = result.split("): ", 1)[1]
        assert len(note_content) <= 1020

    def test_author_and_timestamp_present(self):
        notes = [_make_note(HUMAN_NOTE_2, author="Carol", created="2024-03-01T09:30:00.000Z")]
        result = extract_discussion(notes)
        assert "@Carol" in result
        assert "2024-03-01T09:30:00" in result


# ---------------------------------------------------------------------------
# build_context
# ---------------------------------------------------------------------------

class TestBuildContext:
    def test_empty_when_both_sentinels(self):
        assert build_context("NO_PRIOR_REVIEWS", "NO_DISCUSSION") == ""

    def test_only_reviews_block(self):
        result = build_context("some findings", "NO_DISCUSSION")
        assert "<prior_reviews>" in result
        assert "<recent_discussion>" not in result

    def test_only_discussion_block(self):
        result = build_context("NO_PRIOR_REVIEWS", "a discussion note")
        assert "<recent_discussion>" in result
        assert "<prior_reviews>" not in result

    def test_both_blocks_present(self):
        result = build_context("findings", "discussion")
        assert "<prior_reviews>" in result
        assert "<recent_discussion>" in result

    def test_hard_cap_applied(self):
        big_reviews = "x" * 10_000
        big_discussion = "y" * 10_000
        result = build_context(big_reviews, big_discussion)
        assert len(result) <= 15_000 + 60  # cap + truncation suffix
        assert "truncated" in result

    def test_under_cap_not_truncated(self):
        result = build_context("short findings", "short discussion")
        assert "truncated" not in result
