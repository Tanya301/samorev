"""Tests for compliance mode detection and report rendering."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))

from compliance import ComplianceMode, render_compliance_report


def test_no_config_non_soc2_repo_omits_soc2_sections(tmp_path):
    """Repos without compliance config should not emit SOC2 report sections."""
    report = render_compliance_report(
        repo_root=tmp_path,
        mr_data={
            "author": {"username": "alice"},
            "description": "Short maintenance update",
            "reviewers": [],
        },
    )

    assert report.mode == ComplianceMode("none")
    assert "SOC2 COMPLIANCE" not in report.markdown
    assert "Active compliance checks: none" in report.markdown


def test_soc2_config_emits_soc2_section(tmp_path):
    (tmp_path / ".rev.yml").write_text("compliance: soc2\n")

    report = render_compliance_report(
        repo_root=tmp_path,
        mr_data={
            "author": {"username": "alice"},
            "description": "Closes #123\n\nThis change documents the compliance review behavior.",
            "reviewers": [{"username": "bob"}],
        },
    )

    assert report.mode == ComplianceMode("soc2")
    assert "Active compliance checks: SOC2" in report.markdown
    assert "### SOC2 COMPLIANCE (0)" in report.markdown
    assert "All SOC2 checks passed." in report.markdown


def test_future_named_compliance_mode_does_not_emit_soc2_section(tmp_path):
    (tmp_path / ".rev.yml").write_text("compliance:\n  mode: iso27001\n")

    report = render_compliance_report(repo_root=tmp_path, mr_data={})

    assert report.mode == ComplianceMode("iso27001")
    assert "SOC2 COMPLIANCE" not in report.markdown
    assert "Active compliance checks: iso27001 (no built-in checks configured)" in report.markdown
