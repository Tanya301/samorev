#!/usr/bin/env python3
"""
review_memory.py — Fetch prior REV review context for a GitLab MR.

Usage:
    python3 lib/review_memory.py <PROJECT_URL_ENCODED> <MR_NUMBER>

Environment:
    GITLAB_TOKEN   — GitLab personal/CI token (required)
    GITLAB_HOST    — GitLab host (default: gitlab.com)

Outputs a formatted <prior_reviews> / <recent_discussion> block to stdout,
capped at 15k chars, suitable for injection into agent prompts.
"""

import json
import os
import re
import sys
import urllib.error
import urllib.request

HARD_CAP = 15_000
DISCUSSION_COMMENT_CAP = 1000


def fetch_notes(host: str, project_encoded: str, mr_number: str, token: str) -> list:
    """Fetch the last 10 notes for an MR from the GitLab API."""
    url = (
        f"https://{host}/api/v4/projects/{project_encoded}"
        f"/merge_requests/{mr_number}/notes?per_page=10&sort=desc"
    )
    req = urllib.request.Request(url, headers={"PRIVATE-TOKEN": token})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode())


def extract_prior_reviews(notes: list) -> str:
    """
    Extract findings from the last 2 REV reports using smart extraction.

    Instead of brute-truncating full reports (5–12k chars each), parse out
    just the structured findings: [SEVERITY] file:line — issue → Fix: ...
    This compresses a typical 7k report down to ~1.2k.
    """
    lines = []
    rev_count = 0

    for note in notes:
        body = note.get("body", "")
        if "REV Code Review Report" not in body and "REV-assisted review" not in body:
            continue

        rev_count += 1
        if rev_count > 2:
            break

        created = note.get("created_at", "")[:19]

        # Determine overall result
        result = "PASSED"
        bcount = re.search(r"BLOCKING ISSUES \((\d+)\)", body)
        if bcount:
            result = f"BLOCKED ({bcount.group(1)} blocking issues)"

        lines.append(f"--- Previous REV Review ({created}) — {result} ---")

        # Extract individual findings: **SEVERITY** `file:line` - issue
        blocks = re.split(r"(?=\*\*(?:CRITICAL|HIGH|MEDIUM|LOW|INFO)\*\*\s+[`])", body)
        for block in blocks:
            m = re.match(
                r"\*\*(\w+)\*\*\s+`([^`]+)`\s*[-\u2013\u2014]\s*(.+?)(?:\n|$)",
                block,
            )
            if not m:
                continue
            severity, location, issue = m.groups()
            entry = f"- [{severity}] {location}: {issue.strip()[:200]}"

            # Look for Fix: suggestion in the block
            fix_match = re.search(
                r"\*\*Fix:\*\*\s*(.+?)(?:\n\n|\n\*\*|\n-|\n---|\Z)",
                block,
                re.DOTALL,
            )
            if fix_match:
                fix_text = fix_match.group(1).strip()
                # Remove code blocks for compactness
                fix_text = re.sub(
                    r"```.*?```", "[code]", fix_text, flags=re.DOTALL
                )
                fix_text = fix_text[:150]
                entry += f" | Fix: {fix_text}"

            lines.append(entry)

        lines.append("")

    if rev_count == 0:
        return "NO_PRIOR_REVIEWS"

    return "\n".join(lines)


def extract_discussion(notes: list) -> str:
    """
    Extract the last 5 human discussion notes.

    Skips: system notes, REV reports, notes shorter than 10 chars.
    Truncates individual comments to 1000 chars.
    """
    discussion = []

    for note in notes:
        if note.get("system", False):
            continue
        body = note.get("body", "")
        if "REV Code Review Report" in body or "REV-assisted review" in body:
            continue
        if len(body.strip()) < 10:
            continue

        author = note.get("author", {}).get("name", "Unknown")
        created = note.get("created_at", "")[:19]
        truncated = body[:DISCUSSION_COMMENT_CAP]
        if len(body) > DISCUSSION_COMMENT_CAP:
            truncated += "... [truncated]"
        discussion.append(f"@{author} ({created}): {truncated}")

        if len(discussion) >= 5:
            break

    if not discussion:
        return "NO_DISCUSSION"

    return "\n\n".join(discussion)


def build_context(prior_reviews: str, recent_discussion: str) -> str:
    """Assemble the prior context block from extracted parts."""
    parts = []

    if prior_reviews != "NO_PRIOR_REVIEWS":
        parts.append(f"<prior_reviews>\n{prior_reviews}\n</prior_reviews>")

    if recent_discussion != "NO_DISCUSSION":
        parts.append(f"<recent_discussion>\n{recent_discussion}\n</recent_discussion>")

    if not parts:
        return ""

    context = "\n\n".join(parts) + "\n\n"

    if len(context) > HARD_CAP:
        context = context[:HARD_CAP]
        context += "\n... [prior context truncated to fit token budget]"

    return context


def main() -> int:
    if len(sys.argv) < 3:
        print(
            "Usage: review_memory.py <PROJECT_URL_ENCODED> <MR_NUMBER>",
            file=sys.stderr,
        )
        return 1

    project_encoded = sys.argv[1]
    mr_number = sys.argv[2]
    token = os.environ.get("GITLAB_TOKEN", "")
    host = os.environ.get("GITLAB_HOST", "gitlab.com")

    if not token:
        print("GITLAB_TOKEN not set", file=sys.stderr)
        return 1

    try:
        notes = fetch_notes(host, project_encoded, mr_number, token)
    except urllib.error.HTTPError as exc:
        print(f"GitLab API error: {exc.code} {exc.reason}", file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001
        print(f"Failed to fetch notes: {exc}", file=sys.stderr)
        return 1

    prior_reviews = extract_prior_reviews(notes)
    recent_discussion = extract_discussion(notes)
    context = build_context(prior_reviews, recent_discussion)

    if context:
        sys.stdout.write(context)

    return 0


if __name__ == "__main__":
    sys.exit(main())
