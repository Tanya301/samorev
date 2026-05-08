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
        metadata_command=("gh", "pr", "view", "17", "--repo", "example-org/example-repo", "--json", "author,baseRefName,body,headRefName,isDraft,number,state,title,url"),
        diff_command=("gh", "pr", "diff", "17", "--repo", "example-org/example-repo"),
        api_resource="repos/example-org/example-repo/pulls/17",
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
        metadata_command=("glab", "mr", "view", "123", "--repo", "postgres-ai/platform", "--output", "json"),
        diff_command=("glab", "mr", "diff", "123", "--repo", "postgres-ai/platform"),
        api_resource="projects/postgres-ai%2Fplatform/merge_requests/123",
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
