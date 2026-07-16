import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fetchReviewSummary, FetchError } from "../src/fetchReport";
import { parseReviewReference, planFetch } from "../src/providerPlanning";

const repoRoot = import.meta.dir.replace(/\/tests$/, "");
const fakeBin = join(repoRoot, ".tmp-bun-test-bin");
const originalPath = process.env.PATH ?? "";
const rawMetadataKeys = [
  "provider=",
  "kind=",
  "project=",
  "number=",
  "target=",
  "title=",
  "state=",
  "draft=",
  "diff_lines=",
  "diff_added=",
  "diff_removed=",
  "diff_bytes=",
  "comments_count=",
  "commits_count=",
  "ci_status=",
  "ci_summary=",
  "prompt=",
  "blocking=",
  "posted_by=",
  "no_comment=",
  "live_posting=",
];

async function runSamorev(args: string[], extraEnv: Record<string, string> = {}) {
  return Bun.spawn({
    cmd: ["bun", "run", "samorev", ...args],
    cwd: repoRoot,
    env: {
      ...process.env,
      ...extraEnv,
      PATH: `${fakeBin}:${originalPath}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function output(proc: ReturnType<typeof Bun.spawn>) {
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

/**
 * Write a stub `claude` binary into fakeBin so CLI tests don't hit the real
 * claude -p. The stub returns NO_FINDINGS (clean review) so gate-only
 * findings (CI/draft) remain the sole source of FAIL in tests that haven't
 * opted into specific LLM scenarios.
 */
async function writeFakeClaude(findingsOutput = "NO_FINDINGS") {
  await writeFile(
    join(fakeBin, "claude"),
    `#!/usr/bin/env bun
// Fake claude -p for samorev CLI tests — returns pre-canned LLM output.
process.stdout.write(${JSON.stringify(findingsOutput)});
`,
    { mode: 0o755 },
  );
}

beforeEach(async () => {
  await rm(fakeBin, { recursive: true, force: true });
  await mkdir(fakeBin, { recursive: true });
  // Always stub claude so tests don't call the real LLM.
  await writeFakeClaude();
});

afterEach(async () => {
  await rm(fakeBin, { recursive: true, force: true });
});

describe("bun samorev CLI", () => {
  it("fetches GitHub provider data and renders a no-comment summary", async () => {
    await writeGitHubFake();

    const result = await output(
      await runSamorev([
        "review",
        "https://github.com/example-org/example-repo/pull/17",
        "--no-comment",
        "--fetch",
      ]),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("Error:");
    expect(result.stdout).toContain("## samorev Code Review Report");
    expect(result.stdout).toContain("- **PR:** example-org/example-repo#17 - Demo PR");
    // Non-blocking run (no --blocking flag): section must say REVIEW FINDINGS, not BLOCKING ISSUES
    expect(result.stdout).toContain("### REVIEW FINDINGS (1)");
    expect(result.stdout).toContain("Pipeline status is failure");
    expectRevReportShape(result.stdout);
    expect(expectVisibleReport(result.stdout)).not.toContain("provider=github");
    expect(expectVisibleReport(result.stdout)).not.toContain("ci_status=failure");
    const metadata = expectMetadataDetails(result.stdout);
    expect(metadata).toContain("provider=github");
    expect(metadata).toContain("kind=pr");
    expect(metadata).toContain("project=example-org/example-repo");
    expect(metadata).toContain("target=github:example-org/example-repo#17");
    expect(metadata).toContain("state=OPEN");
    expect(metadata).toContain("draft=false");
    expect(metadata).toContain("diff_lines=3");
    expect(metadata).toContain("diff_added=1");
    expect(metadata).toContain("diff_removed=1");
    expect(metadata).toContain("comments_count=2");
    expect(metadata).toContain("commits_count=3");
    expect(metadata).toContain("ci_status=failure");
    expect(metadata).toContain("ci_summary=total=2 success=1 failure=1 pending=0 other=0");
    expect(metadata).toContain("posted_by=local");
    expect(metadata).toContain("no_comment=true");
    expect(metadata).toContain("live_posting=not-run");
  });

  it("posts GitHub fetch summary through authenticated gh", async () => {
    const postLog = join(fakeBin, "github-post.txt");
    await writeGitHubFake(postLog);

    const result = await output(
      await runSamorev([
        "review",
        "https://github.com/example-org/example-repo/pull/17",
        "--fetch",
      ], { SAMOREV_FAKE_AUTH: "ok" }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("Error:");
    const postedBody = await readFile(postLog, "utf8");
    expectRevReportShape(result.stdout);
    expect(expectVisibleReport(result.stdout)).not.toContain("provider=github");
    const stdoutMetadata = expectMetadataDetails(result.stdout);
    expect(stdoutMetadata).toContain("provider=github");
    expect(stdoutMetadata).toContain("target=github:example-org/example-repo#17");
    expect(stdoutMetadata).toContain("ci_status=failure");
    expect(stdoutMetadata).toContain("posted_by=gh");
    expect(stdoutMetadata).toContain("no_comment=false");
    expect(stdoutMetadata).toContain("live_posting=posted");
    expect(postedBody).toContain("## samorev Code Review Report");
    expect(postedBody).toContain("- **PR:** example-org/example-repo#17 - Demo PR");
    // Non-blocking run: section must say REVIEW FINDINGS, not BLOCKING ISSUES
    expect(postedBody).toContain("### REVIEW FINDINGS (1)");
    expect(postedBody).toContain("Pipeline status is failure");
    expectRevReportShape(postedBody);
    expect(expectVisibleReport(postedBody)).not.toContain("provider=github");
    const postedMetadata = expectMetadataDetails(postedBody);
    expect(postedMetadata).toContain("provider=github");
    expect(postedMetadata).toContain("target=github:example-org/example-repo#17");
    expect(postedMetadata).toContain("posted_by=gh");
    expect(postedMetadata).toContain("live_posting=posted");
  });

  it("blocks GitHub posting when gh auth is unavailable", async () => {
    const postLog = join(fakeBin, "github-post.txt");
    await writeGitHubFake(postLog);

    const result = await output(
      await runSamorev([
        "review",
        "https://github.com/example-org/example-repo/pull/17",
        "--fetch",
      ], { SAMOREV_FAKE_AUTH: "missing" }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Provider posting blocked");
    expect(result.stderr).toContain("gh auth status");
    const metadata = expectMetadataDetails(result.stdout);
    expect(metadata).toContain("provider=github");
    expect(metadata).toContain("target=github:example-org/example-repo#17");
    expect(metadata).toContain("ci_status=failure");
    expect(metadata).toContain("posted_by=gh");
    expect(metadata).toContain("live_posting=blocked");
    await expect(readFile(postLog, "utf8")).rejects.toThrow();
  });

  it("does not invoke provider posting in --no-comment mode", async () => {
    const postLog = join(fakeBin, "github-post.txt");
    await writeGitHubFake(postLog);

    const result = await output(
      await runSamorev([
        "review",
        "https://github.com/example-org/example-repo/pull/17",
        "--no-comment",
        "--fetch",
      ], { SAMOREV_FAKE_AUTH: "ok" }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("## samorev Code Review Report");
    // Non-blocking run: section must say REVIEW FINDINGS, not BLOCKING ISSUES
    expect(result.stdout).toContain("### REVIEW FINDINGS (1)");
    const metadata = expectMetadataDetails(result.stdout);
    expect(metadata).toContain("posted_by=local");
    expect(metadata).toContain("no_comment=true");
    expect(metadata).toContain("live_posting=not-run");
    await expect(readFile(postLog, "utf8")).rejects.toThrow();
  });

  it("posts GitLab fetch summary through authenticated glab", async () => {
    const postLog = join(fakeBin, "gitlab-post.txt");
    await writeGitLabFake(postLog);

    const result = await output(
      await runSamorev([
        "review",
        "https://gitlab.com/example-group/example-project/-/merge_requests/42",
        "--fetch",
      ], { SAMOREV_FAKE_AUTH: "ok" }),
    );

    expect(result.exitCode).toBe(0);
    const postedBody = await readFile(postLog, "utf8");
    expect(result.stdout).toContain("## samorev Code Review Report");
    expect(result.stdout).toContain("- **MR:** example-group/example-project!42 - GitLab demo");
    expectRevReportShape(result.stdout);
    expect(expectVisibleReport(result.stdout)).not.toContain("provider=gitlab");
    const stdoutMetadata = expectMetadataDetails(result.stdout);
    expect(stdoutMetadata).toContain("provider=gitlab");
    expect(stdoutMetadata).toContain("target=gitlab:example-group/example-project#42");
    expect(stdoutMetadata).toContain("ci_status=failed");
    expect(stdoutMetadata).toContain("posted_by=glab");
    expect(stdoutMetadata).toContain("live_posting=posted");
    expect(postedBody).toContain("## samorev Code Review Report");
    expect(postedBody).toContain("- **MR:** example-group/example-project!42 - GitLab demo");
    // Non-blocking run: section must say REVIEW FINDINGS, not BLOCKING ISSUES
    expect(postedBody).toContain("### REVIEW FINDINGS (1)");
    expect(postedBody).toContain("Pipeline status is failed");
    expectRevReportShape(postedBody);
    expect(expectVisibleReport(postedBody)).not.toContain("provider=gitlab");
    const postedMetadata = expectMetadataDetails(postedBody);
    expect(postedMetadata).toContain("provider=gitlab");
    expect(postedMetadata).toContain("target=gitlab:example-group/example-project#42");
    expect(postedMetadata).toContain("posted_by=glab");
    expect(postedMetadata).toContain("live_posting=posted");
  });

  it("blocks GitLab posting when glab auth is unavailable", async () => {
    const postLog = join(fakeBin, "gitlab-post.txt");
    await writeGitLabFake(postLog);

    const result = await output(
      await runSamorev([
        "review",
        "https://gitlab.com/example-group/example-project/-/merge_requests/42",
        "--fetch",
      ], { SAMOREV_FAKE_AUTH: "missing" }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Provider posting blocked");
    expect(result.stderr).toContain("glab auth status");
    const metadata = expectMetadataDetails(result.stdout);
    expect(metadata).toContain("provider=gitlab");
    expect(metadata).toContain("target=gitlab:example-group/example-project#42");
    expect(metadata).toContain("ci_status=failed");
    expect(metadata).toContain("posted_by=glab");
    expect(metadata).toContain("live_posting=blocked");
    await expect(readFile(postLog, "utf8")).rejects.toThrow();
  });

  it("renders GitLab public API fallback summary fields", async () => {
    const reference = parseReviewReference("https://gitlab.com/example-group/example-project/-/merge_requests/42");
    const plan = planFetch(reference);

    const { report: summary } = await fetchReviewSummary(reference, plan, ".claude/commands/review-mr.md", {
      blocking: true,
      // Stub the LLM runner so this unit test stays deterministic and fast.
      claudeRunner: async () => "NO_FINDINGS",
      runCommand: async () => {
        throw new FetchError("glab unavailable");
      },
      httpJson: async (url: string) => {
        if (url.endsWith("/merge_requests/42")) {
          return {
            title: "GitLab fallback demo",
            state: "opened",
            draft: false,
            head_pipeline: { status: "failed" },
          };
        }
        if (url.endsWith("/merge_requests/42/notes?per_page=100")) {
          return [{ body: "first" }, { body: "second" }];
        }
        if (url.endsWith("/merge_requests/42/commits")) {
          return [{ id: "abc" }, { id: "def" }, { id: "ghi" }];
        }
        if (url.endsWith("/merge_requests/42/diffs")) {
          return [
            {
              old_path: "app.ts",
              new_path: "app.ts",
              diff: "@@ -1 +1 @@\n-old = true\n+new = true\n",
            },
          ];
        }
        throw new Error(`unexpected GitLab API URL: ${url}`);
      },
    });

    expect(summary).toContain("## samorev Code Review Report");
    expect(summary).toContain("- **MR:** example-group/example-project!42 - GitLab fallback demo");
    expect(summary).toContain("### BLOCKING ISSUES (1)");
    expectRevReportShape(summary);
    expect(expectVisibleReport(summary)).not.toContain("provider=gitlab");
    const metadata = expectMetadataDetails(summary);
    expect(metadata).toContain("provider=gitlab");
    expect(metadata).toContain("kind=mr");
    expect(metadata).toContain("project=example-group/example-project");
    expect(metadata).toContain("target=gitlab:example-group/example-project#42");
    expect(metadata).toContain("number=42");
    expect(summary).toContain("Pipeline status is failed");
    expect(metadata).toContain("state=opened");
    expect(metadata).toContain("draft=false");
    expect(metadata).toContain("diff_lines=4");
    expect(metadata).toContain("diff_added=1");
    expect(metadata).toContain("diff_removed=1");
    expect(metadata).toContain("comments_count=2");
    expect(metadata).toContain("commits_count=3");
    expect(metadata).toContain("ci_status=failed");
    expect(metadata).toContain("ci_summary=pipeline_status=failed");
    expect(metadata).toContain("blocking=true");
    expect(metadata).toContain("posted_by=local");
    expect(metadata).toContain("no_comment=true");
    expect(metadata).toContain("live_posting=not-run");
  });

  it("keeps GitLab public fallback usable when notes are private", async () => {
    const reference = parseReviewReference("https://gitlab.com/example-group/example-project/-/merge_requests/42");
    const plan = planFetch(reference);

    const { report: summary } = await fetchReviewSummary(reference, plan, ".claude/commands/review-mr.md", {
      blocking: false,
      // Stub the LLM runner so this unit test stays deterministic and fast.
      claudeRunner: async () => "NO_FINDINGS",
      runCommand: async () => {
        throw new FetchError("glab unavailable");
      },
      httpJson: async (url: string) => {
        if (url.endsWith("/merge_requests/42")) {
          return { title: "Public MR", state: "merged", draft: false, head_pipeline: { status: "success" } };
        }
        if (url.endsWith("/merge_requests/42/notes?per_page=100")) {
          throw new FetchError("notes are private");
        }
        if (url.endsWith("/merge_requests/42/commits")) {
          return [{ id: "abc" }];
        }
        if (url.endsWith("/merge_requests/42/diffs")) {
          return [{ old_path: "README.md", new_path: "README.md", diff: "+demo\n" }];
        }
        throw new Error(`unexpected GitLab API URL: ${url}`);
      },
    });

    expect(summary).toContain("## samorev Code Review Report");
    expect(summary).toContain("- **MR:** example-group/example-project!42 - Public MR");
    expect(summary).toContain("No issues found. Reviewed for security, bugs, tests, guidelines, and documentation.");
    expect(summary).toContain("**Result: PASSED**");
    expectRevReportShape(summary);
    expect(expectVisibleReport(summary)).not.toContain("provider=gitlab");
    const metadata = expectMetadataDetails(summary);
    expect(metadata).toContain("provider=gitlab");
    expect(metadata).toContain("comments_count=0");
    expect(metadata).toContain("commits_count=1");
    expect(metadata).toContain("ci_status=success");
    expect(metadata).toContain("no_comment=true");
    expect(metadata).toContain("live_posting=not-run");
  });

  it("exits non-zero when --blocking and FAIL verdict (no-comment path)", async () => {
    await writeGitHubFake();

    // Without --blocking: exit 0 even on FAIL verdict (existing contract must stay)
    const noBlockResult = await output(
      await runSamorev([
        "review",
        "https://github.com/example-org/example-repo/pull/17",
        "--no-comment",
        "--fetch",
      ]),
    );
    expect(noBlockResult.exitCode).toBe(0);
    // Without --blocking: section says REVIEW FINDINGS (non-blocking label)
    expect(noBlockResult.stdout).toContain("### REVIEW FINDINGS (1)");

    // With --blocking: must exit non-zero when verdict is FAIL
    const blockResult = await output(
      await runSamorev([
        "review",
        "https://github.com/example-org/example-repo/pull/17",
        "--no-comment",
        "--fetch",
        "--blocking",
      ]),
    );
    expect(blockResult.exitCode).not.toBe(0);
    // With --blocking: section says BLOCKING ISSUES (blocking label)
    expect(blockResult.stdout).toContain("### BLOCKING ISSUES (1)");
    expect(blockResult.stdout).toContain("Pipeline status is failure");
  });

  it("exits zero when --blocking but verdict is PASS", async () => {
    await writeGitHubPassFake();

    const result = await output(
      await runSamorev([
        "review",
        "https://github.com/example-org/example-repo/pull/17",
        "--no-comment",
        "--fetch",
        "--blocking",
      ]),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("**Result: PASSED**");
  });

  it("plans numeric GitHub references from remote URL", () => {
    const reference = parseReviewReference("17", "git@github.com:example-org/example-repo.git");
    const plan = planFetch(reference);

    expect(reference.provider).toBe("github");
    expect(reference.kind).toBe("pr");
    expect(reference.projectPath).toBe("example-org/example-repo");
    expect(plan.metadataCommand.join(" ")).toContain("gh pr view 17 --repo example-org/example-repo");
    expect(plan.ciCommand.join(" ")).toContain("repos/example-org/example-repo/commits/pull/17/head/check-runs");
  });

  it("rejects invalid references without a traceback", async () => {
    const result = await output(await runSamorev(["review", "not-a-review", "--no-comment", "--fetch"]));

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Invalid review reference");
    expect(result.stderr).not.toContain("error:");
    expect(result.stderr).not.toContain("Traceback");
  });

  it("documents the Bun CLI contract in a concise root spec", async () => {
    const spec = await readFile(join(repoRoot, "SPEC.md"), "utf8");

    expect(spec).toContain("# samorev - Product Spec");
    expect(spec).toContain("bun run samorev review <reference>");
    expect(spec).toContain("GitHub");
    expect(spec).toContain("GitLab");
    expect(spec).toContain("provider-native");
    expect(spec).toContain("PASS/FAIL");
    expect(spec).toContain("Evidence Standards");
    expect(spec).toContain("Acceptance Criteria");
    expect(spec).toContain("NikolayS/samospec#165");
  });
});

function expectRevReportShape(report: string) {
  expect(report.startsWith("## samorev Code Review Report")).toBe(true);
  expect(report).toContain("## samorev Code Review Report");
  expect(report).toContain("| Pipeline | Coverage |");
  expect(report).toContain("|----------|----------|");
  expect(report).toContain("### Summary");
  expect(report).toContain("| Area | Findings | Potential | Filtered |");
  expect(report).toContain("Note:");
  expect(report).toContain("*samorev-assisted review (AI analysis by [Tanya301/samorev](https://github.com/Tanya301/samorev))*");
  for (const key of rawMetadataKeys) {
    expect(expectVisibleReport(report)).not.toContain(key);
  }
}

function expectVisibleReport(report: string): string {
  return report.replace(/<details>[\s\S]*?<\/details>/g, "");
}

function expectMetadataDetails(report: string): string {
  const match = report.match(/<details>\s*<summary>Review metadata<\/summary>\s*```text\n([\s\S]*?)\n```\s*<\/details>/);
  expect(match).not.toBeNull();
  return match?.[1] ?? "";
}

async function writeGitHubFake(postLog?: string) {
  await writeFile(
    join(fakeBin, "gh"),
    `#!/usr/bin/env bun
const args = Bun.argv.slice(2);
if (args.slice(0, 3).join(" ") === "pr view 17") {
  console.log(JSON.stringify({ title: "Demo PR", state: "OPEN", isDraft: false }));
} else if (args.slice(0, 3).join(" ") === "pr diff 17") {
  Bun.write(Bun.stdout, "diff --git a/app.ts b/app.ts\\n+console.log('demo')\\n-old = true\\n");
} else if (args.slice(0, 2).join(" ") === "api repos/example-org/example-repo/issues/17/comments") {
  console.log(JSON.stringify([{ body: "first" }, { body: "second" }]));
} else if (args.slice(0, 2).join(" ") === "api repos/example-org/example-repo/pulls/17/commits") {
  console.log(JSON.stringify([{ sha: "abc" }, { sha: "def" }, { sha: "ghi" }]));
} else if (args.slice(0, 2).join(" ") === "api repos/example-org/example-repo/commits/pull/17/head/check-runs") {
  console.log(JSON.stringify({ total_count: 2, check_runs: [{ name: "unit", conclusion: "success" }, { name: "lint", conclusion: "failure" }] }));
} else if (args.slice(0, 2).join(" ") === "auth status") {
  if (process.env.SAMOREV_FAKE_AUTH === "ok") {
    console.error("Logged in to github.com");
  } else {
    console.error("not logged in to github.com");
    process.exit(1);
  }
} else if (args.slice(0, 3).join(" ") === "pr comment 17") {
  const index = args.indexOf("--body");
  const body = args[index + 1] ?? "";
  await Bun.write(${JSON.stringify(postLog ?? join(fakeBin, "unexpected-github-post.txt"))}, body);
} else {
  console.error("unexpected gh args: " + JSON.stringify(args));
  process.exit(42);
}
`,
    { mode: 0o755 },
  );
}

async function writeGitHubPassFake() {
  await writeFile(
    join(fakeBin, "gh"),
    `#!/usr/bin/env bun
const args = Bun.argv.slice(2);
if (args.slice(0, 3).join(" ") === "pr view 17") {
  console.log(JSON.stringify({ title: "Demo PR", state: "OPEN", isDraft: false }));
} else if (args.slice(0, 3).join(" ") === "pr diff 17") {
  Bun.write(Bun.stdout, "diff --git a/app.ts b/app.ts\\n+console.log('demo')\\n-old = true\\n");
} else if (args.slice(0, 2).join(" ") === "api repos/example-org/example-repo/issues/17/comments") {
  console.log(JSON.stringify([{ body: "first" }, { body: "second" }]));
} else if (args.slice(0, 2).join(" ") === "api repos/example-org/example-repo/pulls/17/commits") {
  console.log(JSON.stringify([{ sha: "abc" }, { sha: "def" }, { sha: "ghi" }]));
} else if (args.slice(0, 2).join(" ") === "api repos/example-org/example-repo/commits/pull/17/head/check-runs") {
  console.log(JSON.stringify({ total_count: 2, check_runs: [{ name: "unit", conclusion: "success" }, { name: "lint", conclusion: "success" }] }));
} else if (args.slice(0, 2).join(" ") === "auth status") {
  console.error("Logged in to github.com");
} else {
  console.error("unexpected gh args: " + JSON.stringify(args));
  process.exit(42);
}
`,
    { mode: 0o755 },
  );
}

async function writeGitLabFake(postLog?: string) {
  await writeFile(
    join(fakeBin, "glab"),
    `#!/usr/bin/env bun
const args = Bun.argv.slice(2);
if (args.slice(0, 2).join(" ") === "api projects/example-group%2Fexample-project/merge_requests/42") {
  console.log(JSON.stringify({ title: "GitLab demo", state: "opened", draft: false, head_pipeline: { status: "failed" } }));
} else if (args.slice(0, 3).join(" ") === "mr diff 42") {
  Bun.write(Bun.stdout, "diff --git a/app.ts b/app.ts\\n+console.log('demo')\\n-old = true\\n");
} else if (args.slice(0, 2).join(" ") === "api projects/example-group%2Fexample-project/merge_requests/42/notes?per_page=10&sort=desc") {
  console.log(JSON.stringify([{ body: "first" }, { body: "second" }]));
} else if (args.slice(0, 2).join(" ") === "api projects/example-group%2Fexample-project/merge_requests/42/commits") {
  console.log(JSON.stringify([{ id: "abc" }, { id: "def" }]));
} else if (args.slice(0, 2).join(" ") === "auth status") {
  if (process.env.SAMOREV_FAKE_AUTH === "ok") {
    console.error("Logged in to gitlab.com");
  } else {
    console.error("not logged in to gitlab.com");
    process.exit(1);
  }
} else if (args.slice(0, 3).join(" ") === "mr comment 42") {
  const index = args.indexOf("-m");
  await Bun.write(${JSON.stringify(postLog ?? join(fakeBin, "unexpected-gitlab-post.txt"))}, args[index + 1] ?? "");
} else {
  console.error("unexpected glab args: " + JSON.stringify(args));
  process.exit(42);
}
`,
    { mode: 0o755 },
  );
}
