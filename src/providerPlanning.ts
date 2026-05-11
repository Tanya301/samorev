export type Provider = "github" | "gitlab";
export type ReviewKind = "pr" | "mr";

export type ReviewReference = {
  provider: Provider;
  owner: string;
  repo: string;
  number: number;
  kind: ReviewKind;
  projectPath: string;
};

export type FetchPlan = {
  provider: Provider;
  metadataCommand: string[];
  diffCommand: string[];
  apiResource: string;
  commentsCommand: string[];
  commitsCommand: string[];
  ciCommand: string[];
  failedJobsCommand: string[];
  failedJobLogCommand: string[];
  postCommentCommand: string[];
};

export class ReviewReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewReferenceError";
  }
}

const pathPart = "[a-zA-Z0-9_.-]+";
const projectPath = `(?:${pathPart}/)+${pathPart}`;

export function parseReviewReference(ref: string, remoteUrl?: string | null): ReviewReference {
  const value = ref.trim();

  const githubUrl = new RegExp(`^https://github\\.com/(${pathPart})/(${pathPart})/pull/([0-9]+)$`).exec(value);
  if (githubUrl) {
    return buildReference("github", githubUrl[1], githubUrl[2], Number(githubUrl[3]), "pr");
  }

  const gitlabUrl = new RegExp(`^https://gitlab\\.com/(${projectPath})/-/merge_requests/([0-9]+)$`).exec(value);
  if (gitlabUrl) {
    return buildGitLabReference(gitlabUrl[1], Number(gitlabUrl[2]));
  }

  if (/^[0-9]+$/.test(value)) {
    if (!remoteUrl) {
      throw new ReviewReferenceError("Numeric reference requires a git remote URL");
    }
    const remote = parseRemoteUrl(remoteUrl);
    return buildReference(remote.provider, remote.owner, remote.repo, Number(value), remote.provider === "github" ? "pr" : "mr");
  }

  throw new ReviewReferenceError("Invalid review reference - must be URL or number");
}

export function parseRemoteUrl(remoteUrl: string): ReviewReference {
  const patterns: Array<[Provider, RegExp]> = [
    ["github", new RegExp(`^(?:git@github\\.com:|https://github\\.com/|ssh://git@github\\.com/)(?<path>${pathPart}/${pathPart})(?:\\.git)?$`)],
    ["gitlab", new RegExp(`^(?:git@gitlab\\.com:|https://gitlab\\.com/|ssh://git@gitlab\\.com/)(?<path>${projectPath})(?:\\.git)?$`)],
  ];

  for (const [provider, pattern] of patterns) {
    const match = pattern.exec(remoteUrl.trim());
    if (!match?.groups?.path) {
      continue;
    }
    const path = match.groups.path.endsWith(".git") ? match.groups.path.slice(0, -4) : match.groups.path;
    if (provider === "github") {
      const [owner, repo] = path.split("/", 2);
      return buildReference("github", owner, repo, 0, "pr");
    }
    return buildGitLabReference(path, 0);
  }

  throw new ReviewReferenceError("Remote is not a supported GitHub or GitLab repository");
}

export function planFetch(reference: ReviewReference): FetchPlan {
  const number = String(reference.number);
  const project = reference.projectPath;

  if (reference.provider === "github") {
    const jsonFields = "assignees,author,baseRefName,body,headRefName,isDraft,labels,number,reviewRequests,state,title,url";
    return {
      provider: "github",
      metadataCommand: ["gh", "pr", "view", number, "--repo", project, "--json", jsonFields],
      diffCommand: ["gh", "pr", "diff", number, "--repo", project],
      apiResource: `repos/${project}/pulls/${number}`,
      commentsCommand: ["gh", "api", `repos/${project}/issues/${number}/comments`, "--paginate"],
      commitsCommand: ["gh", "api", `repos/${project}/pulls/${number}/commits`, "--paginate"],
      ciCommand: ["gh", "api", `repos/${project}/commits/pull/${number}/head/check-runs`, "--paginate"],
      failedJobsCommand: ["gh", "run", "view", "$RUN_ID", "--repo", project, "--json", "jobs"],
      failedJobLogCommand: ["gh", "run", "view", "$RUN_ID", "--repo", project, "--job", "$JOB_ID", "--log-failed"],
      postCommentCommand: ["gh", "pr", "comment", number, "--repo", project, "--body-file", "-"],
    };
  }

  const encodedProject = encodeURIComponent(project);
  return {
    provider: "gitlab",
    metadataCommand: ["glab", "api", `projects/${encodedProject}/merge_requests/${number}`],
    diffCommand: ["glab", "mr", "diff", number, "--repo", project],
    apiResource: `projects/${encodedProject}/merge_requests/${number}`,
    commentsCommand: ["glab", "api", `projects/${encodedProject}/merge_requests/${number}/notes?per_page=10&sort=desc`],
    commitsCommand: ["glab", "api", `projects/${encodedProject}/merge_requests/${number}/commits`],
    ciCommand: ["glab", "api", `projects/${encodedProject}/merge_requests/${number}`],
    failedJobsCommand: ["glab", "api", `projects/${encodedProject}/pipelines/$PIPELINE_ID/jobs`],
    failedJobLogCommand: ["glab", "api", `projects/${encodedProject}/jobs/$JOB_ID/trace`],
    postCommentCommand: ["glab", "mr", "comment", number, "--repo", project, "-m", "$REPORT"],
  };
}

function buildGitLabReference(path: string, number: number): ReviewReference {
  if (path.includes("..")) {
    throw new ReviewReferenceError("Invalid project path: path traversal detected");
  }
  const parts = path.split("/");
  const repo = parts.pop();
  if (!repo || parts.length === 0) {
    throw new ReviewReferenceError("Invalid GitLab project path");
  }
  return buildReference("gitlab", parts.join("/"), repo, number, "mr");
}

function buildReference(provider: Provider, owner: string, repo: string, number: number, kind: ReviewKind): ReviewReference {
  return {
    provider,
    owner,
    repo,
    number,
    kind,
    projectPath: `${owner}/${repo}`,
  };
}
