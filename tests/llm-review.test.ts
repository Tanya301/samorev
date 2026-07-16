/**
 * TDD tests for real LLM review via claude -p subprocess.
 *
 * These tests mock ONLY the claude -p boundary (via the claudeRunner option).
 * All other logic — diff fetching, CI check, report rendering — uses real code.
 *
 * RED commit: all four tests below must FAIL because the production code
 * does not yet invoke claudeRunner or parse LLM findings.
 */

import { describe, expect, it } from "bun:test";
import { fetchReviewSummary } from "../src/fetchReport";
import { parseReviewReference, planFetch } from "../src/providerPlanning";

// ──────────────────────────────────────────────────────────────────────────────
// Helpers — minimal provider stubs (green CI so the gate doesn't override)
// ──────────────────────────────────────────────────────────────────────────────

const greenGitHubMeta = { title: "My PR", state: "OPEN", isDraft: false };
const greenGitHubCi = {
  check_runs: [{ name: "ci", conclusion: "success" }],
};
const sampleDiff = [
  "diff --git a/math.ts b/math.ts",
  "--- a/math.ts",
  "+++ b/math.ts",
  "@@ -1,5 +1,5 @@",
  " export function divide(a: number, b: number) {",
  "-  return a / b;",
  "+  return a / 0; // BUG: always divides by zero",
  " }",
].join("\n");

function makeRunCommand(
  meta = greenGitHubMeta,
  ci = greenGitHubCi,
  diff = sampleDiff,
) {
  return async (cmd: string[]): Promise<string> => {
    const joined = cmd.join(" ");
    if (joined.includes("pr view")) return JSON.stringify(meta);
    if (joined.includes("pr diff")) return diff;
    if (joined.includes("issues") && joined.includes("comments")) return JSON.stringify([]);
    if (joined.includes("pulls") && joined.includes("commits")) return JSON.stringify([{ sha: "abc" }]);
    if (joined.includes("check-runs")) return JSON.stringify(ci);
    throw new Error(`unexpected command: ${joined}`);
  };
}

const githubRef = parseReviewReference("https://github.com/example-org/example-repo/pull/17");
const githubPlan = planFetch(githubRef);

// ──────────────────────────────────────────────────────────────────────────────
// Test 1: Model reports 2 bugs → Bugs row = 2, outcome = FAIL
// ──────────────────────────────────────────────────────────────────────────────
describe("LLM review integration", () => {
  it("shows 2 bugs and FAIL when the model reports 2 bugs", async () => {
    const bugFindings = [
      "FINDING:",
      "- severity: HIGH",
      "- confidence: 9",
      "- area: Bugs",
      "- issue: divide by zero will crash at runtime",
      "- evidence: return a / 0;",
      "- fix: use the original divisor parameter `b`",
      "",
      "FINDING:",
      "- severity: MEDIUM",
      "- confidence: 8",
      "- area: Bugs",
      "- issue: missing guard for b === 0",
      "- evidence: return a / 0;",
      "- fix: throw RangeError when b is zero",
    ].join("\n");

    let claudeCalledWith = "";
    const fakeClaudeRunner = async (prompt: string): Promise<string> => {
      claudeCalledWith = prompt;
      return bugFindings;
    };

    const { report, outcome } = await fetchReviewSummary(
      githubRef,
      githubPlan,
      ".claude/commands/review-mr.md",
      {
        blocking: true,
        runCommand: makeRunCommand(),
        noComment: true,
        claudeRunner: fakeClaudeRunner,
      },
    );

    // Must have called the LLM runner (proves not hardcoded)
    expect(claudeCalledWith).toContain("divide");
    expect(claudeCalledWith).toContain("BUG");

    // Bugs row must show 2
    const bugsRow = report.match(/\| Bugs \| (\d+) \|/);
    expect(bugsRow).not.toBeNull();
    expect(bugsRow![1]).toBe("2");

    // Outcome must be FAIL
    expect(outcome).toBe("FAIL");

    // Report must contain BLOCKING section
    expect(report).toContain("### BLOCKING ISSUES");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test 2: Clean review + green CI → all rows 0, outcome = PASS
  // ──────────────────────────────────────────────────────────────────────────
  it("shows 0 findings and PASS when model and CI are clean", async () => {
    let claudeCalled = false;
    const fakeClaudeRunner = async (_prompt: string): Promise<string> => {
      claudeCalled = true;
      return "NO_FINDINGS";
    };

    const { report, outcome } = await fetchReviewSummary(
      githubRef,
      githubPlan,
      ".claude/commands/review-mr.md",
      {
        blocking: true,
        runCommand: makeRunCommand(),
        noComment: true,
        claudeRunner: fakeClaudeRunner,
      },
    );

    expect(claudeCalled).toBe(true);

    // All LLM area rows must show 0 findings
    for (const area of ["Security", "Bugs", "Tests", "Guidelines", "Docs"]) {
      const row = report.match(new RegExp(`\\| ${area} \\| (\\d+) \\|`));
      expect(row).not.toBeNull();
      expect(row![1]).toBe("0");
    }

    expect(outcome).toBe("PASS");
    expect(report).toContain("**Result: PASSED**");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test 3: claudeRunner is actually called with the diff (not hardcoded)
  // ──────────────────────────────────────────────────────────────────────────
  it("passes the actual diff text to claudeRunner", async () => {
    const uniqueMarker = "UNIQUE_DIFF_MARKER_XYZ_7439";
    const markedDiff = sampleDiff + `\n+// ${uniqueMarker}`;

    let capturedPrompt = "";
    const fakeClaudeRunner = async (prompt: string): Promise<string> => {
      capturedPrompt = prompt;
      return "NO_FINDINGS";
    };

    await fetchReviewSummary(
      githubRef,
      githubPlan,
      ".claude/commands/review-mr.md",
      {
        blocking: false,
        runCommand: makeRunCommand(greenGitHubMeta, greenGitHubCi, markedDiff),
        noComment: true,
        claudeRunner: fakeClaudeRunner,
      },
    );

    // The runner must have been invoked with the actual diff content
    expect(capturedPrompt).toContain(uniqueMarker);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test 4: --blocking exits non-zero on FAIL, zero on PASS
  // (This is the unit-level gate; the CLI integration test covers the
  //  full process exit code via the existing bun-cli.test.ts suite.)
  // ──────────────────────────────────────────────────────────────────────────
  it("outcome is FAIL when model returns bug findings (blocking exit-code test)", async () => {
    const bugLlmOutput = [
      "FINDING:",
      "- severity: CRITICAL",
      "- confidence: 10",
      "- area: Security",
      "- issue: SQL injection via raw string concat",
      "- evidence: `SELECT * FROM users WHERE id = ` + userId",
      "- fix: use parameterized queries",
    ].join("\n");

    const fakeClaudeRunner = async (_prompt: string): Promise<string> => bugLlmOutput;

    const { outcome } = await fetchReviewSummary(
      githubRef,
      githubPlan,
      ".claude/commands/review-mr.md",
      {
        blocking: true,
        runCommand: makeRunCommand(),
        noComment: true,
        claudeRunner: fakeClaudeRunner,
      },
    );

    // Must be FAIL so the CLI returns exit code 1 with --blocking
    expect(outcome).toBe("FAIL");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test 5: Fail-closed — if claudeRunner throws, outcome must NOT be PASS
  // ──────────────────────────────────────────────────────────────────────────
  it("is fail-closed: errors from claudeRunner produce FAIL not PASS", async () => {
    const fakeClaudeRunner = async (_prompt: string): Promise<string> => {
      throw new Error("claude subprocess died");
    };

    const { outcome } = await fetchReviewSummary(
      githubRef,
      githubPlan,
      ".claude/commands/review-mr.md",
      {
        blocking: true,
        runCommand: makeRunCommand(),
        noComment: true,
        claudeRunner: fakeClaudeRunner,
      },
    );

    // Fail-closed: error means we cannot trust the result → FAIL
    expect(outcome).toBe("FAIL");
  });
});
