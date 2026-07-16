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

/**
 * Injectable claude -p runner boundary.
 * Receives the assembled review prompt; returns the model's stdout text.
 * Mock this in tests — never pass ANTHROPIC_API_KEY or @anthropic-ai/sdk.
 */
export type ClaudeRunner = (prompt: string) => Promise<string>;

export type ReviewOutcome = "PASS" | "FAIL";

export type FetchReviewResult = {
  report: string;
  outcome: ReviewOutcome;
};

/** Per-area finding counts parsed from LLM output. */
type LlmFindings = {
  security: number;
  bugs: number;
  tests: number;
  guidelines: number;
  docs: number;
  /** Individual finding lines for the BLOCKING section */
  blockingItems: string[];
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
    /**
     * Inject a claude -p runner in tests.
     * Production code uses the real claude subprocess via runClaude().
     */
    claudeRunner?: ClaudeRunner;
  } = { blocking: false },
): Promise<FetchReviewResult> {
  const runCommand = options.runCommand ?? runText;
  const httpJson = options.httpJson ?? fetchJson;
  const claudeRunner = options.claudeRunner ?? runClaude;
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
  const gateFindings = reviewGateFindings(ci.status, draft);
  const counts = {
    comments: countJsonItems(fetched.comments),
    commits: countJsonItems(fetched.commits),
  };

  // Invoke claude -p with the actual diff; fail-closed on any error.
  let llmFindings: LlmFindings;
  try {
    const prompt = buildReviewPrompt(fetched.diff, title, String(fetched.metadata.description ?? fetched.metadata.body ?? ""));
    const llmOutput = await claudeRunner(prompt);
    llmFindings = parseLlmFindings(llmOutput);
  } catch (_err) {
    // Fail-closed: if the LLM runner fails we must not auto-PASS.
    llmFindings = {
      security: 0,
      bugs: 0,
      tests: 0,
      guidelines: 0,
      docs: 0,
      blockingItems: ["LLM reviewer unavailable — treating as FAIL (fail-closed)"],
    };
  }

  // Outcome is FAIL when:
  // - CI/draft gate has findings (gateFindings), OR
  // - LLM surfaced CRITICAL/HIGH/MEDIUM findings (blockingItems).
  // LOW/INFO findings are counted in the summary table but do NOT trigger FAIL.
  const outcome: ReviewOutcome = (gateFindings.length > 0 || llmFindings.blockingItems.length > 0) ? "FAIL" : "PASS";

  const report = renderRevLikeReport({
    reference,
    title,
    state,
    draft,
    diff,
    ci,
    findings: gateFindings,
    llmFindings,
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

// ──────────────────────────────────────────────────────────────────────────────
// LLM invocation — claude -p subprocess (OAuth only, no ANTHROPIC_API_KEY)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Build the review prompt embedding the raw diff so the model can identify
 * bugs, security issues, test gaps, guideline violations, and docs gaps.
 * Mirrors the agent prompts in .claude/commands/review-mr.md.
 */
function buildReviewPrompt(diffText: string, title: string, description: string): string {
  const MAX_DIFF_CHARS = 40_000;
  const truncatedDiff = diffText.length > MAX_DIFF_CHARS
    ? diffText.slice(0, MAX_DIFF_CHARS) + "\n... (diff truncated)"
    : diffText;

  return [
    "You are a code reviewer. Review the following PR diff for issues.",
    "",
    "<mr_info>",
    `Title: ${title}`,
    `Description: ${description || "(none)"}`,
    "</mr_info>",
    "",
    "<diff>",
    truncatedDiff,
    "</diff>",
    "",
    "Review for: security vulnerabilities, bugs/logic errors, missing tests, guideline violations, and documentation gaps.",
    "",
    "For EACH issue found, output a block in this EXACT format (preserve the FINDING: header):",
    "FINDING:",
    "- severity: CRITICAL | HIGH | MEDIUM | LOW",
    "- confidence: <0-10>",
    "- area: Security | Bugs | Tests | Guidelines | Docs",
    "- issue: <brief description>",
    "- evidence: <the problematic code>",
    "- fix: <remediation>",
    "",
    "Only report findings with confidence >= 4.",
    "If no issues found in a category, skip it.",
    "If NO issues found at all, output exactly: NO_FINDINGS",
  ].join("\n");
}

/**
 * Invoke `claude -p` as a subprocess (OAuth pattern — no ANTHROPIC_API_KEY).
 * Inherits the current process PATH so that tests can inject a fake `claude`
 * binary by prepending a directory to PATH before spawning.
 * Throws on non-zero exit so the caller can apply fail-closed logic.
 *
 * Security: `--allowedTools ""` sets an EMPTY tool allow-list so prompt-injection
 * embedded in an attacker-controlled diff cannot execute any tool/command.
 * The prompt is passed via STDIN (not argv): `--allowedTools` is variadic and
 * would otherwise swallow a trailing positional prompt on claude >= 2.1.
 * The model can still read the prompt and emit text output.
 */
async function runClaude(prompt: string): Promise<string> {
  const proc = Bun.spawn({
    cmd: ["claude", "-p", "--allowedTools", ""],
    stdin: new TextEncoder().encode(prompt),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      HOME: process.env.HOME ?? "/root",
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      USER: process.env.USER ?? "root",
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
    throw new FetchError(`claude -p exited with code ${exitCode}${detail}`);
  }
  return stdout;
}

// Exported only for testing
export { runClaude as _runClaudeForTest };

// ──────────────────────────────────────────────────────────────────────────────
// LLM output parsing
// ──────────────────────────────────────────────────────────────────────────────

const AREA_MAP: Record<string, keyof Omit<LlmFindings, "blockingItems">> = {
  security: "security",
  bugs: "bugs",
  bug: "bugs",
  tests: "tests",
  test: "tests",
  guidelines: "guidelines",
  guideline: "guidelines",
  docs: "docs",
  doc: "docs",
  documentation: "docs",
};

const BLOCKING_SEVERITIES = new Set(["critical", "high", "medium"]);

/**
 * Parse the structured FINDING: blocks emitted by the LLM into per-area counts
 * and a list of blocking issue descriptions for the report body.
 */
export function parseLlmFindings(llmOutput: string): LlmFindings {
  const result: LlmFindings = {
    security: 0,
    bugs: 0,
    tests: 0,
    guidelines: 0,
    docs: 0,
    blockingItems: [],
  };

  if (!llmOutput || llmOutput.trim().toUpperCase().startsWith("NO_FINDINGS")) {
    return result;
  }

  // Split on FINDING: markers
  const blocks = llmOutput.split(/\bFINDING:\s*/i).slice(1);

  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    let severity = "";
    let confidenceVal = 10;
    let area = "";
    let issue = "";
    let evidence = "";
    let fix = "";

    for (const line of lines) {
      const trimmed = line.trim();
      const kv = /^-\s*(\w+):\s*(.*)$/.exec(trimmed);
      if (!kv) continue;
      const key = kv[1].toLowerCase();
      const val = kv[2].trim();
      if (key === "severity") severity = val.toLowerCase();
      else if (key === "confidence") confidenceVal = parseInt(val, 10) || 0;
      else if (key === "area") area = val.toLowerCase();
      else if (key === "issue") issue = val;
      else if (key === "evidence") evidence = val;
      else if (key === "fix") fix = val;
    }

    // Filter low-confidence findings (mirrors the prompt instructions)
    if (confidenceVal < 4) continue;

    // Map area to our known categories
    const areaKey = AREA_MAP[area];
    if (areaKey) {
      result[areaKey] += 1;
    }

    // Add to blocking section for CRITICAL/HIGH/MEDIUM findings
    if (BLOCKING_SEVERITIES.has(severity)) {
      const label = severity.toUpperCase();
      const areaLabel = area ? `[${area}] ` : "";
      result.blockingItems.push(`**${label}** ${areaLabel}${issue}${evidence ? `\n> ${evidence}` : ""}${fix ? `\n> **Fix:** ${fix}` : ""}`);
    }
  }

  return result;
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
  llmFindings: LlmFindings;
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
  const ciFindings = args.findings.filter((finding) => finding.area === "CI/Pipeline").length;
  const metadataFindings = args.findings.filter((finding) => finding.area === "Metadata").length;
  const llm = args.llmFindings;
  const totalBlockingCount = args.findings.length + llm.blockingItems.length;

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

  if (totalBlockingCount > 0) {
    lines.push(`### BLOCKING ISSUES (${totalBlockingCount})`, "");
    // Gate findings (CI/draft)
    for (const finding of args.findings) {
      lines.push(
        `**${finding.severity}** \`${finding.subject}\` - ${finding.title}`,
        `> ${finding.detail}`,
        `> **Fix:** ${finding.fix}`,
        "",
      );
    }
    // LLM blocking findings
    for (const item of llm.blockingItems) {
      lines.push(item, "");
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
    `| Security | ${llm.security} | 0 | 0 |`,
    `| Bugs | ${llm.bugs} | 0 | 0 |`,
    `| Tests | ${llm.tests} | 0 | 0 |`,
    `| Guidelines | ${llm.guidelines} | 0 | 0 |`,
    `| Docs | ${llm.docs} | 0 | 0 |`,
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

