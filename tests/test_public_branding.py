"""Public docs and report text should use samorev-neutral branding."""
from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


def read_repo_file(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_readme_describes_general_purpose_review_tool():
    readme = read_repo_file("README.md")

    assert "# samorev - automated code review" in readme.lower()
    assert "Plans GitHub PR operations via `gh` and GitLab MR operations via `glab`" in readme
    assert "GitHub Pull Request support is planned" not in readme
    assert "currently supports GitLab Merge Requests via `glab`" not in readme
    assert "optional project-specific rules" in readme
    assert "PostgresAI rules integration" not in readme
    assert "postgres-ai/platform" not in readme


def test_slash_command_description_is_provider_neutral():
    command = read_repo_file(".claude/commands/review-mr.md")

    assert "description: Review a GitHub PR or GitLab MR using parallel AI agents" in command
    assert "# Review GitHub PR or GitLab MR" in command
    assert "GitHub PR support is planned" not in command
    assert "Default behavior:** Reviews are automatically posted as a comment when the provider CLI (`gh` or `glab`) is authenticated." in command
    assert "https://github.com/example-org/example-repo/pull/123" in command
    assert "postgres-ai/rev" not in command
    assert "Load optional project-specific rules" in command


def test_rules_are_not_a_required_postgres_ai_submodule():
    gitmodules = read_repo_file(".gitmodules") if (ROOT / ".gitmodules").exists() else ""
    readme = read_repo_file("README.md")
    command = read_repo_file(".claude/commands/review-mr.md")
    guidelines_agent = read_repo_file("agents/guidelines-checker.md")

    assert "https://gitlab.com/postgres-ai/rules.git" not in gitmodules
    assert "git clone --recurse-submodules" not in readme
    assert "git submodule update --init --recursive" not in readme
    assert "git submodule update --init --recursive" not in command
    assert "rules` submodule" not in guidelines_agent


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
