"""Provider detection and fetch planning for review references."""
from __future__ import annotations

import argparse
import re
import shlex
from dataclasses import dataclass
from typing import Literal
from urllib.parse import quote


Provider = Literal["github", "gitlab"]
ReviewKind = Literal["pr", "mr"]

_PATH_PART = r"[a-zA-Z0-9_.-]+"
_PROJECT_PATH = rf"(?:{_PATH_PART}/)+{_PATH_PART}"
_RUNTIME_VARIABLES = frozenset({"RUN_ID", "JOB_ID", "PIPELINE_ID", "REPORT"})
_RUNTIME_VARIABLE_PATTERN = re.compile(r"\$(RUN_ID|JOB_ID|PIPELINE_ID|REPORT)\b")


@dataclass(frozen=True)
class ReviewReference:
    """A normalized Git provider review reference."""

    provider: Provider
    owner: str
    repo: str
    number: int
    kind: ReviewKind

    @property
    def project_path(self) -> str:
        return f"{self.owner}/{self.repo}"


@dataclass(frozen=True)
class FetchPlan:
    """Provider-specific commands/resources needed to fetch review data."""

    provider: Provider
    metadata_command: tuple[str, ...]
    diff_command: tuple[str, ...]
    api_resource: str
    comments_command: tuple[str, ...]
    commits_command: tuple[str, ...]
    ci_command: tuple[str, ...]
    failed_jobs_command: tuple[str, ...]
    failed_job_log_command: tuple[str, ...]
    post_comment_command: tuple[str, ...]


class ReviewReferenceError(ValueError):
    """Raised when a review reference cannot be parsed safely."""


def parse_review_reference(ref: str, remote_url: str | None = None) -> ReviewReference:
    """Parse a GitHub PR or GitLab MR reference.

    Full URLs carry their provider and project context. Numeric references use
    the current repository remote URL to decide whether the number is a GitHub
    PR or GitLab MR.
    """
    ref = ref.strip()

    github_url = re.fullmatch(
        rf"https://github\.com/({_PATH_PART})/({_PATH_PART})/pull/([0-9]+)",
        ref,
    )
    if github_url:
        return ReviewReference(
            provider="github",
            owner=github_url.group(1),
            repo=github_url.group(2),
            number=int(github_url.group(3)),
            kind="pr",
        )

    gitlab_url = re.fullmatch(
        rf"https://gitlab\.com/({_PROJECT_PATH})/-/merge_requests/([0-9]+)",
        ref,
    )
    if gitlab_url:
        return _build_gitlab_reference(gitlab_url.group(1), gitlab_url.group(2))

    if re.fullmatch(r"[0-9]+", ref):
        if not remote_url:
            raise ReviewReferenceError("Numeric reference requires a git remote URL")
        remote = parse_remote_url(remote_url)
        return ReviewReference(
            provider=remote.provider,
            owner=remote.owner,
            repo=remote.repo,
            number=int(ref),
            kind="pr" if remote.provider == "github" else "mr",
        )

    raise ReviewReferenceError("Invalid review reference - must be URL or number")


def parse_remote_url(remote_url: str) -> ReviewReference:
    """Parse a GitHub or GitLab remote URL into provider/project context."""
    patterns: tuple[tuple[Provider, str], ...] = (
        ("github", rf"(?:git@github\.com:|https://github\.com/|ssh://git@github\.com/)(?P<path>{_PATH_PART}/{_PATH_PART})(?:\.git)?"),
        ("gitlab", rf"(?:git@gitlab\.com:|https://gitlab\.com/|ssh://git@gitlab\.com/)(?P<path>{_PROJECT_PATH})(?:\.git)?"),
    )
    for provider, pattern in patterns:
        match = re.fullmatch(pattern, remote_url.strip())
        if not match:
            continue
        path = match.group("path")
        if path.endswith(".git"):
            path = path[:-4]
        if provider == "github":
            owner, repo = path.split("/", 1)
            return ReviewReference(provider="github", owner=owner, repo=repo, number=0, kind="pr")
        return _build_gitlab_reference(path, "0")

    raise ReviewReferenceError("Remote is not a supported GitHub or GitLab repository")


def plan_fetch(reference: ReviewReference) -> FetchPlan:
    """Build provider-specific fetch commands and API resource identifiers."""
    number = str(reference.number)
    project = reference.project_path

    if reference.provider == "github":
        json_fields = "assignees,author,baseRefName,body,headRefName,isDraft,labels,number,reviewRequests,state,title,url"
        return FetchPlan(
            provider="github",
            metadata_command=(
                "gh",
                "pr",
                "view",
                number,
                "--repo",
                project,
                "--json",
                json_fields,
            ),
            diff_command=("gh", "pr", "diff", number, "--repo", project),
            api_resource=f"repos/{project}/pulls/{number}",
            comments_command=("gh", "api", f"repos/{project}/issues/{number}/comments", "--paginate"),
            commits_command=("gh", "api", f"repos/{project}/pulls/{number}/commits", "--paginate"),
            ci_command=("gh", "api", f"repos/{project}/commits/pull/{number}/head/check-runs", "--paginate"),
            failed_jobs_command=("gh", "run", "view", "$RUN_ID", "--repo", project, "--json", "jobs"),
            failed_job_log_command=(
                "gh",
                "run",
                "view",
                "$RUN_ID",
                "--repo",
                project,
                "--job",
                "$JOB_ID",
                "--log-failed",
            ),
            post_comment_command=("gh", "pr", "comment", number, "--repo", project, "--body-file", "-"),
        )

    if reference.provider == "gitlab":
        encoded_project = quote(project, safe="")
        return FetchPlan(
            provider="gitlab",
            metadata_command=("glab", "api", f"projects/{encoded_project}/merge_requests/{number}"),
            diff_command=("glab", "mr", "diff", number, "--repo", project),
            api_resource=f"projects/{encoded_project}/merge_requests/{number}",
            comments_command=(
                "glab",
                "api",
                f"projects/{encoded_project}/merge_requests/{number}/notes?per_page=10&sort=desc",
            ),
            commits_command=("glab", "api", f"projects/{encoded_project}/merge_requests/{number}/commits"),
            ci_command=("glab", "api", f"projects/{encoded_project}/merge_requests/{number}"),
            failed_jobs_command=("glab", "api", f"projects/{encoded_project}/pipelines/$PIPELINE_ID/jobs"),
            failed_job_log_command=("glab", "api", f"projects/{encoded_project}/jobs/$JOB_ID/trace"),
            post_comment_command=("glab", "mr", "comment", number, "--repo", project, "-m", "$REPORT"),
        )

    raise ReviewReferenceError(f"Unsupported provider: {reference.provider}")


def to_shell_exports(reference: ReviewReference, plan: FetchPlan) -> str:
    """Render a reference and plan as shell assignments."""
    values = {
        "REVIEW_PROVIDER": reference.provider,
        "REVIEW_KIND": reference.kind,
        "PROJECT": reference.project_path,
        "MR_NUMBER": str(reference.number),
        "REVIEW_NUMBER": str(reference.number),
        "PROJECT_URL_ENCODED": quote(reference.project_path, safe=""),
        "METADATA_COMMAND": shlex.join(plan.metadata_command),
        "DIFF_COMMAND": shlex.join(plan.diff_command),
        "API_RESOURCE": plan.api_resource,
        "COMMENTS_COMMAND": shlex.join(plan.comments_command),
        "COMMITS_COMMAND": shlex.join(plan.commits_command),
        "CI_COMMAND": shlex.join(plan.ci_command),
        "FAILED_JOBS_COMMAND": _shell_join_with_runtime_variables(plan.failed_jobs_command),
        "FAILED_JOB_LOG_COMMAND": _shell_join_with_runtime_variables(plan.failed_job_log_command),
        "POST_COMMENT_COMMAND": _shell_join_with_runtime_variables(plan.post_comment_command),
    }
    return "\n".join(f"{key}={shlex.quote(value)}" for key, value in values.items())


def _shell_join_with_runtime_variables(command: tuple[str, ...]) -> str:
    """Render a command while preserving approved runtime shell variables.

    Most generated commands are fully static and safe to render with
    ``shlex.join``. Failed-job log retrieval and GitLab comment posting are
    different: the command script binds run/job/report values at runtime, then
    evaluates the generated command string. Render only the approved variables
    as quoted shell expansions so values with spaces remain one argument.
    """
    return " ".join(_quote_shell_word_with_runtime_variables(arg) for arg in command)


def _quote_shell_word_with_runtime_variables(value: str) -> str:
    if not _RUNTIME_VARIABLE_PATTERN.search(value):
        return shlex.quote(value)

    rendered = []
    position = 0
    for match in _RUNTIME_VARIABLE_PATTERN.finditer(value):
        rendered.append(_double_quote_literal(value[position : match.start()]))
        variable = match.group(1)
        if variable not in _RUNTIME_VARIABLES:
            raise ReviewReferenceError(f"Unsupported runtime variable: {variable}")
        rendered.append(f"${{{variable}}}")
        position = match.end()
    rendered.append(_double_quote_literal(value[position:]))
    return f'"{"".join(rendered)}"'


def _double_quote_literal(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"').replace("`", "\\`").replace("$", "\\$")


def _build_gitlab_reference(project_path: str, number: str) -> ReviewReference:
    if ".." in project_path:
        raise ReviewReferenceError("Invalid project path: path traversal detected")
    owner, repo = project_path.rsplit("/", 1)
    return ReviewReference(
        provider="gitlab",
        owner=owner,
        repo=repo,
        number=int(number),
        kind="mr",
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Plan Git provider review fetches.")
    parser.add_argument("reference", help="GitHub PR/GitLab MR URL or numeric reference")
    parser.add_argument("--remote-url", default=None, help="Git remote URL for numeric references")
    parser.add_argument("--shell", action="store_true", help="Print shell assignments")
    args = parser.parse_args()

    try:
        reference = parse_review_reference(args.reference, remote_url=args.remote_url)
        plan = plan_fetch(reference)
    except ReviewReferenceError as exc:
        parser.exit(1, f"Error: {exc}\n")

    if args.shell:
        print(to_shell_exports(reference, plan))
    else:
        print(f"{reference.provider} {reference.kind} {reference.project_path} {reference.number}")
        print(shlex.join(plan.metadata_command))
        print(shlex.join(plan.diff_command))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
