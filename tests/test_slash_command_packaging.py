"""Slash-command packaging and release-readiness tests for samorev."""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_installer_links_slash_command_from_clean_checkout(tmp_path: Path):
    home = tmp_path / "home"
    env = {**os.environ, "HOME": str(home)}

    result = subprocess.run(
        ["bash", "scripts/install-claude-command.sh"],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
    )

    command_path = home / ".claude" / "commands" / "review-mr.md"
    assert result.returncode == 0, result.stderr
    assert command_path.is_symlink()
    assert command_path.resolve() == ROOT / ".claude" / "commands" / "review-mr.md"
    assert "Installed /review-mr" in result.stdout


def test_installed_command_finds_helper_from_arbitrary_repo(tmp_path: Path):
    home = tmp_path / "home"
    installed_root = home / ".claude" / "samorev"
    target_repo = tmp_path / "target-repo"
    installed_root.parent.mkdir(parents=True)
    target_repo.mkdir()
    installed_root.symlink_to(ROOT, target_is_directory=True)

    command = read(".claude/commands/review-mr.md")
    step_1_section = command.split("### Step 1: Parse review reference", 1)[1]
    step_1 = step_1_section.split("```bash\n", 1)[1].split("\n```\n\n### Step 2", 1)[0]
    result = subprocess.run(
            [
                "bash",
                "-c",
                "ARGUMENTS=https://github.com/example-org/example-repo/pull/17\n"
                + step_1
                + "\nprintf 'provider=%s\\nproject=%s\\n' \"$REVIEW_PROVIDER\" \"$PROJECT\"\n",
            ],
        cwd=target_repo,
        env={**os.environ, "HOME": str(home)},
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    assert "provider=github" in result.stdout
    assert "project=example-org/example-repo" in result.stdout


def test_installer_refuses_to_overwrite_existing_user_command(tmp_path: Path):
    home = tmp_path / "home"
    command_dir = home / ".claude" / "commands"
    command_dir.mkdir(parents=True)
    command_path = command_dir / "review-mr.md"
    command_path.write_text("user custom command\n", encoding="utf-8")

    result = subprocess.run(
        ["bash", "scripts/install-claude-command.sh"],
        cwd=ROOT,
        env={**os.environ, "HOME": str(home)},
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert "already exists" in result.stderr
    assert command_path.read_text(encoding="utf-8") == "user custom command\n"


def test_slash_command_delegates_to_provider_planning_core():
    command = read(".claude/commands/review-mr.md")

    assert "lib/provider_planning.py" in command
    assert "$HOME/.claude/samorev/lib/provider_planning.py" in command
    assert 'if [ "$REVIEW_PROVIDER" = "github" ]; then' in command
    assert "$METADATA_COMMAND" in command
    assert "$DIFF_COMMAND" in command
    assert "$COMMENTS_COMMAND" in command
    assert "$COMMITS_COMMAND" in command
    assert "$CI_COMMAND" in command
    assert "$POST_COMMENT_COMMAND" in command


def test_provider_planning_script_supports_github_and_gitlab_smoke_paths():
    github = subprocess.run(
        [
            sys.executable,
            "lib/provider_planning.py",
            "https://github.com/example-org/example-repo/pull/17",
            "--shell",
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    assert github.returncode == 0, github.stderr
    assert "REVIEW_PROVIDER=github" in github.stdout
    assert "REVIEW_KIND=pr" in github.stdout
    assert "METADATA_COMMAND='gh pr view 17 --repo example-org/example-repo" in github.stdout
    assert "POST_COMMENT_COMMAND='gh pr comment 17 --repo example-org/example-repo" in github.stdout

    gitlab = subprocess.run(
        [
            sys.executable,
            "lib/provider_planning.py",
            "123",
            "--remote-url",
            "git@gitlab.com:example-group/example-project.git",
            "--shell",
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    assert gitlab.returncode == 0, gitlab.stderr
    assert "REVIEW_PROVIDER=gitlab" in gitlab.stdout
    assert "REVIEW_KIND=mr" in gitlab.stdout
    assert "PROJECT=example-group/example-project" in gitlab.stdout
    assert "METADATA_COMMAND=" in gitlab.stdout
    assert "POST_COMMENT_COMMAND=" in gitlab.stdout


def test_install_docs_cover_prompt_pack_auth_provenance_and_tag_readiness():
    readme = read("README.md")

    assert "Claude Code prompt/command pack" in readme
    assert "scripts/install-claude-command.sh" in readme
    assert "/review-mr https://github.com/example-org/example-repo/pull/123" in readme
    assert "/review-mr https://gitlab.com/example-org/example-repo/-/merge_requests/123" in readme
    assert "gh auth login" in readme
    assert "glab auth login" in readme
    assert "GitHub PR support is planned" not in readme
    assert "Source history: seeded from https://gitlab.com/postgres-ai/rev" in readme
    assert "Release provenance checklist" in readme
    assert "Standalone CLI" in readme


def test_github_actions_runs_tests_and_slash_command_smoke():
    workflow = read(".github/workflows/ci.yml")

    assert "pull_request:" in workflow
    assert "push:" in workflow
    assert "python-version: '3.11'" in workflow
    assert "python -m pytest tests/ -m 'not api' -q" in workflow
    assert "bash scripts/install-claude-command.sh" in workflow
    assert "python lib/provider_planning.py https://github.com/example-org/example-repo/pull/17 --shell" in workflow
