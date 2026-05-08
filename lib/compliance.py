"""Compliance mode detection and report rendering for REV reviews."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any


CONFIG_FILES = (
    ".rev.yml",
    ".rev.yaml",
    "rev.yml",
    "rev.yaml",
    ".rev.json",
    "rev.json",
)


@dataclass(frozen=True)
class ComplianceMode:
    """Named compliance mode.

    Unknown names are preserved so future modes can be configured before REV has
    built-in checks for them.
    """

    name: str

    def __post_init__(self) -> None:
        normalized = (self.name or "none").strip().lower()
        object.__setattr__(self, "name", normalized or "none")

    @property
    def enabled(self) -> bool:
        return self.name not in {"", "none", "off", "false", "disabled"}

    @property
    def is_soc2(self) -> bool:
        return self.name in {"soc2", "soc-2", "soc_2"}

    @property
    def label(self) -> str:
        if not self.enabled:
            return "none"
        if self.is_soc2:
            return "SOC2"
        return f"{self.name} (no built-in checks configured)"


@dataclass(frozen=True)
class ComplianceFinding:
    check: str
    severity: str
    issue: str
    suggestion: str
    control_ref: str


@dataclass(frozen=True)
class ComplianceReport:
    mode: ComplianceMode
    findings: tuple[ComplianceFinding, ...]
    markdown: str


def detect_compliance_mode(repo_root: Path | str) -> ComplianceMode:
    """Detect compliance mode from repo config, defaulting safely to none."""
    root = Path(repo_root)
    for name in CONFIG_FILES:
        config_path = root / name
        if config_path.exists():
            return ComplianceMode(_read_mode(config_path))
    return ComplianceMode("none")


def render_compliance_report(repo_root: Path | str, mr_data: dict[str, Any]) -> ComplianceReport:
    """Render compliance report markdown for the detected mode."""
    mode = detect_compliance_mode(repo_root)
    lines = [f"Active compliance checks: {mode.label}"]

    findings: tuple[ComplianceFinding, ...] = ()
    if mode.is_soc2:
        findings = tuple(check_soc2_compliance(mr_data))
        lines.extend(["", f"### SOC2 COMPLIANCE ({len(findings)})", ""])
        if findings:
            lines.extend(_render_soc2_findings(findings))
        else:
            lines.append("All SOC2 checks passed.")

    return ComplianceReport(mode=mode, findings=findings, markdown="\n".join(lines))


def check_soc2_compliance(mr_data: dict[str, Any]) -> list[ComplianceFinding]:
    """Check MR metadata for built-in SOC2 change-management requirements."""
    findings: list[ComplianceFinding] = []
    author = _username(mr_data.get("author"))
    reviewers = [_username(reviewer) for reviewer in mr_data.get("reviewers", [])]
    description = mr_data.get("description") or ""

    issue_patterns = [
        r"(?<!\w)#\d+(?!\w)",
        r"[Cc]loses?\s+#\d+",
        r"[Ff]ixes?\s+#\d+",
        r"[Rr]esolves?\s+#\d+",
        r"gitlab\.com/.+/-/issues/\d+",
        r"github\.com/.+/issues/\d+",
    ]
    if not any(re.search(pattern, description) for pattern in issue_patterns):
        findings.append(ComplianceFinding(
            check="SOC2: Linked Issue",
            severity="HIGH",
            issue="MR has no linked issue",
            suggestion='Add issue reference, for example "Closes #123", to the description',
            control_ref="CC8.1 - Change Management",
        ))

    valid_reviewers = [reviewer for reviewer in reviewers if reviewer and reviewer != author]
    if not valid_reviewers:
        findings.append(ComplianceFinding(
            check="SOC2: Code Review",
            severity="HIGH",
            issue="MR has no assigned reviewer other than the author",
            suggestion=f"Assign a reviewer other than @{author}" if author else "Assign a reviewer",
            control_ref="CC6.1 - Logical Access Controls",
        ))

    clean_description = re.sub(
        r"^##\s*(Summary|Description|Changes|TODO)\s*$",
        "",
        description,
        flags=re.MULTILINE,
    )
    clean_description = re.sub(r"\[.*?\]\(.*?\)", "", clean_description).strip()
    if len(clean_description) < 50:
        findings.append(ComplianceFinding(
            check="SOC2: Change Documentation",
            severity="MEDIUM",
            issue="MR description is too brief or empty",
            suggestion="Add a meaningful description explaining what changed and why",
            control_ref="CC8.1 - Change Management",
        ))

    return findings


def _read_mode(config_path: Path) -> str:
    text = config_path.read_text()
    if config_path.suffix == ".json":
        data = json.loads(text)
        return _mode_from_mapping(data)
    return _mode_from_simple_yaml(text)


def _mode_from_mapping(data: Any) -> str:
    if not isinstance(data, dict):
        return "none"
    compliance = data.get("compliance")
    if isinstance(compliance, str):
        return compliance
    if isinstance(compliance, dict):
        return str(compliance.get("mode") or compliance.get("name") or "none")
    return str(data.get("compliance_mode") or data.get("complianceMode") or "none")


def _mode_from_simple_yaml(text: str) -> str:
    lines = text.splitlines()
    for index, line in enumerate(lines):
        stripped = _strip_yaml_comment(line).strip()
        if not stripped:
            continue
        match = re.match(r"^(?:compliance_mode|complianceMode):\s*['\"]?([^'\"]+)['\"]?\s*$", stripped)
        if match:
            return match.group(1).strip()
        match = re.match(r"^compliance:\s*['\"]?([^'\"]+)['\"]?\s*$", stripped)
        if match:
            return match.group(1).strip()
        if stripped == "compliance:":
            nested = _read_nested_mode(lines[index + 1:])
            if nested:
                return nested
    return "none"


def _read_nested_mode(lines: list[str]) -> str | None:
    for line in lines:
        if line and not line.startswith((" ", "\t")):
            return None
        stripped = _strip_yaml_comment(line).strip()
        if not stripped:
            continue
        match = re.match(r"^(?:mode|name):\s*['\"]?([^'\"]+)['\"]?\s*$", stripped)
        if match:
            return match.group(1).strip()
    return None


def _strip_yaml_comment(line: str) -> str:
    return line.split("#", 1)[0]


def _username(value: Any) -> str:
    if isinstance(value, dict):
        return str(value.get("username") or value.get("login") or "")
    return str(value or "")


def _render_soc2_findings(findings: tuple[ComplianceFinding, ...]) -> list[str]:
    lines: list[str] = []
    for finding in findings:
        lines.extend([
            f"**{finding.severity}** `{finding.check}` - {finding.issue}",
            f"> Control: {finding.control_ref}",
            f"> Suggestion: {finding.suggestion}",
            "",
        ])
    return lines[:-1]
