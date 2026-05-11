"""Executable smoke coverage for the GitHub slash-command path."""
from __future__ import annotations

import os
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_slash_command_initializes_arguments_and_captures_github_fetch_data():
    command = read(".claude/commands/review-mr.md")

    assert "RAW_ARGS=" in command
    assert "ARGUMENTS" in command
    assert "MR_REF=" in command
    assert "NO_COMMENT=" in command
    assert "BLOCKING_MODE=" in command
    assert 'MR_DESCRIPTION=$(echo "$MR_JSON" | jq -r' in command
    assert 'DIFF_CONTENT=$(eval "$DIFF_COMMAND")' in command
    assert "REVIEW_LABEL=" in command


def test_github_no_comment_provider_path_smoke():
    env = {
        **os.environ,
        "SAMOREV_SMOKE_REF": "https://github.com/example-org/example-repo/pull/17",
    }
    result = subprocess.run(
        ["bash", "scripts/smoke-github-provider-path.sh"],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    assert "provider=github" in result.stdout
    assert "review=pr example-org/example-repo#17" in result.stdout
    assert "metadata_title=Example PR" in result.stdout
    assert "diff_lines=8" in result.stdout
    assert "comments_seen=1" in result.stdout
    assert "commits_seen=1" in result.stdout
    assert "ci_status=success" in result.stdout
    assert "post_command=gh pr comment 17 --repo example-org/example-repo --body-file -" in result.stdout
    assert "live_posting=not-run" in result.stdout
