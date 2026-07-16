/**
 * TDD tests for the large-diff false-positive fix and 3 smaller bugs.
 *
 * RED commit: ALL tests below MUST FAIL against the current production code
 * because:
 *   1. buildReviewPrompt truncates first-40k-wins, so generated dist content
 *      consumes the budget and source/test content is dropped.
 *   2. "AI-Assisted: Unknown" is hardcoded — does not reflect actual LLM use.
 *   3. Category counts (Findings column) lump all confidence >= 4 together
 *      instead of splitting Findings (8-10) vs Potential (4-7).
 *   4. bun install --frozen-lockfile fails because the lockfile was stale.
 *
 * GREEN commit: fixes make every test pass.
 */

import { describe, expect, it } from "bun:test";
import { fetchReviewSummary, parseLlmFindings } from "../src/fetchReport";
import { parseReviewReference, planFetch } from "../src/providerPlanning";
import { buildReviewPromptForTest } from "../src/fetchReport";

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

const greenGitHubMeta = { title: "Large Diff PR", state: "OPEN", isDraft: false };
const greenGitHubCi = { check_runs: [{ name: "ci", conclusion: "success" }] };

/** Build a diff whose generated file body alone exceeds 40 000 chars. */
function makeLargeDiff(): { diff: string; sourceFile: string; testFile: string; generatedFile: string } {
  const sourceFile = "src/parser.ts";
  const testFile = "tests/parser.test.ts";
  const generatedFile = "dist/bundle.js";

  // Source file content — small but meaningful
  const sourceDiff = [
    `diff --git a/${sourceFile} b/${sourceFile}`,
    `--- a/${sourceFile}`,
    `+++ b/${sourceFile}`,
    "@@ -1,5 +1,8 @@",
    " export function parseToken(input: string): string {",
    "+  // SECURITY_MARKER: validate input before returning",
    "+  if (!input || input.length === 0) throw new RangeError('empty input');",
    "+  // TEST_MARKER: this branch needs coverage",
    "   return input.trim();",
    " }",
  ].join("\n");

  // Test file content — small but meaningful
  const testDiff = [
    `diff --git a/${testFile} b/${testFile}`,
    `--- a/${testFile}`,
    `+++ b/${testFile}`,
    "@@ -1,4 +1,7 @@",
    ' import { parseToken } from "../src/parser";',
    " describe('parseToken', () => {",
    "+  it('COVERAGE_MARKER: throws on empty input', () => {",
    "+    expect(() => parseToken('')).toThrow(RangeError);",
    "+  });",
    " });",
  ].join("\n");

  // Generated dist file — body exceeds 40 000 chars by itself
  const generatedBody = "x".repeat(45_000);
  const generatedDiff = [
    `diff --git a/${generatedFile} b/${generatedFile}`,
    `--- a/${generatedFile}`,
    `+++ b/${generatedFile}`,
    "@@ -1 +1 @@",
    `-old_bundle`,
    `+${generatedBody}`,
  ].join("\n");

  // Order: generated file FIRST so old code truncates it before source/tests
  const diff = [generatedDiff, sourceDiff, testDiff].join("\n\n");
  return { diff, sourceFile, testFile, generatedFile };
}

const githubRef = parseReviewReference("https://github.com/example-org/example-repo/pull/99");
const githubPlan = planFetch(githubRef);

function makeRunCommand(diff: string) {
  return async (cmd: string[]): Promise<string> => {
    const joined = cmd.join(" ");
    if (joined.includes("pr view")) return JSON.stringify(greenGitHubMeta);
    if (joined.includes("pr diff")) return diff;
    if (joined.includes("issues") && joined.includes("comments")) return JSON.stringify([]);
    if (joined.includes("pulls") && joined.includes("commits")) return JSON.stringify([{ sha: "abc" }]);
    if (joined.includes("check-runs")) return JSON.stringify(greenGitHubCi);
    throw new Error(`unexpected command: ${joined}`);
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Test group 1 — Main bug: large-diff false positive
// ────────────────────────────────────────────────────────────────────────────

describe("large-diff false-positive fix", () => {
  it("prompt always contains all changed file paths even when content is large", () => {
    const { diff, sourceFile, testFile, generatedFile } = makeLargeDiff();
    const prompt = buildReviewPromptForTest(diff, "Large Diff PR", "");

    // All three file paths must appear in the prompt (file list, not truncated)
    expect(prompt).toContain(sourceFile);
    expect(prompt).toContain(testFile);
    expect(prompt).toContain(generatedFile);
  });

  it("prompt contains source and test file CONTENT (not truncated away by generated file)", () => {
    const { diff } = makeLargeDiff();
    const prompt = buildReviewPromptForTest(diff, "Large Diff PR", "");

    // Source content markers must survive
    expect(prompt).toContain("SECURITY_MARKER");
    expect(prompt).toContain("TEST_MARKER");

    // Test content markers must survive
    expect(prompt).toContain("COVERAGE_MARKER");
  });

  it("prompt does NOT contain the generated dist file body", () => {
    const { diff } = makeLargeDiff();
    const prompt = buildReviewPromptForTest(diff, "Large Diff PR", "");

    // The 45 000-char padding string must be absent (body filtered out)
    expect(prompt).not.toContain("x".repeat(100));
  });

  it("prompt contains do-not-claim-absent instruction for listed files", () => {
    const { diff, sourceFile, testFile } = makeLargeDiff();
    const prompt = buildReviewPromptForTest(diff, "Large Diff PR", "");

    // Must instruct the model NOT to report source/tests absent for listed files
    expect(prompt.toLowerCase()).toMatch(/do not report|do not claim|not absent/);
    expect(prompt).toContain(sourceFile);
    expect(prompt).toContain(testFile);
  });

  it("model receives source+test content and does NOT emit false absent-source blocker", async () => {
    const { diff } = makeLargeDiff();

    // Simulate a model that would emit a false positive if it didn't see source/tests
    let capturedPrompt = "";
    const fakeClaudeRunner = async (prompt: string): Promise<string> => {
      capturedPrompt = prompt;
      // If source is missing from prompt the model would say "source absent"
      if (!prompt.includes("SECURITY_MARKER") || !prompt.includes("COVERAGE_MARKER")) {
        return [
          "FINDING:",
          "- severity: HIGH",
          "- confidence: 9",
          "- area: Tests",
          "- issue: Source and test files are absent from the diff",
          "- evidence: only generated dist content seen",
          "- fix: include source and test files",
        ].join("\n");
      }
      return "NO_FINDINGS";
    };

    const { report, outcome } = await fetchReviewSummary(
      githubRef,
      githubPlan,
      ".claude/commands/review-mr.md",
      {
        blocking: true,
        runCommand: makeRunCommand(diff),
        noComment: true,
        claudeRunner: fakeClaudeRunner,
      },
    );

    // Must NOT be a false-positive FAIL
    expect(outcome).toBe("PASS");
    expect(report).toContain("**Result: PASSED**");
    // Prompt must have included source/test content
    expect(capturedPrompt).toContain("SECURITY_MARKER");
    expect(capturedPrompt).toContain("COVERAGE_MARKER");
  });

  it("generated lockfile passes bun install --frozen-lockfile", async () => {
    const { $ } = await import("bun");
    // This will throw if the lockfile is stale
    const result = await $`bun install --frozen-lockfile`.cwd(
      import.meta.dir.replace(/\/tests$/, ""),
    ).quiet().nothrow();
    expect(result.exitCode).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Test group 2 — Bug (a): AI-Assisted label
// ────────────────────────────────────────────────────────────────────────────

describe("AI-Assisted label accuracy", () => {
  it('report does NOT say "AI-Assisted: Unknown" when LLM was invoked', async () => {
    const { diff } = makeLargeDiff();

    const { report } = await fetchReviewSummary(
      githubRef,
      githubPlan,
      ".claude/commands/review-mr.md",
      {
        blocking: false,
        runCommand: makeRunCommand(diff),
        noComment: true,
        claudeRunner: async () => "NO_FINDINGS",
      },
    );

    expect(report).not.toContain("AI-Assisted: Unknown");
    // Must show that AI review was performed (handles bold markdown: **AI-Assisted:** Yes)
    expect(report).toMatch(/AI-Assisted:\*{0,2}\s*(Yes|claude|used)/i);
  });

  it('report says "AI-Assisted: No" when claudeRunner threw (fail-closed path)', async () => {
    const { diff } = makeLargeDiff();

    const { report } = await fetchReviewSummary(
      githubRef,
      githubPlan,
      ".claude/commands/review-mr.md",
      {
        blocking: false,
        runCommand: makeRunCommand(diff),
        noComment: true,
        claudeRunner: async () => { throw new Error("LLM unavailable"); },
      },
    );

    // Fail-closed path: LLM was NOT used successfully
    expect(report).not.toContain("AI-Assisted: Unknown");
    expect(report).toMatch(/AI-Assisted:\*{0,2}\s*No/i);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Test group 3 — Bug (b): category count summary matches displayed findings
// ────────────────────────────────────────────────────────────────────────────

describe("category count consistency", () => {
  it("Findings column shows only high-confidence (8-10) findings, Potential shows medium (4-7)", () => {
    const llmOutput = [
      // High confidence bug (8-10) → Findings
      "FINDING:",
      "- severity: HIGH",
      "- confidence: 9",
      "- area: Bugs",
      "- issue: null dereference",
      "- evidence: foo.bar",
      "- fix: guard null",
      "",
      // Medium confidence bug (4-7) → Potential
      "FINDING:",
      "- severity: MEDIUM",
      "- confidence: 6",
      "- area: Bugs",
      "- issue: possible edge case",
      "- evidence: edge",
      "- fix: add check",
      "",
      // Low confidence (filtered out — below threshold)
      "FINDING:",
      "- severity: LOW",
      "- confidence: 3",
      "- area: Bugs",
      "- issue: style nit",
      "- evidence: style",
      "- fix: style fix",
    ].join("\n");

    const result = parseLlmFindings(llmOutput);

    // High-confidence (8-10): 1 bug
    expect(result.bugs).toBe(1);
    // Medium-confidence (4-7): 1 potential bug
    expect(result.potentialBugs).toBe(1);
    // Low-confidence (< 4) is filtered
  });

  it("summary table Findings count equals number of blocking items displayed", async () => {
    const { diff } = makeLargeDiff();

    // 1 HIGH bug (confidence 9) → blocking, shows in Findings
    // 1 MEDIUM bug (confidence 5) → blocking, shows in Potential
    const llmOutput = [
      "FINDING:",
      "- severity: HIGH",
      "- confidence: 9",
      "- area: Bugs",
      "- issue: real bug A",
      "- evidence: bug_a",
      "- fix: fix A",
      "",
      "FINDING:",
      "- severity: MEDIUM",
      "- confidence: 5",
      "- area: Bugs",
      "- issue: potential bug B",
      "- evidence: bug_b",
      "- fix: fix B",
    ].join("\n");

    const { report } = await fetchReviewSummary(
      githubRef,
      githubPlan,
      ".claude/commands/review-mr.md",
      {
        blocking: false,
        runCommand: makeRunCommand(diff),
        noComment: true,
        claudeRunner: async () => llmOutput,
      },
    );

    // Findings column for Bugs must show 1 (the high-confidence one)
    const findingsRow = report.match(/\| Bugs \| (\d+) \| (\d+) \|/);
    expect(findingsRow).not.toBeNull();
    expect(findingsRow![1]).toBe("1"); // Findings (8-10)
    expect(findingsRow![2]).toBe("1"); // Potential (4-7)
  });

  it("total count in BLOCKING ISSUES header matches number of blocking item paragraphs", async () => {
    const { diff } = makeLargeDiff();

    // 2 HIGH findings → 2 blocking items → header should say BLOCKING ISSUES (2)
    const llmOutput = [
      "FINDING:",
      "- severity: HIGH",
      "- confidence: 9",
      "- area: Security",
      "- issue: sql injection",
      "- evidence: sql",
      "- fix: parameterize",
      "",
      "FINDING:",
      "- severity: HIGH",
      "- confidence: 8",
      "- area: Bugs",
      "- issue: null deref",
      "- evidence: null",
      "- fix: guard",
    ].join("\n");

    const { report } = await fetchReviewSummary(
      githubRef,
      githubPlan,
      ".claude/commands/review-mr.md",
      {
        blocking: false,
        runCommand: makeRunCommand(diff),
        noComment: true,
        claudeRunner: async () => llmOutput,
      },
    );

    // Header shows count
    const headerMatch = report.match(/### BLOCKING ISSUES \((\d+)\)/);
    expect(headerMatch).not.toBeNull();
    const declaredCount = parseInt(headerMatch![1], 10);

    // Count actual FINDING blocks in the rendered BLOCKING section
    const blockingSection = report.match(/### BLOCKING ISSUES[\s\S]*?---/)?.[0] ?? "";
    const renderedItems = (blockingSection.match(/\*\*(CRITICAL|HIGH|MEDIUM)\*\*/g) ?? []).length;

    expect(declaredCount).toBe(renderedItems);
  });
});
