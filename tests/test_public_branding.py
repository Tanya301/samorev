"""Public docs and report text should use samorev-neutral branding."""
from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


def read_repo_file(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_readme_describes_general_purpose_review_tool():
    readme = read_repo_file("README.md")

    assert "# samorev - automated code review" in readme.lower()
    assert "GitHub Pull Requests and GitLab Merge Requests" in readme
    assert "optional project-specific rules" in readme
    assert "PostgresAI rules integration" not in readme
    assert "postgres-ai/platform" not in readme


def test_slash_command_description_is_provider_neutral():
    command = read_repo_file(".claude/commands/review-mr.md")

    assert "description: Review a GitHub PR or GitLab MR using parallel AI agents" in command
    assert "# Review GitHub PR or GitLab MR" in command
    assert "postgres-ai/rev" not in command
    assert "postgres-ai/platform" not in command
    assert "Load optional project-specific rules" in command


def test_report_footer_points_to_samorev():
    command = read_repo_file(".claude/commands/review-mr.md")
    readme = read_repo_file("README.md")
    expected_footer = "*samorev-assisted review (AI analysis by [Tanya301/samorev](https://github.com/Tanya301/samorev))*"

    assert "## samorev Code Review Report" in command
    assert "## samorev Code Review Report" in readme
    assert "## REV Code Review Report" not in command
    assert "## REV Code Review Report" not in readme
    assert expected_footer in command
    assert expected_footer in readme
    assert "REV-assisted review (AI analysis by [postgres-ai/rev]" not in command
    assert "REV-assisted review (AI analysis by [postgres-ai/rev]" not in readme
