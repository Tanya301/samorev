import { describe, expect, it } from "bun:test";
import { fetchReviewSummary, SAMOREV_REVIEW_MARKER } from "../src/fetchReport";
import { parseReviewReference, planFetch } from "../src/providerPlanning";

const metadata = { title: "Round cap test", state: "OPEN", isDraft: false };
const ci = { check_runs: [{ name: "ci", conclusion: "success" }] };
const diff = [
  "diff --git a/value.ts b/value.ts",
  "--- a/value.ts",
  "+++ b/value.ts",
  "@@ -1 +1 @@",
  "-export const value = 1;",
  "+export const value = 2;",
].join("\n");

const reference = parseReviewReference("https://github.com/example-org/example-repo/pull/42");
const plan = planFetch(reference);

function makeRunCommand(comments: unknown[]) {
  return async (command: string[]): Promise<string> => {
    const joined = command.join(" ");
    if (joined.includes("pr view")) return JSON.stringify(metadata);
    if (joined.includes("pr diff")) return diff;
    if (joined.includes("issues") && joined.includes("comments")) return JSON.stringify(comments);
    if (joined.includes("pulls") && joined.includes("commits")) return "[]";
    if (joined.includes("check-runs")) return JSON.stringify(ci);
    throw new Error(`unexpected command: ${joined}`);
  };
}

function priorSamorevComments(count: number): Array<{ body: string }> {
  return Array.from({ length: count }, (_value, index) => ({
    body: `Prior review ${index + 1}\n\n${SAMOREV_REVIEW_MARKER}`,
  }));
}

describe("review round cap", () => {
  it("starts at round 1 and invokes the reviewer when no samorev comments exist", async () => {
    let reviewCalls = 0;
    const result = await fetchReviewSummary(reference, plan, ".claude/commands/review-mr.md", {
      blocking: true,
      runCommand: makeRunCommand([]),
      claudeRunner: async () => {
        reviewCalls += 1;
        return "NO_FINDINGS";
      },
    });

    expect(reviewCalls).toBe(1);
    expect(result.outcome).toBe("PASS");
    expect(result.report).toContain(SAMOREV_REVIEW_MARKER);
    expect(result.report).toContain("review_round=1/10");
    expect(result.report).toContain("escalated=false");
  });

  it("counts three prior marked comments and proceeds as round 4", async () => {
    let reviewCalls = 0;
    const result = await fetchReviewSummary(reference, plan, ".claude/commands/review-mr.md", {
      blocking: true,
      runCommand: makeRunCommand(priorSamorevComments(3)),
      claudeRunner: async () => {
        reviewCalls += 1;
        return "NO_FINDINGS";
      },
    });

    expect(reviewCalls).toBe(1);
    expect(result.outcome).toBe("PASS");
    expect(result.report).toContain("review_round=4/10");
    expect(result.report).toContain("escalated=false");
  });

  it("escalates round 11 before review or defense and returns blocking FAIL", async () => {
    let reviewCalls = 0;
    let defendCalls = 0;
    const result = await fetchReviewSummary(reference, plan, ".claude/commands/review-mr.md", {
      blocking: true,
      runCommand: makeRunCommand(priorSamorevComments(10)),
      claudeRunner: async () => {
        reviewCalls += 1;
        return "NO_FINDINGS";
      },
      defendRunner: async () => {
        defendCalls += 1;
        return "VERDICT: UPHOLD\nREASON: still applies";
      },
    });

    expect(reviewCalls).toBe(0);
    expect(defendCalls).toBe(0);
    expect(result.outcome).toBe("FAIL");
    expect(result.report).toContain(
      "Reached the 10-round review limit without converging — escalating to a human. Automated re-review stopped.",
    );
    expect(result.report).toContain("review_round=11/10");
    expect(result.report).toContain("escalated=true");
  });

  it("does not count unmarked user comments as review rounds", async () => {
    let reviewCalls = 0;
    const comments = [
      { body: "Please add a regression test." },
      { body: "Looks good to me." },
      { body: "samorev is useful, but this is an ordinary user comment." },
    ];
    const result = await fetchReviewSummary(reference, plan, ".claude/commands/review-mr.md", {
      blocking: true,
      runCommand: makeRunCommand(comments),
      claudeRunner: async () => {
        reviewCalls += 1;
        return "NO_FINDINGS";
      },
    });

    expect(reviewCalls).toBe(1);
    expect(result.report).toContain("review_round=1/10");
  });
});

describe("main review timeout", () => {
  it("fails closed promptly with a clear timeout finding", async () => {
    const startedAt = performance.now();
    const result = await fetchReviewSummary(reference, plan, ".claude/commands/review-mr.md", {
      blocking: true,
      runCommand: makeRunCommand([]),
      noDefend: true,
      claudeTimeoutMs: 10,
      claudeRunner: async () => new Promise<string>(() => {}),
    });
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(500);
    expect(result.outcome).toBe("FAIL");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].issue.toLowerCase()).toContain("timed out");
    expect(result.report.toLowerCase()).toContain("timed out");
  });
});
