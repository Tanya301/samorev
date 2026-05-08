"""Tests for provider detection and fetch planning."""
from __future__ import annotations

import sys
from pathlib import Path


sys.path.insert(0, str(Path(__file__).parent.parent / "lib"))

from provider_planning import (  # noqa: E402
    FetchPlan,
    ReviewReference,
    plan_fetch,
    parse_review_reference,
    to_shell_exports,
)


def test_github_pr_url_detection_and_fetch_plan():
    reference = parse_review_reference(
        "https://github.com/example-org/example-repo/pull/17",
        remote_url="https://github.com/ignored/project.git",
    )

    assert reference == ReviewReference(
        provider="github",
        owner="example-org",
        repo="example-repo",
        number=17,
        kind="pr",
    )

    assert plan_fetch(reference) == FetchPlan(
        provider="github",
        metadata_command=("gh", "pr", "view", "17", "--repo", "example-org/example-repo", "--json", "assignees,author,baseRefName,body,headRefName,isDraft,labels,number,reviewRequests,state,title,url"),
        diff_command=("gh", "pr", "diff", "17", "--repo", "example-org/example-repo"),
        api_resource="repos/example-org/example-repo/pulls/17",
        comments_command=("gh", "api", "repos/example-org/example-repo/issues/17/comments", "--paginate"),
        commits_command=("gh", "api", "repos/example-org/example-repo/pulls/17/commits", "--paginate"),
        ci_command=("gh", "api", "repos/example-org/example-repo/commits/pull/17/head/check-runs", "--paginate"),
        failed_jobs_command=("gh", "run", "view", "$RUN_ID", "--repo", "example-org/example-repo", "--json", "jobs"),
        failed_job_log_command=("gh", "run", "view", "$RUN_ID", "--repo", "example-org/example-repo", "--job", "$JOB_ID", "--log-failed"),
        post_comment_command=("gh", "pr", "comment", "17", "--repo", "example-org/example-repo", "--body-file", "-"),
    )


def test_gitlab_mr_url_preserves_existing_fetch_plan():
    reference = parse_review_reference(
        "https://gitlab.com/postgres-ai/platform/-/merge_requests/123",
        remote_url="https://github.com/ignored/project.git",
    )

    assert reference == ReviewReference(
        provider="gitlab",
        owner="postgres-ai",
        repo="platform",
        number=123,
        kind="mr",
    )

    assert plan_fetch(reference) == FetchPlan(
        provider="gitlab",
        metadata_command=("glab", "api", "projects/postgres-ai%2Fplatform/merge_requests/123"),
        diff_command=("glab", "mr", "diff", "123", "--repo", "postgres-ai/platform"),
        api_resource="projects/postgres-ai%2Fplatform/merge_requests/123",
        comments_command=("glab", "api", "projects/postgres-ai%2Fplatform/merge_requests/123/notes?per_page=10&sort=desc"),
        commits_command=("glab", "api", "projects/postgres-ai%2Fplatform/merge_requests/123/commits"),
        ci_command=("glab", "api", "projects/postgres-ai%2Fplatform/merge_requests/123"),
        failed_jobs_command=("glab", "api", "projects/postgres-ai%2Fplatform/pipelines/$PIPELINE_ID/jobs"),
        failed_job_log_command=("glab", "api", "projects/postgres-ai%2Fplatform/jobs/$JOB_ID/trace"),
        post_comment_command=("glab", "mr", "comment", "123", "--repo", "postgres-ai/platform", "-m", "$REPORT"),
    )


def test_numeric_reference_uses_remote_provider_context():
    reference = parse_review_reference(
        "456",
        remote_url="git@github.com:example-org/example-repo.git",
    )

    assert reference == ReviewReference(
        provider="github",
        owner="example-org",
        repo="example-repo",
        number=456,
        kind="pr",
    )


def test_github_fetch_plan_is_end_to_end_and_not_gitlab_mandatory():
    reference = parse_review_reference("https://github.com/example-org/example-repo/pull/17")
    plan = plan_fetch(reference)

    all_commands = (
        plan.metadata_command
        + plan.diff_command
        + plan.comments_command
        + plan.commits_command
        + plan.ci_command
        + plan.failed_jobs_command
        + plan.failed_job_log_command
        + plan.post_comment_command
    )
    rendered = " ".join(all_commands)

    assert "gh pr view" in " ".join(plan.metadata_command)
    assert "gh pr diff" in " ".join(plan.diff_command)
    assert "repos/example-org/example-repo/issues/17/comments" in " ".join(plan.comments_command)
    assert "repos/example-org/example-repo/pulls/17/commits" in " ".join(plan.commits_command)
    assert "repos/example-org/example-repo/commits/pull/17/head/check-runs" in " ".join(plan.ci_command)
    assert "gh run view" in " ".join(plan.failed_jobs_command)
    assert "--log-failed" in plan.failed_job_log_command
    assert "gh pr comment" in " ".join(plan.post_comment_command)
    assert "glab" not in rendered


def test_review_command_has_provider_specific_mandatory_sections():
    command_text = (Path(__file__).parent.parent / ".claude/commands/review-mr.md").read_text()

    assert 'if [ "$REVIEW_PROVIDER" = "github" ]; then' in command_text
    assert "$COMMENTS_COMMAND" in command_text
    assert "$COMMITS_COMMAND" in command_text
    assert "$CI_COMMAND" in command_text
    assert "$FAILED_JOBS_COMMAND" in command_text
    assert "$FAILED_JOB_LOG_COMMAND" in command_text
    assert "$POST_COMMENT_COMMAND" in command_text
    assert "gh pr comment" in command_text


def test_shell_exports_include_end_to_end_provider_operations():
    reference = parse_review_reference("https://github.com/example-org/example-repo/pull/17")
    exports = to_shell_exports(reference, plan_fetch(reference))

    assert "COMMENTS_COMMAND=" in exports
    assert "COMMITS_COMMAND=" in exports
    assert "CI_COMMAND=" in exports
    assert "FAILED_JOBS_COMMAND=" in exports
    assert "FAILED_JOB_LOG_COMMAND=" in exports
    assert "POST_COMMENT_COMMAND=" in exports
