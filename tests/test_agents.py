"""Tests for REV review agents.

Tests are split into:
- Unit tests (no API): Run on every push
- API tests: Run when agents change or nightly

Usage:
    pytest tests/ -m "not api"           # Unit tests only
    pytest tests/ -m api --max-fixtures=5  # API tests with limit
    pytest tests/ --model sonnet         # Test with specific model
"""
from __future__ import annotations

import json

import pytest

from tests.conftest import FixtureData, run_agent, GOLDEN_DIR
from tests.lib.compare import (
    Finding,
    compare_findings,
)


# ============================================================================
# UNIT TESTS (no API calls)
# ============================================================================

class TestCompareLogic:
    """Test the comparison/matching logic without API calls."""

    def test_finding_parser_basic(self):
        """Test parsing FINDING: blocks from agent output."""
        output = """
Looking at the code...

FINDING:
- severity: HIGH
- confidence: 8
- file: api/users.py
- line: 20
- issue: SQL injection vulnerability
- evidence: query = f"SELECT * FROM users WHERE id = {user_id}"
- fix: Use parameterized queries

Some other text here.

FINDING:
- severity: MEDIUM
- confidence: 6
- file: api/users.py
- line: 45
- issue: Missing input validation
- evidence: name = request.get('name')
- fix: Add input sanitization
"""
        findings = Finding.from_text(output)

        assert len(findings) == 2
        assert findings[0].severity == "HIGH"
        assert findings[0].confidence == 8
        assert findings[0].file == "api/users.py"
        assert findings[0].line == 20
        assert "SQL injection" in findings[0].issue
        assert findings[1].severity == "MEDIUM"

    def test_finding_parser_no_findings(self):
        """Test parsing NO_FINDINGS output."""
        output = "After reviewing the code... NO_FINDINGS"
        findings = Finding.from_text(output)
        assert len(findings) == 0

    def test_compare_must_find_success(self):
        """Test that must_find items are correctly matched."""
        findings = [
            Finding(
                severity="HIGH",
                confidence=8,
                file="api/users.py",
                line=20,
                issue="SQL injection vulnerability found",
                evidence="query = f\"SELECT...\"",
            )
        ]

        expected = {
            "must_find": [
                {
                    "severity_min": "HIGH",
                    "file": "api/users.py",
                    "line_range": [18, 22],
                    "issue_contains": ["sql", "injection"],
                }
            ],
            "must_not_find": [],
        }

        result = compare_findings(findings, expected)

        assert len(result.found) == 1
        assert len(result.missed) == 0
        assert result.recall == 1.0

    def test_compare_must_find_missed(self):
        """Test that missing must_find items are detected."""
        findings = []  # No findings

        expected = {
            "must_find": [
                {
                    "severity_min": "HIGH",
                    "file": "api/users.py",
                    "line_range": [18, 22],
                    "issue_contains": ["sql"],
                }
            ],
        }

        result = compare_findings(findings, expected)

        assert len(result.found) == 0
        assert len(result.missed) == 1
        assert result.recall == 0.0

    def test_compare_false_positive_detected(self):
        """Test that must_not_find items are flagged as false positives."""
        findings = [
            Finding(
                severity="LOW",
                confidence=5,
                file="api/users.py",
                line=5,
                issue="Existing code issue",
            )
        ]

        expected = {
            "must_find": [],
            "must_not_find": [
                {
                    "file": "api/users.py",
                    "line_range": [1, 10],
                }
            ],
        }

        result = compare_findings(findings, expected)

        assert len(result.false_positives) == 1
        assert result.fp_rate == 1.0

    def test_compare_partial_match(self):
        """Test with some found and some missed."""
        findings = [
            Finding(severity="HIGH", confidence=8, file="a.py", line=10, issue="bug one"),
        ]

        expected = {
            "must_find": [
                {"file": "a.py", "line_range": [8, 12]},
                {"file": "b.py", "line_range": [20, 25]},
            ],
        }

        result = compare_findings(findings, expected)

        assert len(result.found) == 1
        assert len(result.missed) == 1
        assert result.recall == 0.5

    def test_severity_comparison(self):
        """Test severity >= comparison."""
        # Finding with CRITICAL should match minimum HIGH
        findings = [
            Finding(severity="CRITICAL", confidence=9, file="x.py", line=1, issue="test"),
        ]

        expected = {
            "must_find": [{"severity_min": "HIGH", "file": "x.py"}],
        }

        result = compare_findings(findings, expected)
        assert len(result.found) == 1

        # Finding with LOW should NOT match minimum HIGH
        findings = [
            Finding(severity="LOW", confidence=5, file="x.py", line=1, issue="test"),
        ]

        result = compare_findings(findings, expected)
        assert len(result.missed) == 1


class TestFixtureLoading:
    """Test fixture discovery and loading."""

    def test_fixtures_directory_structure(self):
        """Verify expected fixture directories exist."""
        from tests.conftest import FIXTURES_DIR

        expected_agents = ["security", "bugs", "tests", "guidelines", "docs"]
        for agent in expected_agents:
            agent_dir = FIXTURES_DIR / agent
            assert agent_dir.exists(), f"Missing fixture directory: {agent_dir}"

    def test_expected_json_format(self):
        """Verify expected.json files have valid format."""
        from tests.conftest import FIXTURES_DIR

        for agent_dir in FIXTURES_DIR.iterdir():
            if not agent_dir.is_dir():
                continue
            for fixture_dir in agent_dir.iterdir():
                if not fixture_dir.is_dir():
                    continue

                expected_file = fixture_dir / "expected.json"
                if expected_file.exists():
                    data = json.loads(expected_file.read_text())
                    assert "must_find" in data or "must_not_find" in data, \
                        f"Invalid expected.json: {expected_file}"

                    for item in data.get("must_find", []):
                        # At least one matching criterion
                        assert any(k in item for k in [
                            "severity_min", "file", "line_range", "line", "issue_contains"
                        ]), f"must_find item needs matching criteria: {item}"


# ============================================================================
# API TESTS (make real API calls)
# ============================================================================

@pytest.mark.api
@pytest.mark.slow
class TestSecurityAgent:
    """Test security reviewer agent with real API calls."""

    def test_security_fixture(
        self,
        security_fixture: FixtureData,
        model: str,
        save_golden: bool,
    ):
        """Run security agent on fixture and verify findings."""
        output = run_agent("security", security_fixture, model)

        # Save golden output if requested
        if save_golden:
            golden_path = GOLDEN_DIR / "security" / f"{security_fixture.name}.txt"
            golden_path.parent.mkdir(parents=True, exist_ok=True)
            golden_path.write_text(output)

        # Parse and compare
        findings = Finding.from_text(output)
        result = compare_findings(findings, security_fixture.expected)

        # Assert quality thresholds
        assert result.recall >= 0.95, \
            f"Recall {result.recall:.1%} < 95%. Missed: {result.missed}"
        assert len(result.false_positives) <= security_fixture.expected.get(
            "allowed_false_positives", 0
        ), f"Too many false positives: {result.false_positives}"


@pytest.mark.api
@pytest.mark.slow
class TestBugsAgent:
    """Test bug hunter agent with real API calls."""

    def test_bugs_fixture(
        self,
        bugs_fixture: FixtureData,
        model: str,
        save_golden: bool,
    ):
        """Run bugs agent on fixture and verify findings."""
        output = run_agent("bugs", bugs_fixture, model)

        if save_golden:
            golden_path = GOLDEN_DIR / "bugs" / f"{bugs_fixture.name}.txt"
            golden_path.parent.mkdir(parents=True, exist_ok=True)
            golden_path.write_text(output)

        findings = Finding.from_text(output)
        result = compare_findings(findings, bugs_fixture.expected)

        assert result.recall >= 0.90, \
            f"Recall {result.recall:.1%} < 90%. Missed: {result.missed}"


@pytest.mark.api
@pytest.mark.slow
class TestTestsAgent:
    """Test test analyzer agent with real API calls."""

    def test_tests_fixture(
        self,
        tests_fixture: FixtureData,
        model: str,
        save_golden: bool,
    ):
        """Run tests agent on fixture and verify findings."""
        output = run_agent("tests", tests_fixture, model)

        if save_golden:
            golden_path = GOLDEN_DIR / "tests" / f"{tests_fixture.name}.txt"
            golden_path.parent.mkdir(parents=True, exist_ok=True)
            golden_path.write_text(output)

        findings = Finding.from_text(output)
        result = compare_findings(findings, tests_fixture.expected)

        assert result.recall >= 0.80, \
            f"Recall {result.recall:.1%} < 80%. Missed: {result.missed}"


@pytest.mark.api
@pytest.mark.slow
class TestGuidelinesAgent:
    """Test guidelines checker agent with real API calls."""

    def test_guidelines_fixture(
        self,
        guidelines_fixture: FixtureData,
        model: str,
        save_golden: bool,
    ):
        """Run guidelines agent on fixture and verify findings."""
        output = run_agent("guidelines", guidelines_fixture, model)

        if save_golden:
            golden_path = GOLDEN_DIR / "guidelines" / f"{guidelines_fixture.name}.txt"
            golden_path.parent.mkdir(parents=True, exist_ok=True)
            golden_path.write_text(output)

        findings = Finding.from_text(output)
        result = compare_findings(findings, guidelines_fixture.expected)

        assert result.recall >= 0.75, \
            f"Recall {result.recall:.1%} < 75%. Missed: {result.missed}"


@pytest.mark.api
@pytest.mark.slow
class TestDocsAgent:
    """Test docs reviewer agent with real API calls."""

    def test_docs_fixture(
        self,
        docs_fixture: FixtureData,
        model: str,
        save_golden: bool,
    ):
        """Run docs agent on fixture and verify findings."""
        output = run_agent("docs", docs_fixture, model)

        if save_golden:
            golden_path = GOLDEN_DIR / "docs" / f"{docs_fixture.name}.txt"
            golden_path.parent.mkdir(parents=True, exist_ok=True)
            golden_path.write_text(output)

        findings = Finding.from_text(output)
        result = compare_findings(findings, docs_fixture.expected)

        assert result.recall >= 0.75, \
            f"Recall {result.recall:.1%} < 75%. Missed: {result.missed}"


# ============================================================================
# CROSS-MODEL COMPARISON TESTS
# ============================================================================

@pytest.mark.api
@pytest.mark.slow
class TestModelComparison:
    """Compare different models on the same fixtures."""

    @pytest.fixture(scope="class")
    def comparison_fixture(self, security_fixtures) -> FixtureData | None:
        """Get a single fixture for comparison testing."""
        return security_fixtures[0] if security_fixtures else None

    def test_sonnet_vs_opus_recall(self, comparison_fixture, request):
        """Compare Sonnet recall to Opus baseline."""
        if not comparison_fixture:
            pytest.skip("No security fixtures available")

        # Run with both models
        opus_output = run_agent("security", comparison_fixture, "opus")
        sonnet_output = run_agent("security", comparison_fixture, "sonnet")

        opus_findings = Finding.from_text(opus_output)
        sonnet_findings = Finding.from_text(sonnet_output)

        opus_result = compare_findings(opus_findings, comparison_fixture.expected)
        sonnet_result = compare_findings(sonnet_findings, comparison_fixture.expected)

        # Sonnet should have at least 95% of Opus recall
        if opus_result.recall > 0:
            ratio = sonnet_result.recall / opus_result.recall
            assert ratio >= 0.95, \
                f"Sonnet recall ({sonnet_result.recall:.1%}) is only " \
                f"{ratio:.1%} of Opus ({opus_result.recall:.1%})"
