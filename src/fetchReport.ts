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
): Promise<string> {
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
  const outcome = findings.length ? "FAIL" : "PASS";
  const fetchSummary = [
    "samorev fetch summary",
    `provider=${reference.provider}`,
    `kind=${reference.kind}`,
    `project=${reference.projectPath}`,
    `number=${reference.number}`,
    `target=${reference.provider}:${reference.projectPath}#${reference.number}`,
    `title=${title}`,
    `state=${state}`,
    `draft=${String(draft)}`,
    `diff_lines=${diff.lines}`,
    `diff_added=${diff.added}`,
    `diff_removed=${diff.removed}`,
    `diff_bytes=${diff.bytes}`,
    `comments_count=${countJsonItems(fetched.comments)}`,
    `commits_count=${countJsonItems(fetched.commits)}`,
    `ci_status=${ci.status}`,
    `ci_summary=${ci.summary}`,
    `prompt=${promptPath}`,
    `blocking=${String(options.blocking)}`,
    `posted_by=${options.postedBy ?? "local"}`,
    `no_comment=${String(options.noComment ?? true)}`,
    `live_posting=${options.livePosting ?? "not-run"}`,
  ].join("\n");

  return [
    `samorev review gate: ${outcome}`,
    `Result: ${outcome}`,
    `Target: ${reference.provider}:${reference.projectPath}#${reference.number}`,
    `Provider: ${reference.provider}`,
    `CI: ${ci.status}`,
    findings.length ? "Findings:" : "No blocking findings.",
    ...findings.map((finding) => `- ${finding}`),
    "",
    fetchSummary,
  ].join("\n");
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

function reviewGateFindings(ciStatus: string, draft: boolean): string[] {
  const findings: string[] = [];
  if (draft) {
    findings.push("Review target is draft.");
  }
  if (!["success", "none"].includes(ciStatus)) {
    findings.push(`CI status is ${ciStatus}.`);
  }
  return findings;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function displayCommand(command: string[]): string {
  return command.join(" ");
}
