"""CLI-first review invocation tests for LLM-run samorev reviews."""
from __future__ import annotations

import os
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


def run_cli_with_path(path: str, *args: str) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["PATH"] = f"{path}{os.pathsep}{env['PATH']}"
    return subprocess.run(
        [sys.executable, "-m", "samorev.cli", *args],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
    )


def test_review_cli_fetches_github_provider_data_and_renders_summary(tmp_path):
    fake_gh = tmp_path / "gh"
    fake_gh.write_text(
        """#!/usr/bin/env python3
import json
import sys

args = sys.argv[1:]
if args[:3] == ["pr", "view", "17"]:
    print(json.dumps({"title": "Demo PR", "state": "OPEN", "isDraft": False}))
elif args[:3] == ["pr", "diff", "17"]:
    sys.stdout.write("diff --git a/app.py b/app.py\\n+print('demo')\\n-old = True\\n")
elif args[:2] == ["api", "repos/example-org/example-repo/issues/17/comments"]:
    print(json.dumps([{"body": "first"}, {"body": "second"}]))
elif args[:2] == ["api", "repos/example-org/example-repo/pulls/17/commits"]:
    print(json.dumps([{"sha": "abc"}, {"sha": "def"}, {"sha": "ghi"}]))
elif args[:2] == ["api", "repos/example-org/example-repo/commits/pull/17/head/check-runs"]:
    print(json.dumps({"total_count": 2, "check_runs": [{"name": "unit", "conclusion": "success"}, {"name": "lint", "conclusion": "failure"}]}))
else:
    print(f"unexpected gh args: {args}", file=sys.stderr)
    sys.exit(42)
""",
        encoding="utf-8",
    )
    fake_gh.chmod(0o755)

    result = run_cli_with_path(
        str(tmp_path),
        "review",
        "https://github.com/example-org/example-repo/pull/17",
        "--no-comment",
        "--fetch",
    )

    assert result.returncode == 0, result.stderr
    assert "samorev fetch summary" in result.stdout
    assert "provider=github" in result.stdout
    assert "title=Demo PR" in result.stdout
    assert "state=OPEN" in result.stdout
    assert "draft=false" in result.stdout
    assert "diff_lines=3" in result.stdout
    assert "diff_added=1" in result.stdout
    assert "diff_removed=1" in result.stdout
    assert "comments_count=2" in result.stdout
    assert "commits_count=3" in result.stdout
    assert "ci_status=failure" in result.stdout
    assert "ci_summary=total=2 success=1 failure=1 pending=0 other=0" in result.stdout
    assert "no_comment=true" in result.stdout
    assert "live_posting=not-run" in result.stdout


def test_gitlab_fetch_falls_back_to_public_api_and_renders_summary(monkeypatch):
    from lib.provider_planning import parse_review_reference, plan_fetch
    from samorev import cli

    reference = parse_review_reference("https://gitlab.com/example-group/example-project/-/merge_requests/42")
    plan = plan_fetch(reference)

    monkeypatch.setattr(cli.shutil, "which", lambda command: "/usr/bin/glab" if command == "glab" else None)

    def fail_glab(command):
        raise cli.FetchError(f"glab unavailable for {' '.join(command)}")

    def fake_http_json(url):
        if url.endswith("/merge_requests/42"):
            return {
                "title": "GitLab fallback demo",
                "state": "opened",
                "draft": False,
                "head_pipeline": {"status": "failed"},
            }
        if url.endswith("/merge_requests/42/notes?per_page=100"):
            return [{"body": "first"}, {"body": "second"}]
        if url.endswith("/merge_requests/42/commits"):
            return [{"id": "abc"}, {"id": "def"}, {"id": "ghi"}]
        if url.endswith("/merge_requests/42/diffs"):
            return [
                {
                    "old_path": "app.py",
                    "new_path": "app.py",
                    "diff": "@@ -1 +1 @@\n-old = True\n+new = True\n",
                }
            ]
        raise AssertionError(f"unexpected GitLab API URL: {url}")

    monkeypatch.setattr(cli, "_run_json", fail_glab)
    monkeypatch.setattr(cli, "_http_json", fake_http_json)

    summary = cli.fetch_review_summary(reference, plan, cli.PROMPT_PATH, blocking=True)

    assert "samorev fetch summary" in summary
    assert "provider=gitlab" in summary
    assert "kind=mr" in summary
    assert "project=example-group/example-project" in summary
    assert "number=42" in summary
    assert "title=GitLab fallback demo" in summary
    assert "state=opened" in summary
    assert "draft=false" in summary
    assert "diff_lines=4" in summary
    assert "diff_added=1" in summary
    assert "diff_removed=1" in summary
    assert "comments_count=2" in summary
    assert "commits_count=3" in summary
    assert "ci_status=failed" in summary
    assert "ci_summary=pipeline_status=failed" in summary
    assert "blocking=true" in summary
    assert "no_comment=true" in summary
    assert "live_posting=not-run" in summary


def test_gitlab_public_api_fallback_keeps_fetching_when_notes_are_private(monkeypatch):
    from lib.provider_planning import parse_review_reference, plan_fetch
    from samorev import cli

    reference = parse_review_reference("https://gitlab.com/example-group/example-project/-/merge_requests/42")
    plan = plan_fetch(reference)

    monkeypatch.setattr(cli.shutil, "which", lambda command: None)

    def fake_http_json(url):
        if url.endswith("/merge_requests/42"):
            return {"title": "Public MR", "state": "merged", "draft": False, "head_pipeline": {"status": "success"}}
        if url.endswith("/merge_requests/42/notes?per_page=100"):
            raise cli.FetchError("notes are private")
        if url.endswith("/merge_requests/42/commits"):
            return [{"id": "abc"}]
        if url.endswith("/merge_requests/42/diffs"):
            return [{"old_path": "README.md", "new_path": "README.md", "diff": "+demo\n"}]
        raise AssertionError(f"unexpected GitLab API URL: {url}")

    monkeypatch.setattr(cli, "_http_json", fake_http_json)

    summary = cli.fetch_review_summary(reference, plan, cli.PROMPT_PATH, blocking=False)

    assert "provider=gitlab" in summary
    assert "title=Public MR" in summary
    assert "comments_count=0" in summary
    assert "commits_count=1" in summary
    assert "ci_status=success" in summary
    assert "no_comment=true" in summary
    assert "live_posting=not-run" in summary


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
    assert "samorev review <PR-or-MR> --no-comment --fetch" in readme
    assert "samorev review https://github.com/example-org/example-repo/pull/123 --no-comment --blocking" in readme
    assert "samorev review https://gitlab.com/example-org/example-repo/-/merge_requests/123 --no-comment" in readme
    assert "thin wrapper" in readme
