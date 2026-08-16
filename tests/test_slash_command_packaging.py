"""Slash-command packaging and release-readiness tests for samorev."""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def command_step(header: str, next_header: str) -> str:
    command = read(".claude/commands/review-mr.md")
    section = command.split(header, 1)[1].split(next_header, 1)[0]
    return section.split("```bash\n", 1)[1].split("\n```", 1)[0]


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
    install_root = home / ".claude" / "samorev"
    assert install_root.is_symlink()
    assert (install_root / "lib" / "provider_planning.py").is_file()
    assert (install_root / "scripts" / "summarize-github-ci.sh").is_file()
    assert "Installed /review-mr" in result.stdout


def test_existing_command_link_still_provisions_missing_helper_root(tmp_path: Path):
    home = tmp_path / "home"
    command_path = home / ".claude" / "commands" / "review-mr.md"
    command_path.parent.mkdir(parents=True)
    command_path.symlink_to(ROOT / ".claude" / "commands" / "review-mr.md")

    result = subprocess.run(
        ["bash", "scripts/install-claude-command.sh"], cwd=ROOT,
        env={**os.environ, "HOME": str(home)}, capture_output=True, text=True,
    )

    assert result.returncode == 0, result.stderr
    assert (home / ".claude" / "samorev").is_symlink()
    assert "trusted helper root verified" in result.stdout


def test_installer_accepts_checkout_at_default_install_root(tmp_path: Path):
    home = tmp_path / "home"
    checkout = home / ".claude" / "samorev"
    for relative in [
        "scripts/install-claude-command.sh",
        "scripts/summarize-github-ci.sh",
        "lib/provider_planning.py",
        "lib/review_memory.py",
        "lib/compliance.py",
        ".claude/commands/review-mr.md",
    ]:
        destination = checkout / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / relative, destination)

    result = subprocess.run(
        ["bash", "scripts/install-claude-command.sh"],
        cwd=checkout,
        env={**os.environ, "HOME": str(home)},
        capture_output=True,
        text=True,
    )

    command_path = home / ".claude" / "commands" / "review-mr.md"
    assert result.returncode == 0, result.stderr
    assert command_path.is_symlink()
    assert command_path.resolve() == checkout / ".claude" / "commands" / "review-mr.md"


def test_installer_canonicalizes_symlinked_checkout_parent(tmp_path: Path):
    home = tmp_path / "home"
    physical_parent = tmp_path / "physical"
    logical_parent = tmp_path / "logical"
    checkout = physical_parent / "samorev"
    physical_parent.mkdir()
    logical_parent.symlink_to(physical_parent, target_is_directory=True)
    shutil.copytree(ROOT, checkout, symlinks=True, ignore=shutil.ignore_patterns("node_modules", ".git"))

    env = {**os.environ, "HOME": str(home), "SAMOREV_INSTALL_ROOT": str(home / ".claude" / "samorev")}
    first = subprocess.run(
        ["bash", "scripts/install-claude-command.sh"], cwd=logical_parent / "samorev", env=env, capture_output=True, text=True
    )
    (home / ".claude" / "commands" / "review-mr.md").unlink()
    second = subprocess.run(
        ["bash", "scripts/install-claude-command.sh"], cwd=logical_parent / "samorev", env=env, capture_output=True, text=True
    )

    assert first.returncode == 0, first.stderr
    assert second.returncode == 0, second.stderr
    assert "Installed /review-mr" in second.stdout


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


def test_nondefault_install_root_is_used_by_step_one(tmp_path: Path):
    home = tmp_path / "home"
    install_root = home / "trusted" / "samorev"
    target_repo = tmp_path / "target-repo"
    target_repo.mkdir()
    env = {**os.environ, "HOME": str(home), "SAMOREV_INSTALL_ROOT": str(install_root)}
    installed = subprocess.run(
        ["bash", "scripts/install-claude-command.sh"], cwd=ROOT, env=env, capture_output=True, text=True,
    )
    assert installed.returncode == 0, installed.stderr

    command = read(".claude/commands/review-mr.md")
    step_1_section = command.split("### Step 1: Parse review reference", 1)[1]
    step_1 = step_1_section.split("```bash\n", 1)[1].split("\n```\n\n### Step 2", 1)[0]
    result = subprocess.run(
        ["bash", "-c", "ARGUMENTS=https://github.com/example-org/example-repo/pull/17\n" + step_1 + "\nprintf '%s\n' \"$SAMOREV_ROOT\"\n"],
        cwd=target_repo, env=env, capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr
    assert str(install_root) in result.stdout


def test_github_ci_step_executes_summarizer_and_fails_closed(tmp_path: Path):
    step = command_step("### Step 2.4: CI/pipeline status check", "### Step 2.5: Compliance mode detection")
    base_env = {
        key: value for key, value in os.environ.items()
        if not key.startswith("SAMOREV_IGNORED_GITHUB_CHECK_")
        and key not in {"REV_ROOT", "SAMOREV_INSTALL_ROOT"}
    }
    cases = [
        (
            "printf '%s' '{\"check_runs\":[{\"id\":1,\"name\":\"unit\",\"status\":\"completed\",\"conclusion\":\"success\"}]}'",
            {**base_env, "SAMOREV_INSTALL_ROOT": str(ROOT)},
            "success 0",
        ),
        ("false", {**base_env, "SAMOREV_INSTALL_ROOT": str(ROOT)}, "fetch-error 0"),
        (
            "printf '%s' '{\"check_runs\":[{\"conclusion\":\"success\"}]}'",
            {**base_env, "HOME": str(tmp_path)},
            "fetch-error 0",
        ),
    ]
    for ci_command, env, expected in cases:
        env = {**env, "CI_COMMAND": ci_command}
        result = subprocess.run(
            ["bash", "-c", (
                "set -euo pipefail\n"
                "REVIEW_PROVIDER=github\n"
                + step
                + "\nprintf '%s %s\\n' \"$PIPELINE_STATUS\" \"$EXCLUDED_SELF\"\n"
            )],
            cwd=ROOT, env=env, capture_output=True, text=True,
        )
        assert result.returncode == 0, result.stderr
        assert result.stdout.strip().endswith(expected), result.stdout


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
    assert not (home / ".claude" / "samorev").exists()


def test_installer_rejects_unrelated_occupied_install_root(tmp_path: Path):
    home = tmp_path / "home"
    occupied = home / ".claude" / "samorev"
    occupied.mkdir(parents=True)
    (occupied / "owner.txt").write_text("unrelated\n", encoding="utf-8")

    result = subprocess.run(
        ["bash", "scripts/install-claude-command.sh"],
        cwd=ROOT,
        env={**os.environ, "HOME": str(home)},
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert "occupied by a different checkout" in result.stderr
    assert (occupied / "owner.txt").read_text(encoding="utf-8") == "unrelated\n"
    assert not (home / ".claude" / "commands" / "review-mr.md").exists()


def test_installer_rejects_dangling_install_root_with_actionable_error(tmp_path: Path):
    home = tmp_path / "home"
    install_root = home / ".claude" / "samorev"
    install_root.parent.mkdir(parents=True)
    install_root.symlink_to(tmp_path / "missing-checkout", target_is_directory=True)

    result = subprocess.run(
        ["bash", "scripts/install-claude-command.sh"], cwd=ROOT,
        env={**os.environ, "HOME": str(home)}, capture_output=True, text=True,
    )

    assert result.returncode != 0
    assert "cannot resolve install root" in result.stderr
    assert not (home / ".claude" / "commands" / "review-mr.md").exists()


def test_incomplete_checkout_leaves_no_install_root(tmp_path: Path):
    home = tmp_path / "home"
    checkout = tmp_path / "incomplete"
    (checkout / "scripts").mkdir(parents=True)
    (checkout / ".claude" / "commands").mkdir(parents=True)
    shutil.copy2(ROOT / "scripts" / "install-claude-command.sh", checkout / "scripts" / "install-claude-command.sh")
    shutil.copy2(ROOT / ".claude" / "commands" / "review-mr.md", checkout / ".claude" / "commands" / "review-mr.md")

    result = subprocess.run(
        ["bash", "scripts/install-claude-command.sh"], cwd=checkout,
        env={**os.environ, "HOME": str(home)}, capture_output=True, text=True,
    )

    assert result.returncode != 0
    assert "helper set is incomplete" in result.stderr
    assert not (home / ".claude" / "samorev").exists()


def test_slash_command_delegates_to_provider_planning_core():
    command = read(".claude/commands/review-mr.md")

    assert "lib/provider_planning.py" in command
    assert "$HOME/.claude/samorev/lib/provider_planning.py" in command
    assert '"$PWD/lib/provider_planning.py"' not in command
    assert '"$PWD/rev/lib/provider_planning.py"' not in command
    assert 'python3 "$REPO_ROOT/lib/' not in command
    assert 'python3 "$SAMOREV_ROOT/lib/review_memory.py"' in command
    assert 'os.path.join(samorev_root, "lib")' in command
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


def test_bun_package_replaces_obsolete_python_package_wrapper():
    package_json = read("package.json")

    assert '"bin":' in package_json
    assert '"samorev": "./dist/cli.js"' in package_json
    assert not (ROOT / "pyproject.toml").exists()
    assert not (ROOT / "samorev" / "cli.py").exists()
    assert not (ROOT / "samorev" / "__init__.py").exists()
    assert not (ROOT / "samorev" / "py.typed").exists()


def test_linguist_overrides_keep_compatibility_python_out_of_language_stats():
    attributes = read(".gitattributes")

    assert "lib/**/*.py linguist-vendored" in attributes
    assert "tests/**/*.py linguist-vendored" in attributes
    assert "tests/lib/**/*.sh linguist-vendored" in attributes
    assert ".claude/commands/*.md linguist-documentation" in attributes
    assert "agents/*.md linguist-documentation" in attributes

    result = subprocess.run(
        [
            "git",
            "check-attr",
            "linguist-vendored",
            "linguist-documentation",
            "--",
            "lib/provider_planning.py",
            "tests/test_provider_planning.py",
            "tests/lib/runner.sh",
            ".claude/commands/review-mr.md",
            "agents/bug-hunter.md",
            "src/cli.ts",
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    assert "lib/provider_planning.py: linguist-vendored: set" in result.stdout
    assert "tests/test_provider_planning.py: linguist-vendored: set" in result.stdout
    assert "tests/lib/runner.sh: linguist-vendored: set" in result.stdout
    assert ".claude/commands/review-mr.md: linguist-documentation: set" in result.stdout
    assert "agents/bug-hunter.md: linguist-documentation: set" in result.stdout
    assert "src/cli.ts: linguist-vendored: unspecified" in result.stdout
    assert "src/cli.ts: linguist-documentation: unspecified" in result.stdout


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
    assert "CLI-first" in readme


def test_github_actions_runs_tests_and_slash_command_smoke():
    workflow = read(".github/workflows/ci.yml")

    assert "pull_request:" in workflow
    assert "push:" in workflow
    assert "python-version: '3.11'" in workflow
    assert "oven-sh/setup-bun@v2" in workflow
    assert "bun install" in workflow
    assert "bun test" in workflow
    assert "bun run build" in workflow
    assert "python -m pytest tests/ -m 'not api' -q" in workflow
    assert "bash scripts/install-claude-command.sh" in workflow
    assert "bun run samorev review https://github.com/example-org/example-repo/pull/17 --no-comment --blocking --smoke" in workflow
    assert "python lib/provider_planning.py https://github.com/example-org/example-repo/pull/17 --shell" in workflow
