/**
 * TDD tests for the report count/label consistency fix.
 *
 * Two bugs Maya found in the PR #11 review output:
 *
 * Bug 1 — Misleading section header when blocking=false
 *   The rendered report says "### BLOCKING ISSUES (2)" even though the review
 *   is non-blocking (blocking=false). A non-blocking review must NOT use the
 *   word "BLOCKING" in the section header.
 *
 * Bug 2 — Displayed issue count ≠ Summary table totals
 *   The section printed 2 issue blocks but the Summary table showed 5 Potential
 *   (4 Bugs + 1 Tests). The three "missing" items had LOW severity so they
 *   weren't added to blockingItems, yet they were counted in potentialBugs /
 *   potentialTests. The invariant: the count in the section header MUST equal
 *   the number of issue blocks actually rendered AND MUST equal the sum of all
 *   Findings + Potential in the Summary table.
 *
 * RED commit: ALL tests below MUST FAIL against the current code because:
 *   - The header always says "BLOCKING ISSUES" regardless of blocking flag.
 *   - blockingItems only collects CRITICAL/HIGH/MEDIUM severity items; LOW items
 *     are counted in the table but never rendered in the section.
 *
 * GREEN commit: production fix makes every test pass.
 */

import { describe, expect, it } from "bun:test";
import { fetchReviewSummary, parseLlmFindings } from "../src/fetchReport";
import { parseReviewReference, planFetch } from "../src/providerPlanning";

// ──────────────────────────────────────────────────────────────────────────────
// Shared fixtures
// ──────────────────────────────────────────────────────────────────────────────

const greenGitHubMeta = { title: "Test PR", state: "OPEN", isDraft: false };
const greenGitHubCi = { check_runs: [{ name: "ci", conclusion: "success" }] };
const sampleDiff = [
  "diff --git a/foo.ts b/foo.ts",
  "--- a/foo.ts",
  "+++ b/foo.ts",
  "@@ -1,3 +1,3 @@",
  " export function foo(x: number) {",
  "-  return x;",
  "+  return x + 1;",
  " }",
].join("\n");

const githubRef = parseReviewReference("https://github.com/example-org/example-repo/pull/42");
const githubPlan = planFetch(githubRef);

function makeRunCommand(diff = sampleDiff) {
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

/**
 * The exact LLM output that reproduces Maya's PR #11 scenario:
 *   4 MEDIUM-confidence bugs (different severities) + 1 MEDIUM-confidence test issue.
 *   2 are MEDIUM severity (appear in blockingItems today),
 *   3 are LOW severity (counted in Potential table today but NOT shown in section).
 */
const pr11LlmOutput = [
  // Bug 1 — MEDIUM severity, confidence 5 → potentialBugs + blockingItems today
  "FINDING:",
  "- severity: MEDIUM",
  "- confidence: 5",
  "- area: Bugs",
  "- issue: rAF race condition when component unmounts",
  "- evidence: requestAnimationFrame(cb)",
  "- fix: cancel pending rAF on cleanup",
  "",
  // Bug 2 — LOW severity, confidence 6 → potentialBugs, NOT in blockingItems today
  "FINDING:",
  "- severity: LOW",
  "- confidence: 6",
  "- area: Bugs",
  "- issue: missing null guard on optional prop",
  "- evidence: props.value.length",
  "- fix: use optional chaining",
  "",
  // Bug 3 — LOW severity, confidence 5 → potentialBugs, NOT in blockingItems today
  "FINDING:",
  "- severity: LOW",
  "- confidence: 5",
  "- area: Bugs",
  "- issue: off-by-one in loop boundary",
  "- evidence: i <= arr.length",
  "- fix: use i < arr.length",
  "",
  // Bug 4 — LOW severity, confidence 4 → potentialBugs, NOT in blockingItems today
  "FINDING:",
  "- severity: LOW",
  "- confidence: 4",
  "- area: Bugs",
  "- issue: implicit coercion in equality check",
  "- evidence: count == '0'",
  "- fix: use strict equality",
  "",
  // Test issue — MEDIUM severity, confidence 5 → potentialTests + blockingItems today
  "FINDING:",
  "- severity: MEDIUM",
  "- confidence: 5",
  "- area: Tests",
  "- issue: string-only test assertion, does not check types",
  "- evidence: expect(result).toBe('42')",
  "- fix: assert typeof result === 'number'",
].join("\n");

// ──────────────────────────────────────────────────────────────────────────────
// Test group 1 — Bug 1: section header must NOT say "BLOCKING" when blocking=false
// ──────────────────────────────────────────────────────────────────────────────

describe("section header blocking label", () => {
  it("does NOT contain the word BLOCKING in the section header when blocking=false", async () => {
    const { report } = await fetchReviewSummary(
      githubRef,
      githubPlan,
      ".claude/commands/review-mr.md",
      {
        blocking: false,
        runCommand: makeRunCommand(),
        noComment: true,
        claudeRunner: async () => pr11LlmOutput,
      },
    );

    // The section header (###-level) must not say "BLOCKING ISSUES"
    // when the review is non-blocking. A reader should NOT see contradicting
    // "BLOCKING ISSUES" + "blocking=false" in the same report.
    const sectionHeaders = report.match(/^###.+/gm) ?? [];
    const blockingHeaders = sectionHeaders.filter((h) => h.toUpperCase().includes("BLOCKING"));
    expect(blockingHeaders).toHaveLength(0);
  });

  it("DOES use the word BLOCKING in the section header when blocking=true", async () => {
    const { report } = await fetchReviewSummary(
      githubRef,
      githubPlan,
      ".claude/commands/review-mr.md",
      {
        blocking: true,
        runCommand: makeRunCommand(),
        noComment: true,
        claudeRunner: async () => pr11LlmOutput,
      },
    );

    // When blocking=true, the header can legitimately say "BLOCKING ISSUES"
    const sectionHeaders = report.match(/^###.+/gm) ?? [];
    const blockingHeaders = sectionHeaders.filter((h) => h.toUpperCase().includes("BLOCKING"));
    expect(blockingHeaders.length).toBeGreaterThanOrEqual(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Test group 2 — Bug 2: displayed count must equal rendered issue blocks
// ──────────────────────────────────────────────────────────────────────────────

describe("section header count vs rendered blocks", () => {
  it("count in section header equals number of issue blocks actually printed (blocking=false)", async () => {
    const { report } = await fetchReviewSummary(
      githubRef,
      githubPlan,
      ".claude/commands/review-mr.md",
      {
        blocking: false,
        runCommand: makeRunCommand(),
        noComment: true,
        claudeRunner: async () => pr11LlmOutput,
      },
    );

    // Extract the count from the issues section header (whatever it's called)
    // Pattern: ### <ANYTHING> (N)
    const headerMatch = report.match(/^### .+ \((\d+)\)/m);
    expect(headerMatch).not.toBeNull();
    const declaredCount = parseInt(headerMatch![1], 10);

    // Count bold severity labels rendered in the issues section (before ---)
    // Each rendered finding starts with **SEVERITY**
    const issuesSectionMatch = report.match(/^### .+ \(\d+\)([\s\S]*?)^---/m);
    expect(issuesSectionMatch).not.toBeNull();
    const sectionBody = issuesSectionMatch![1];
    const renderedItems = (sectionBody.match(/^\*\*(CRITICAL|HIGH|MEDIUM|LOW|INFO)\*\*/gm) ?? []).length;

    // The declared count must equal what was actually rendered
    expect(declaredCount).toBe(renderedItems);
  });

  it("count in section header equals number of issue blocks actually printed (blocking=true)", async () => {
    const { report } = await fetchReviewSummary(
      githubRef,
      githubPlan,
      ".claude/commands/review-mr.md",
      {
        blocking: true,
        runCommand: makeRunCommand(),
        noComment: true,
        claudeRunner: async () => pr11LlmOutput,
      },
    );

    const headerMatch = report.match(/^### .+ \((\d+)\)/m);
    expect(headerMatch).not.toBeNull();
    const declaredCount = parseInt(headerMatch![1], 10);

    const issuesSectionMatch = report.match(/^### .+ \(\d+\)([\s\S]*?)^---/m);
    expect(issuesSectionMatch).not.toBeNull();
    const sectionBody = issuesSectionMatch![1];
    const renderedItems = (sectionBody.match(/^\*\*(CRITICAL|HIGH|MEDIUM|LOW|INFO)\*\*/gm) ?? []).length;

    expect(declaredCount).toBe(renderedItems);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Test group 3 — Summary table totals match parsed findings
// ──────────────────────────────────────────────────────────────────────────────

describe("summary table totals match parsed findings", () => {
  it("Potential total in Summary equals count of medium-confidence items in LLM output", async () => {
    const { report } = await fetchReviewSummary(
      githubRef,
      githubPlan,
      ".claude/commands/review-mr.md",
      {
        blocking: false,
        runCommand: makeRunCommand(),
        noComment: true,
        claudeRunner: async () => pr11LlmOutput,
      },
    );

    // pr11LlmOutput has 4 medium-confidence bugs + 1 medium-confidence test = 5 Potential
    // Extract Bugs Potential and Tests Potential from the Summary table
    const bugsRow = report.match(/\| Bugs \| (\d+) \| (\d+) \|/);
    const testsRow = report.match(/\| Tests \| (\d+) \| (\d+) \|/);
    expect(bugsRow).not.toBeNull();
    expect(testsRow).not.toBeNull();

    const bugsPotential = parseInt(bugsRow![2], 10);
    const testsPotential = parseInt(testsRow![2], 10);

    // 4 medium-confidence bugs should be in Potential
    expect(bugsPotential).toBe(4);
    // 1 medium-confidence test issue should be in Potential
    expect(testsPotential).toBe(1);
  });

  it("section header count + (Findings=0 rows) = total issues displayed (no phantom issues)", async () => {
    const { report } = await fetchReviewSummary(
      githubRef,
      githubPlan,
      ".claude/commands/review-mr.md",
      {
        blocking: false,
        runCommand: makeRunCommand(),
        noComment: true,
        claudeRunner: async () => pr11LlmOutput,
      },
    );

    // The section header count must equal the sum of Findings + Potential across all rows
    // (since all pr11 items have confidence 4-7, Findings should be 0 for each area)
    const headerMatch = report.match(/^### .+ \((\d+)\)/m);
    expect(headerMatch).not.toBeNull();
    const headerCount = parseInt(headerMatch![1], 10);

    // Sum all Potential counts from the Summary table
    const potentialMatches = [...report.matchAll(/\| \w+ \| \d+ \| (\d+) \| \d+ \|/g)];
    const totalPotential = potentialMatches.reduce((sum, m) => sum + parseInt(m[1], 10), 0);

    // Sum all Findings counts from the Summary table
    const findingsMatches = [...report.matchAll(/\| \w+ \| (\d+) \| \d+ \| \d+ \|/g)];
    const totalFindings = findingsMatches.reduce((sum, m) => sum + parseInt(m[1], 10), 0);

    // The section must account for all reported issues
    expect(headerCount).toBe(totalFindings + totalPotential);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Test group 4 — parseLlmFindings: LOW severity items with confidence >= 4
//                are counted in Potential but CURRENTLY not in blockingItems
//                (this is the root of the discrepancy — fix must surface them)
// ──────────────────────────────────────────────────────────────────────────────

describe("parseLlmFindings surfaces all confidence>=4 items for display", () => {
  it("LOW severity items with confidence 4-7 appear in allItems (not just potentialBugs)", () => {
    const output = [
      "FINDING:",
      "- severity: LOW",
      "- confidence: 6",
      "- area: Bugs",
      "- issue: low severity but real",
      "- evidence: some code",
      "- fix: fix it",
    ].join("\n");

    const result = parseLlmFindings(output);

    // Already counted in table
    expect(result.potentialBugs).toBe(1);

    // Must also appear in allItems so the section can render it
    // (allItems is the new field; blockingItems only has MEDIUM+ severity)
    expect(result.allItems).toBeDefined();
    expect(result.allItems.length).toBe(1);
    expect(result.allItems[0]).toContain("low severity but real");
  });

  it("allItems includes both MEDIUM and LOW severity items (full confidence>=4 set)", () => {
    const output = pr11LlmOutput;
    const result = parseLlmFindings(output);

    // pr11 has 5 items total with confidence 4-7
    expect(result.allItems).toBeDefined();
    expect(result.allItems.length).toBe(5);
  });

  it("blockingItems still only includes CRITICAL/HIGH/MEDIUM severity (backward compat)", () => {
    const output = pr11LlmOutput;
    const result = parseLlmFindings(output);

    // Only 2 of the 5 items are MEDIUM severity → 2 blockingItems
    expect(result.blockingItems.length).toBe(2);
  });
});
