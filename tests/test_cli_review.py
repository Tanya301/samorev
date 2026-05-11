"""CLI-first review invocation tests for LLM-run samorev reviews."""
from __future__ import annotations

import subprocess
import sys
import tomllib
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


def run_cli(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "samorev.cli", *args],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )


def test_pyproject_declares_samorev_console_script():
    pyproject = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))

    assert pyproject["project"]["name"] == "samorev"
    assert pyproject["project"]["scripts"]["samorev"] == "samorev.cli:main"


def test_review_cli_smoke_for_github_pr_reuses_provider_planning_and_prompt():
    result = run_cli(
        "review",
        "https://github.com/example-org/example-repo/pull/17",
        "--no-comment",
        "--blocking",
        "--smoke",
    )

    assert result.returncode == 0, result.stderr
    assert "samorev review smoke" in result.stdout
    assert "provider=github" in result.stdout
    assert "kind=pr" in result.stdout
    assert "project=example-org/example-repo" in result.stdout
    assert "metadata_command=gh pr view 17 --repo example-org/example-repo" in result.stdout
    assert "post_comment_command=gh pr comment 17 --repo example-org/example-repo --body-file -" in result.stdout
    assert "prompt=.claude/commands/review-mr.md" in result.stdout
    assert "no_comment=true" in result.stdout
    assert "blocking=true" in result.stdout
    assert "live_posting=not-run" in result.stdout


def test_review_cli_no_comment_handoff_for_llm_run_reviews():
    result = run_cli(
        "review",
        "https://github.com/example-org/example-repo/pull/17",
        "--no-comment",
        "--blocking",
    )

    assert result.returncode == 0, result.stderr
    assert "samorev CLI review handoff" in result.stdout
    assert "Review: github pr example-org/example-repo#17" in result.stdout
    assert "Prompt:" in result.stdout
    assert ".claude/commands/review-mr.md" in result.stdout
    assert "No provider comment will be posted because --no-comment was set." in result.stdout


def test_review_cli_smoke_for_gitlab_numeric_reference_uses_remote_context():
    result = run_cli(
        "review",
        "123",
        "--remote-url",
        "git@gitlab.com:example-group/example-project.git",
        "--no-comment",
        "--smoke",
    )

    assert result.returncode == 0, result.stderr
    assert "provider=gitlab" in result.stdout
    assert "kind=mr" in result.stdout
    assert "project=example-group/example-project" in result.stdout
    assert "metadata_command=glab api projects/example-group%2Fexample-project/merge_requests/123" in result.stdout
    assert "post_comment_command=glab mr comment 123 --repo example-group/example-project -m $REPORT" in result.stdout
    assert "prompt=.claude/commands/review-mr.md" in result.stdout


def test_review_cli_rejects_invalid_reference_without_traceback():
    result = run_cli("review", "not-a-review", "--no-comment", "--smoke")

    assert result.returncode == 2
    assert "Invalid review reference" in result.stderr
    assert "Traceback" not in result.stderr


def test_readme_documents_cli_first_review_interface():
    readme = (ROOT / "README.md").read_text(encoding="utf-8")

    assert "CLI-first" in readme
    assert "samorev review <PR-or-MR> --no-comment --blocking" in readme
    assert "samorev review https://github.com/example-org/example-repo/pull/123 --no-comment --blocking" in readme
    assert "samorev review https://gitlab.com/example-org/example-repo/-/merge_requests/123 --no-comment" in readme
    assert "thin wrapper" in readme
