"""Thin CLI wrapper for LLM-run samorev reviews."""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import urlopen

from lib.provider_planning import ReviewReferenceError, parse_review_reference, plan_fetch


REPO_ROOT = Path(__file__).resolve().parent.parent
PROMPT_PATH = REPO_ROOT / ".claude" / "commands" / "review-mr.md"


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command == "review":
        return review(args, parser)

    parser.print_help(sys.stderr)
    return 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="samorev", description="Run samorev review workflows.")
    subparsers = parser.add_subparsers(dest="command")

    review_parser = subparsers.add_parser("review", help="Review a GitHub PR or GitLab MR")
    review_parser.add_argument("reference", help="GitHub PR/GitLab MR URL or numeric reference")
    review_parser.add_argument("--remote-url", default=None, help="Git remote URL for numeric references")
    review_parser.add_argument("--no-comment", action="store_true", help="Do not post a provider comment")
    review_parser.add_argument("--blocking", action="store_true", help="Return non-zero when blocking findings exist")
    review_parser.add_argument("--smoke", action="store_true", help="Validate planning/prompt wiring without running agents")
    review_parser.add_argument("--fetch", action="store_true", help="Fetch provider data and print a review summary")

    return parser


def review(args: argparse.Namespace, parser: argparse.ArgumentParser) -> int:
    try:
        reference = parse_review_reference(args.reference, remote_url=args.remote_url)
        plan = plan_fetch(reference)
    except ReviewReferenceError as exc:
        parser.exit(2, f"Error: {exc}\n")

    prompt = _prompt_path()
    if args.smoke:
        print(_format_smoke(reference, plan, prompt, no_comment=args.no_comment, blocking=args.blocking))
        return 0

    if args.fetch:
        if not args.no_comment:
            parser.exit(2, "Error: --fetch currently requires --no-comment because CLI posting is not enabled.\n")
        try:
            print(fetch_review_summary(reference, plan, prompt, blocking=args.blocking))
        except FetchError as exc:
            parser.exit(1, f"Error: {exc}\n")
        return 0

    if args.no_comment:
        print(_format_llm_run_instructions(reference, plan, prompt, blocking=args.blocking))
        return 0

    parser.exit(
        2,
        "Error: live posting from the CLI is not enabled yet. "
        "Use --no-comment, or --smoke for provider/prompt wiring checks.\n",
    )
    return 2


def _prompt_path() -> Path:
    if not PROMPT_PATH.exists():
        raise SystemExit(f"Error: review prompt not found at {PROMPT_PATH}")
    return PROMPT_PATH


def _format_smoke(reference, plan, prompt: Path, *, no_comment: bool, blocking: bool) -> str:
    lines = [
        "samorev review smoke",
        f"provider={reference.provider}",
        f"kind={reference.kind}",
        f"project={reference.project_path}",
        f"number={reference.number}",
        f"metadata_command={_display_command(plan.metadata_command)}",
        f"diff_command={_display_command(plan.diff_command)}",
        f"comments_command={_display_command(plan.comments_command)}",
        f"commits_command={_display_command(plan.commits_command)}",
        f"ci_command={_display_command(plan.ci_command)}",
        f"post_comment_command={_display_command(plan.post_comment_command)}",
        f"prompt={prompt.relative_to(REPO_ROOT)}",
        f"no_comment={str(no_comment).lower()}",
        f"blocking={str(blocking).lower()}",
        "live_posting=not-run",
    ]
    return "\n".join(lines)


def _format_llm_run_instructions(reference, plan, prompt: Path, *, blocking: bool) -> str:
    return "\n".join([
        "samorev CLI review handoff",
        f"Review: {reference.provider} {reference.kind} {reference.project_path}#{reference.number}",
        f"Prompt: {prompt}",
        f"Metadata: {_display_command(plan.metadata_command)}",
        f"Diff: {_display_command(plan.diff_command)}",
        f"Comments: {_display_command(plan.comments_command)}",
        f"Commits: {_display_command(plan.commits_command)}",
        f"CI: {_display_command(plan.ci_command)}",
        f"Blocking mode: {str(blocking).lower()}",
        "No provider comment will be posted because --no-comment was set.",
        "Use the existing review prompt content as the review procedure; this CLI only performs provider planning and handoff.",
    ])


def _display_command(command: tuple[str, ...]) -> str:
    return " ".join(command)


class FetchError(RuntimeError):
    """Raised when provider data cannot be fetched for report mode."""


def fetch_review_summary(reference, plan, prompt: Path, *, blocking: bool) -> str:
    if reference.provider == "github":
        fetched = _fetch_github(plan)
    elif reference.provider == "gitlab":
        fetched = _fetch_gitlab(reference, plan)
    else:
        raise FetchError(f"Unsupported provider: {reference.provider}")

    diff = _summarize_diff(fetched["diff"])
    ci = _summarize_ci(reference.provider, fetched["ci"])
    metadata = fetched["metadata"]
    if not isinstance(metadata, dict):
        raise FetchError("Provider metadata response was not a JSON object")
    comments_count = _count_json_items(fetched["comments"])
    commits_count = _count_json_items(fetched["commits"])

    title = str(metadata.get("title") or metadata.get("source_branch") or "(untitled)")
    state = str(metadata.get("state") or metadata.get("merge_status") or "unknown")
    draft = _metadata_draft(reference.provider, metadata)

    return "\n".join(
        [
            "samorev fetch summary",
            f"provider={reference.provider}",
            f"kind={reference.kind}",
            f"project={reference.project_path}",
            f"number={reference.number}",
            f"title={title}",
            f"state={state}",
            f"draft={str(draft).lower()}",
            f"diff_lines={diff['lines']}",
            f"diff_added={diff['added']}",
            f"diff_removed={diff['removed']}",
            f"diff_bytes={diff['bytes']}",
            f"comments_count={comments_count}",
            f"commits_count={commits_count}",
            f"ci_status={ci['status']}",
            f"ci_summary={ci['summary']}",
            f"prompt={prompt.relative_to(REPO_ROOT)}",
            f"blocking={str(blocking).lower()}",
            "no_comment=true",
            "live_posting=not-run",
        ]
    )


def _fetch_github(plan) -> dict[str, object]:
    return {
        "metadata": _run_json(plan.metadata_command),
        "diff": _run_text(plan.diff_command),
        "comments": _run_json(plan.comments_command),
        "commits": _run_json(plan.commits_command),
        "ci": _run_json(plan.ci_command),
    }


def _fetch_gitlab(reference, plan) -> dict[str, object]:
    if shutil.which("glab"):
        try:
            return {
                "metadata": _run_json(plan.metadata_command),
                "diff": _run_text(plan.diff_command),
                "comments": _run_json(plan.comments_command),
                "commits": _run_json(plan.commits_command),
                "ci": _run_json(plan.ci_command),
            }
        except FetchError:
            pass

    project = quote(reference.project_path, safe="")
    base = f"https://gitlab.com/api/v4/projects/{project}/merge_requests/{reference.number}"
    metadata = _http_json(base)
    comments = _http_json_or_default(f"{base}/notes?per_page=100", default=[])
    commits = _http_json(f"{base}/commits")
    diffs = _http_json(f"{base}/diffs")
    diff_text = _render_gitlab_diff_text(diffs)

    return {
        "metadata": metadata,
        "diff": diff_text,
        "comments": comments,
        "commits": commits,
        "ci": metadata,
    }


def _run_json(command: tuple[str, ...]) -> object:
    output = _run_text(command)
    try:
        return json.loads(output or "null")
    except json.JSONDecodeError as exc:
        raise FetchError(f"{command[0]} returned invalid JSON for {_display_command(command)}: {exc}") from exc


def _run_text(command: tuple[str, ...]) -> str:
    try:
        result = subprocess.run(command, check=False, capture_output=True, text=True)
    except FileNotFoundError as exc:
        raise FetchError(f"Required provider command not found: {command[0]}") from exc

    if result.returncode != 0:
        stderr = result.stderr.strip()
        detail = f": {stderr}" if stderr else ""
        raise FetchError(f"Command failed ({result.returncode}) for {_display_command(command)}{detail}")
    return result.stdout


def _http_json(url: str) -> object:
    try:
        with urlopen(url, timeout=20) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        raise FetchError(f"GitLab public API request failed ({exc.code}) for {url}") from exc
    except URLError as exc:
        raise FetchError(f"GitLab public API request failed for {url}: {exc.reason}") from exc
    except json.JSONDecodeError as exc:
        raise FetchError(f"GitLab public API returned invalid JSON for {url}: {exc}") from exc


def _http_json_or_default(url: str, *, default: object) -> object:
    try:
        return _http_json(url)
    except FetchError:
        return default


def _render_gitlab_diff_text(diffs: object) -> str:
    if not isinstance(diffs, list):
        return ""
    parts = []
    for item in diffs:
        if not isinstance(item, dict):
            continue
        old_path = item.get("old_path") or item.get("new_path") or "unknown"
        new_path = item.get("new_path") or old_path
        diff = item.get("diff") or ""
        parts.append(f"diff --git a/{old_path} b/{new_path}\n{diff}")
    return "\n".join(parts)


def _summarize_diff(diff_text: str) -> dict[str, int]:
    lines = diff_text.splitlines()
    added = sum(1 for line in lines if line.startswith("+") and not line.startswith("+++"))
    removed = sum(1 for line in lines if line.startswith("-") and not line.startswith("---"))
    return {
        "lines": len(lines),
        "added": added,
        "removed": removed,
        "bytes": len(diff_text.encode("utf-8")),
    }


def _count_json_items(value: object) -> int:
    if isinstance(value, list):
        return len(value)
    if isinstance(value, dict):
        for key in ("comments", "commits", "nodes", "values"):
            nested = value.get(key)
            if isinstance(nested, list):
                return len(nested)
        if isinstance(value.get("total_count"), int):
            return int(value["total_count"])
    return 0


def _metadata_draft(provider: str, metadata: object) -> bool:
    if not isinstance(metadata, dict):
        return False
    if provider == "github":
        return bool(metadata.get("isDraft"))
    if "draft" in metadata:
        return bool(metadata.get("draft"))
    return str(metadata.get("work_in_progress", "false")).lower() == "true"


def _summarize_ci(provider: str, ci: object) -> dict[str, str]:
    if provider == "github":
        return _summarize_github_ci(ci)
    return _summarize_gitlab_ci(ci)


def _summarize_github_ci(ci: object) -> dict[str, str]:
    check_runs = ci.get("check_runs", []) if isinstance(ci, dict) else []
    if not isinstance(check_runs, list):
        check_runs = []

    counts = {"success": 0, "failure": 0, "pending": 0, "other": 0}
    for run in check_runs:
        if not isinstance(run, dict):
            counts["other"] += 1
            continue
        conclusion = run.get("conclusion")
        status = run.get("status")
        if conclusion == "success":
            counts["success"] += 1
        elif conclusion in {"failure", "cancelled", "timed_out", "action_required"}:
            counts["failure"] += 1
        elif status != "completed" or conclusion is None:
            counts["pending"] += 1
        else:
            counts["other"] += 1

    total = len(check_runs)
    if counts["failure"]:
        status = "failure"
    elif counts["pending"]:
        status = "pending"
    elif total and counts["success"] == total:
        status = "success"
    elif total == 0:
        status = "none"
    else:
        status = "unknown"
    summary = (
        f"total={total} success={counts['success']} failure={counts['failure']} "
        f"pending={counts['pending']} other={counts['other']}"
    )
    return {"status": status, "summary": summary}


def _summarize_gitlab_ci(ci: object) -> dict[str, str]:
    if not isinstance(ci, dict):
        return {"status": "unknown", "summary": "pipeline_status=unknown"}
    pipeline = ci.get("head_pipeline")
    if isinstance(pipeline, dict):
        status = str(pipeline.get("status") or "unknown")
    else:
        status = str(ci.get("pipeline_status") or ci.get("state") or "unknown")
    return {"status": status, "summary": f"pipeline_status={status}"}


if __name__ == "__main__":
    raise SystemExit(main())
