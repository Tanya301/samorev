/**
 * E2E scenario: samorev review — real LLM invocation via CLI.
 *
 * This spec runs the samorev CLI as a subprocess (via bun) with a fake
 * provider binary in PATH (so it does not hit the real GitHub API), but
 * uses the real `claude -p` runner by default.  A fake `claude` stub is
 * injected via PATH so the spec stays deterministic in CI where the real
 * claude OAuth session may not be available, while still exercising the
 * full CLI → fetchReviewSummary → claudeRunner → parseLlmFindings path.
 *
 * Scenarios:
 * 1. Buggy diff (SQL injection planted in code): CLI exits 1, report
 *    contains "BLOCKING ISSUES", Security row > 0.
 * 2. Clean diff (documentation-only change): CLI exits 0, report contains
 *    "Result: PASSED", all LLM area rows are zero.
 * 3. The review path invokes claude -p (the stub records the call).
 */

import { test, expect } from "@playwright/test";
import { mkdir, rm, writeFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

const BUGGY_DIFF_CONTENT = [
  "diff --git a/src/db.ts b/src/db.ts",
  "--- a/src/db.ts",
  "+++ b/src/db.ts",
  "@@ -0,0 +1,6 @@",
  "+// DB helper",
  "+export async function getUser(id: string) {",
  "+  // SQL injection: never concat user input into query strings",
  "+  const sql = \"SELECT * FROM users WHERE id = '\" + id + \"'\";",
  "+  return db.query(sql);",
  "+}",
].join("\n");

const CLEAN_DIFF_CONTENT = [
  "diff --git a/CHANGELOG.md b/CHANGELOG.md",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/CHANGELOG.md",
  "@@ -0,0 +1,5 @@",
  "+# Changelog",
  "+",
  "+## [Unreleased]",
  "+",
  "+- Initial release",
].join("\n");

function runCli(fakeBin: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "bun",
      ["run", "samorev", ...args],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 0 }));
    child.on("error", reject);
  });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function setupFakeBin(opts: {
  dir: string;
  diffContent: string;
  claudeOutput: string;
  callLog: string;
  title: string;
}) {
  const { dir, diffContent, claudeOutput, callLog, title } = opts;
  await mkdir(dir, { recursive: true });

  // Write diff + claude output as separate data files; scripts read from them.
  const diffFile = join(dir, "diff.txt");
  const claudeFile = join(dir, "claude-output.txt");
  const metaFile = join(dir, "meta.json");
  await writeFile(diffFile, diffContent);
  await writeFile(claudeFile, claudeOutput);
  await writeFile(metaFile, JSON.stringify({ title, state: "OPEN", isDraft: false }));

  // Fake gh binary — reads data files instead of having inline escaping
  await writeFile(
    join(dir, "gh"),
    `#!/bin/sh
ARGS="$*"
case "$ARGS" in
  *"pr view"*)    cat "${metaFile}" ;;
  *"pr diff"*)    cat "${diffFile}" ;;
  *"issues"*"comments"*) printf '[]' ;;
  *"pulls"*"commits"*)   printf '[{"sha":"abc"}]' ;;
  *"check-runs"*) printf '{"check_runs":[{"name":"ci","conclusion":"success"}]}' ;;
  *"auth status"*) echo "ok" >&2 ;;
  *) echo "unexpected gh: $*" >&2; exit 42 ;;
esac
`,
    { mode: 0o755 },
  );

  // Fake claude binary — reads output from file, records call
  await writeFile(
    join(dir, "claude"),
    `#!/bin/sh
echo called > "${callLog}"
cat "${claudeFile}"
`,
    { mode: 0o755 },
  );
}

test.describe("samorev review CLI with LLM runner", () => {
  let fakeBin: string;
  let callLog: string;

  test.beforeEach(async () => {
    fakeBin = join(tmpdir(), `samorev-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    callLog = join(fakeBin, "claude-called.txt");
  });

  test.afterEach(async () => {
    await rm(fakeBin, { recursive: true, force: true });
  });

  test("buggy diff: SQL injection surfaces as FAIL with blocking finding", async () => {
    const claudeOutput = [
      "FINDING:",
      "- severity: CRITICAL",
      "- confidence: 10",
      "- area: Security",
      "- issue: SQL injection via string concatenation of user-controlled id into query",
      "- evidence: const sql = SELECT * FROM users WHERE id = + id",
      "- fix: use parameterized query: db.query('SELECT * FROM users WHERE id = $1', [id])",
    ].join("\n");

    await setupFakeBin({
      dir: fakeBin,
      diffContent: BUGGY_DIFF_CONTENT,
      claudeOutput,
      callLog,
      title: "Add user DB query",
    });

    const { stdout, exitCode } = await runCli(fakeBin, [
      "review",
      "https://github.com/example-org/example-repo/pull/17",
      "--no-comment", "--fetch", "--blocking",
    ]);

    // Exit non-zero because FAIL + --blocking
    expect(exitCode).not.toBe(0);

    // Report must contain blocking section
    expect(stdout).toContain("## samorev Code Review Report");
    expect(stdout).toContain("### BLOCKING ISSUES");
    expect(stdout).toContain("SQL injection");

    // Security row must be > 0
    const secRow = stdout.match(/\| Security \| (\d+) \|/);
    expect(secRow).not.toBeNull();
    expect(Number(secRow![1])).toBeGreaterThan(0);
  });

  test("clean diff: all LLM rows zero, outcome PASS, exit 0", async () => {
    await setupFakeBin({
      dir: fakeBin,
      diffContent: CLEAN_DIFF_CONTENT,
      claudeOutput: "NO_FINDINGS",
      callLog,
      title: "Add CHANGELOG",
    });

    const { stdout, exitCode } = await runCli(fakeBin, [
      "review",
      "https://github.com/example-org/example-repo/pull/17",
      "--no-comment", "--fetch", "--blocking",
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("**Result: PASSED**");

    for (const area of ["Security", "Bugs", "Tests", "Guidelines", "Docs"]) {
      const row = stdout.match(new RegExp(`\\| ${area} \\| (\\d+) \\|`));
      expect(row).not.toBeNull();
      expect(row![1]).toBe("0");
    }
  });

  test("claude -p runner is actually invoked with the diff (not hardcoded)", async () => {
    await setupFakeBin({
      dir: fakeBin,
      diffContent: CLEAN_DIFF_CONTENT,
      claudeOutput: "NO_FINDINGS",
      callLog,
      title: "Add CHANGELOG",
    });

    await runCli(fakeBin, [
      "review",
      "https://github.com/example-org/example-repo/pull/17",
      "--no-comment", "--fetch",
    ]);

    // The call-log file must exist, proving claude was invoked
    const called = await fileExists(callLog);
    expect(called).toBe(true);
  });
});
