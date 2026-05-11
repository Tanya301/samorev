"""Thin CLI wrapper for LLM-run samorev reviews."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

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


if __name__ == "__main__":
    raise SystemExit(main())
