"""Compare agent findings against expected results.

Uses semantic matching - doesn't require exact text, just checks:
- Required issues are detected (must_find)
- False positives are avoided (must_not_find)
- Severity and location are approximately correct
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, List, Optional, Tuple


def _safe_int(value: Any, default: int = 0) -> int:
    """Safely convert value to int, returning default on failure."""
    try:
        return int(value)
    except (ValueError, TypeError):
        return default


@dataclass
class Finding:
    """Parsed finding from agent output."""
    severity: str
    confidence: int
    file: str
    line: int
    issue: str
    evidence: str = ""
    fix: str = ""
    suggestion: str = ""

    @classmethod
    def from_text(cls, text: str) -> List["Finding"]:
        """Parse FINDING: blocks from agent output."""
        findings = []
        # Split on FINDING: markers
        blocks = re.split(r'\bFINDING:\s*\n', text)

        for block in blocks[1:]:  # Skip text before first FINDING:
            finding_data = {}
            for line in block.split('\n'):
                line = line.strip()
                if line.startswith('- '):
                    line = line[2:]
                    if ':' in line:
                        key, value = line.split(':', 1)
                        key = key.strip().lower()
                        value = value.strip()
                        finding_data[key] = value
                elif not line:
                    break

            if finding_data.get('severity') and finding_data.get('file'):
                findings.append(cls(
                    severity=finding_data.get('severity', 'INFO').upper(),
                    confidence=_safe_int(finding_data.get('confidence', 5), 5),
                    file=finding_data.get('file', ''),
                    line=_safe_int(finding_data.get('line', 0), 0),
                    issue=finding_data.get('issue', ''),
                    evidence=finding_data.get('evidence', ''),
                    fix=finding_data.get('fix', ''),
                    suggestion=finding_data.get('suggestion', ''),
                ))

        return findings


@dataclass
class ExpectedFinding:
    """Expected finding from expected.json."""
    severity_min: Optional[str] = None
    file: Optional[str] = None
    line_range: Optional[Tuple[int, int]] = None
    issue_contains: Optional[List[str]] = None

    @classmethod
    def from_dict(cls, d: dict) -> "ExpectedFinding":
        line_range = None
        if 'line_range' in d:
            line_range = tuple(d['line_range'])
        elif 'line' in d:
            line_range = (d['line'], d['line'])
        return cls(
            severity_min=d.get('severity_min'),
            file=d.get('file'),
            line_range=line_range,
            issue_contains=d.get('issue_contains'),
        )


SEVERITY_ORDER = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']


def severity_gte(actual: str, minimum: str) -> bool:
    """Check if actual severity is >= minimum."""
    try:
        return SEVERITY_ORDER.index(actual.upper()) >= SEVERITY_ORDER.index(minimum.upper())
    except ValueError:
        return False


def matches_expected(finding: Finding, expected: ExpectedFinding) -> bool:
    """Check if a finding matches an expected finding (semantic match)."""
    # Check severity
    if expected.severity_min:
        if not severity_gte(finding.severity, expected.severity_min):
            return False

    # Check file (partial match)
    if expected.file:
        if expected.file not in finding.file and finding.file not in expected.file:
            return False

    # Check line range
    if expected.line_range:
        min_line, max_line = expected.line_range
        if not (min_line <= finding.line <= max_line):
            return False

    # Check issue keywords
    if expected.issue_contains:
        issue_lower = finding.issue.lower()
        evidence_lower = finding.evidence.lower()
        combined = issue_lower + ' ' + evidence_lower
        for keyword in expected.issue_contains:
            if keyword.lower() not in combined:
                return False

    return True


@dataclass
class CompareResult:
    """Result of comparing findings against expectations."""
    found: List[ExpectedFinding]  # must_find items that were found
    missed: List[ExpectedFinding]  # must_find items that were NOT found
    false_positives: List[Finding]  # findings matching must_not_find
    extra_findings: List[Finding]  # findings not in must_find
    recall: float  # found / total must_find
    fp_rate: float  # false_positives / total findings


def compare_findings(
    findings: List[Finding],
    expected: dict,
) -> CompareResult:
    """Compare actual findings against expected.json data."""
    must_find = [ExpectedFinding.from_dict(d) for d in expected.get('must_find', [])]
    must_not_find = [ExpectedFinding.from_dict(d) for d in expected.get('must_not_find', [])]
    # Note: allowed_false_positives is used by callers, not in this function

    found = []
    missed = []
    matched_findings = set()

    # Check must_find
    for expected_f in must_find:
        matched = False
        for i, finding in enumerate(findings):
            if i not in matched_findings and matches_expected(finding, expected_f):
                matched = True
                matched_findings.add(i)
                found.append(expected_f)
                break
        if not matched:
            missed.append(expected_f)

    # Check must_not_find (false positives)
    false_positives = []
    false_positive_indices = set()
    for i, finding in enumerate(findings):
        for not_expected in must_not_find:
            if matches_expected(finding, not_expected):
                false_positives.append(finding)
                false_positive_indices.add(i)
                break

    # Extra findings (not in must_find, not in must_not_find)
    extra_findings = [
        f for i, f in enumerate(findings)
        if i not in matched_findings and i not in false_positive_indices
    ]

    # Calculate metrics
    total_must_find = len(must_find)
    recall = len(found) / total_must_find if total_must_find > 0 else 1.0

    total_findings = len(findings)
    fp_rate = len(false_positives) / total_findings if total_findings > 0 else 0.0

    return CompareResult(
        found=found,
        missed=missed,
        false_positives=false_positives,
        extra_findings=extra_findings,
        recall=recall,
        fp_rate=fp_rate,
    )


def load_expected(fixture_path: Path) -> dict[str, Any]:
    """Load expected.json from a fixture directory."""
    expected_file = fixture_path / 'expected.json'
    if expected_file.exists():
        return json.loads(expected_file.read_text())
    return {'must_find': [], 'must_not_find': [], 'allowed_false_positives': 0}


def load_diff(fixture_path: Path) -> str:
    """Load diff.patch from a fixture directory."""
    diff_file = fixture_path / 'diff.patch'
    if diff_file.exists():
        return diff_file.read_text()
    return ""
