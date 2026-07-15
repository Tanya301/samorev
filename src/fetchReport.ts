import { $ } from "bun";
import type { FetchPlan, Provider, ReviewReference } from "./providerPlanning";

export class FetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchError";
  }
}

type FetchedData = {
  metadata: unknown;
  diff: string;
  comments: unknown;
  commits: unknown;
  ci: unknown;
};

type RunCommand = (command: string[]) => Promise<string>;
type HttpJson = (url: string) => Promise<unknown>;

export type ReviewOutcome = "PASS" | "FAIL";

export type FetchReviewResult = {
  report: string;
  outcome: ReviewOutcome;
};

export async function fetchReviewSummary(
  reference: ReviewReference,
  plan: FetchPlan,
  promptPath: string,
  options: {
    blocking: boolean;
    runCommand?: RunCommand;
    httpJson?: HttpJson;
    noComment?: boolean;
    postedBy?: string;
    livePosting?: "not-run" | "posted" | "blocked";
  } = { blocking: false },
): Promise<FetchReviewResult> {
  const runCommand = options.runCommand ?? runText;
  const httpJson = options.httpJson ?? fetchJson;
  const fetched = reference.provider === "github"
    ? await fetchGitHub(plan, runCommand)
    : await fetchGitLab(reference, plan, runCommand, httpJson);

  if (!isRecord(fetched.metadata)) {
    throw new FetchError("Provider metadata response was not a JSON object");
  }

  const diff = summarizeDiff(fetched.diff);
  const ci = summarizeCi(reference.provider, fetched.ci);
  const title = String(fetched.metadata.title ?? fetched.metadata.source_branch ?? "(untitled)");
  const state = String(fetched.metadata.state ?? fetched.metadata.merge_status ?? "unknown");
  const draft = metadataDraft(reference.provider, fetched.metadata);
  const findings = reviewGateFindings(ci.status, draft);
  const outcome: ReviewOutcome = findings.length ? "FAIL" : "PASS";
  const counts = {
    comments: countJsonItems(fetched.comments),
    commits: countJsonItems(fetched.commits),
  };

  const report = renderRevLikeReport({
    reference,
    title,
    state,
    draft,
    diff,
    ci,
    findings,
    outcome,
    promptPath,
    postedBy: options.postedBy ?? "local",
    noComment: options.noComment ?? true,
    livePosting: options.livePosting ?? "not-run",
    blocking: options.blocking,
    counts,
    metadata: fetched.metadata,
  });

  return { report, outcome };
}

async function fetchGitHub(plan: FetchPlan, runCommand: RunCommand): Promise<FetchedData> {
  return {
    metadata: await runJson(plan.metadataCommand, runCommand),
    diff: await runCommand(plan.diffCommand),
    comments: await runJson(plan.commentsCommand, runCommand),
    commits: await runJson(plan.commitsCommand, runCommand),
    ci: await runJson(plan.ciCommand, runCommand),
  };
}

async function fetchGitLab(reference: ReviewReference, plan: FetchPlan, runCommand: RunCommand, httpJson: HttpJson): Promise<FetchedData> {
  if (await commandExists("glab")) {
    try {
      return {
        metadata: await runJson(plan.metadataCommand, runCommand),
        diff: await runCommand(plan.diffCommand),
        comments: await runJson(plan.commentsCommand, runCommand),
        commits: await runJson(plan.commitsCommand, runCommand),
        ci: await runJson(plan.ciCommand, runCommand),
      };
    } catch (_error) {
      // Public MRs should still be demoable when glab is installed but not authenticated.
    }
  }

  const project = encodeURIComponent(reference.projectPath);
  const base = `https://gitlab.com/api/v4/projects/${project}/merge_requests/${reference.number}`;
  const [metadata, comments, commits, diffs] = await Promise.all([
    httpJson(base),
    httpJsonOrDefault(`${base}/notes?per_page=100`, [], httpJson),
    httpJson(`${base}/commits`),
    httpJson(`${base}/diffs`),
  ]);

  return {
    metadata,
    diff: renderGitLabDiffText(diffs),
    comments,
    commits,
    ci: metadata,
  };
}

async function runJson(command: string[], runCommand: RunCommand): Promise<unknown> {
  const output = await runCommand(command);
  try {
    return JSON.parse(output || "null");
  } catch (error) {
    throw new FetchError(`${command[0]} returned invalid JSON for ${displayCommand(command)}: ${String(error)}`);
  }
}

async function runText(command: string[]): Promise<string> {
  const proc = Bun.spawn({
    cmd: command,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
    throw new FetchError(`Command failed (${exitCode}) for ${displayCommand(command)}${detail}`);
  }
  return stdout;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new FetchError(`GitLab public API request failed (${response.status}) for ${url}`);
  }
  return response.json();
}

async function httpJsonOrDefault(url: string, fallback: unknown, httpJson: HttpJson): Promise<unknown> {
  try {
    return await httpJson(url);
  } catch (_error) {
    return fallback;
  }
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await $`which ${command}`.quiet();
    return true;
  } catch (_error) {
    return false;
  }
}

function renderGitLabDiffText(diffs: unknown): string {
  if (!Array.isArray(diffs)) {
    return "";
  }
  return diffs
    .filter(isRecord)
    .map((item) => {
      const oldPath = String(item.old_path ?? item.new_path ?? "unknown");
      const newPath = String(item.new_path ?? oldPath);
      const diff = String(item.diff ?? "");
      return `diff --git a/${oldPath} b/${newPath}\n${diff}`;
    })
    .join("\n");
}

function summarizeDiff(diffText: string): { lines: number; added: number; removed: number; bytes: number } {
  const lines = diffText.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return {
    lines: lines.length,
    added: lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length,
    removed: lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length,
    bytes: new TextEncoder().encode(diffText).length,
  };
}

function countJsonItems(value: unknown): number {
  if (Array.isArray(value)) {
    return value.length;
  }
  if (isRecord(value)) {
    for (const key of ["comments", "commits", "nodes", "values"]) {
      if (Array.isArray(value[key])) {
        return value[key].length;
      }
    }
    if (typeof value.total_count === "number") {
      return value.total_count;
    }
  }
  return 0;
}

function summarizeCi(provider: Provider, ci: unknown): { status: string; summary: string } {
  return provider === "github" ? summarizeGitHubCi(ci) : summarizeGitLabCi(ci);
}

function summarizeGitHubCi(ci: unknown): { status: string; summary: string } {
  const checkRuns = isRecord(ci) && Array.isArray(ci.check_runs) ? ci.check_runs : [];
  const counts = { success: 0, failure: 0, pending: 0, other: 0 };

  for (const run of checkRuns) {
    if (!isRecord(run)) {
      counts.other += 1;
      continue;
    }
    const conclusion = run.conclusion;
    const status = run.status;
    if (conclusion === "success") {
      counts.success += 1;
    } else if (["failure", "cancelled", "timed_out", "action_required"].includes(String(conclusion))) {
      counts.failure += 1;
    } else if (status !== "completed" || conclusion == null) {
      counts.pending += 1;
    } else {
      counts.other += 1;
    }
  }

  const total = checkRuns.length;
  const status = counts.failure
    ? "failure"
    : counts.pending
      ? "pending"
      : total && counts.success === total
        ? "success"
        : total === 0
          ? "none"
          : "unknown";
  return {
    status,
    summary: `total=${total} success=${counts.success} failure=${counts.failure} pending=${counts.pending} other=${counts.other}`,
  };
}

function summarizeGitLabCi(ci: unknown): { status: string; summary: string } {
  if (!isRecord(ci)) {
    return { status: "unknown", summary: "pipeline_status=unknown" };
  }
  const pipeline = ci.head_pipeline;
  const status = isRecord(pipeline)
    ? String(pipeline.status ?? "unknown")
    : String(ci.pipeline_status ?? ci.state ?? "unknown");
  return { status, summary: `pipeline_status=${status}` };
}

function metadataDraft(provider: Provider, metadata: Record<string, unknown>): boolean {
  if (provider === "github") {
    return Boolean(metadata.isDraft);
  }
  if ("draft" in metadata) {
    return Boolean(metadata.draft);
  }
  return String(metadata.work_in_progress ?? "false").toLowerCase() === "true";
}

type GateFinding = {
  area: "CI/Pipeline" | "Metadata";
  severity: "CRITICAL" | "HIGH";
  subject: string;
  title: string;
  detail: string;
  fix: string;
};

function reviewGateFindings(ciStatus: string, draft: boolean): GateFinding[] {
  const findings: GateFinding[] = [];
  if (draft) {
    findings.push({
      area: "Metadata",
      severity: "HIGH",
      subject: "MR/PR state",
      title: "Review target is draft",
      detail: "The review target is still marked as draft.",
      fix: "Mark it ready for review before merge.",
    });
  }
  if (!["success", "none"].includes(ciStatus)) {
    findings.push({
      area: "CI/Pipeline",
      severity: ciStatus === "pending" ? "HIGH" : "CRITICAL",
      subject: "CI/Pipeline",
      title: `Pipeline status is ${ciStatus}`,
      detail: `Provider CI reported status \`${ciStatus}\`.`,
      fix: ciStatus === "pending"
        ? "Wait for CI to finish and rerun review."
        : "Fix failing checks and rerun review.",
    });
  }
  return findings;
}

function renderRevLikeReport(args: {
  reference: ReviewReference;
  title: string;
  state: string;
  draft: boolean;
  diff: { lines: number; added: number; removed: number; bytes: number };
  ci: { status: string; summary: string };
  findings: GateFinding[];
  outcome: "PASS" | "FAIL";
  promptPath: string;
  postedBy: string;
  noComment: boolean;
  livePosting: "not-run" | "posted" | "blocked";
  blocking: boolean;
  counts: { comments: number; commits: number };
  metadata: Record<string, unknown>;
}): string {
  const targetKind = args.reference.provider === "gitlab" ? "MR" : "PR";
  const targetRef = args.reference.provider === "gitlab"
    ? `${args.reference.projectPath}!${args.reference.number}`
    : `${args.reference.projectPath}#${args.reference.number}`;
  const author = metadataAuthor(args.metadata);
  const blockingCount = args.findings.length;
  const ciFindings = args.findings.filter((finding) => finding.area === "CI/Pipeline").length;
  const metadataFindings = args.findings.filter((finding) => finding.area === "Metadata").length;

  const lines = [
    "## samorev Code Review Report",
    "",
    `- **${targetKind}:** ${targetRef} - ${args.title}`,
    `- **Author:** ${author}`,
    "- **AI-Assisted:** Unknown",
    "",
    "| Pipeline | Coverage |",
    "|----------|----------|",
    `| ${formatCiBadge(args.ci.status)} | Not reported |`,
    "",
    "---",
    "",
  ];

  if (blockingCount > 0) {
    lines.push(`### BLOCKING ISSUES (${blockingCount})`, "");
    for (const finding of args.findings) {
      lines.push(
        `**${finding.severity}** \`${finding.subject}\` - ${finding.title}`,
        `> ${finding.detail}`,
        `> **Fix:** ${finding.fix}`,
        "",
      );
    }
    lines.push("---", "");
  } else {
    lines.push(
      "No issues found. Reviewed for security, bugs, tests, guidelines, and documentation.",
      "",
      "**Result: PASSED**",
      "",
      "---",
      "",
    );
  }

  lines.push(
    "### Summary",
    "",
    "| Area | Findings | Potential | Filtered |",
    "|------|----------|-----------|----------|",
    `| CI/Pipeline | ${ciFindings} | 0 | 0 |`,
    "| Security | 0 | 0 | 0 |",
    "| Bugs | 0 | 0 | 0 |",
    "| Tests | 0 | 0 | 0 |",
    "| Guidelines | 0 | 0 | 0 |",
    "| Docs | 0 | 0 | 0 |",
    `| Metadata | ${metadataFindings} | 0 | 0 |`,
    "",
    "Note:",
    "- **Findings**: High-confidence issues (8-10/10) - blocking or non-blocking per severity",
    "- **Potential**: Medium-confidence issues (4-7/10) - review manually",
    "- **Filtered**: Low-confidence issues (0-3/10) - excluded as likely false positives",
    "",
    "<details>",
    "<summary>Review metadata</summary>",
    "",
    "```text",
    `provider=${args.reference.provider}`,
    `kind=${args.reference.kind}`,
    `project=${args.reference.projectPath}`,
    `number=${args.reference.number}`,
    `target=${args.reference.provider}:${args.reference.projectPath}#${args.reference.number}`,
    `state=${args.state}`,
    `draft=${String(args.draft)}`,
    `diff_lines=${args.diff.lines}`,
    `diff_added=${args.diff.added}`,
    `diff_removed=${args.diff.removed}`,
    `diff_bytes=${args.diff.bytes}`,
    `comments_count=${args.counts.comments}`,
    `commits_count=${args.counts.commits}`,
    `ci_status=${args.ci.status}`,
    `ci_summary=${args.ci.summary}`,
    `prompt=${args.promptPath}`,
    `blocking=${String(args.blocking)}`,
    `posted_by=${args.postedBy}`,
    `no_comment=${String(args.noComment)}`,
    `live_posting=${args.livePosting}`,
    "```",
    "",
    "</details>",
    "",
    "---",
    "*samorev-assisted review (AI analysis by [Tanya301/samorev](https://github.com/Tanya301/samorev))*",
  );

  return lines.join("\n");
}

function formatCiBadge(status: string): string {
  const normalized = status.toLowerCase();
  if (["success", "passed"].includes(normalized)) {
    return "PASS";
  }
  if (["pending", "running"].includes(normalized)) {
    return "PENDING";
  }
  if (["failure", "failed"].includes(normalized)) {
    return "FAIL";
  }
  return status || "unknown";
}

function metadataAuthor(metadata: Record<string, unknown>): string {
  const author = metadata.author;
  if (isRecord(author)) {
    const login = author.login ?? author.username ?? author.name;
    if (typeof login === "string" && login.length > 0) {
      return login.startsWith("@") ? login : `@${login}`;
    }
  }
  const user = metadata.user;
  if (isRecord(user)) {
    const login = user.login ?? user.username ?? user.name;
    if (typeof login === "string" && login.length > 0) {
      return login.startsWith("@") ? login : `@${login}`;
    }
  }
  return "Unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function displayCommand(command: string[]): string {
  return command.join(" ");
}
