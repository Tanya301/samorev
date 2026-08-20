import { describe, expect, it } from "bun:test";
import { fetchReviewSummary } from "../src/fetchReport";
import { parseReviewReference, planFetch } from "../src/providerPlanning";

const metadata = { title: "Defender test", state: "OPEN", isDraft: false };
const ci = { check_runs: [{ name: "ci", conclusion: "success" }] };
const diff = [
  "diff --git a/math.ts b/math.ts",
  "--- a/math.ts",
  "+++ b/math.ts",
  "@@ -1 +1 @@",
  "-export const answer = 41;",
  "+export const answer = 42; // DEFENDER_DIFF_MARKER",
].join("\n");

const reference = parseReviewReference("https://github.com/example-org/example-repo/pull/42");
const plan = planFetch(reference);

function runCommand(command: string[]): Promise<string> {
  const joined = command.join(" ");
  if (joined.includes("pr view")) return Promise.resolve(JSON.stringify(metadata));
  if (joined.includes("pr diff")) return Promise.resolve(diff);
  if (joined.includes("issues") && joined.includes("comments")) return Promise.resolve("[]");
  if (joined.includes("pulls") && joined.includes("commits")) return Promise.resolve("[]");
  if (joined.includes("check-runs")) return Promise.resolve(JSON.stringify(ci));
  throw new Error(`unexpected command: ${joined}`);
}

const blockingFinding = [
  "FINDING:",
  "- severity: HIGH",
  "- confidence: 9",
  "- area: Bugs",
  "- issue: answer changed unexpectedly",
  "- evidence: export const answer = 42",
  "- fix: restore the previous answer",
  "- file: math.ts",
  "- line: 1",
].join("\n");

function finding(overrides: { severity?: string; area?: string; issue?: string } = {}) {
  return [
    "FINDING:",
    `- severity: ${overrides.severity ?? "HIGH"}`,
    "- confidence: 9",
    `- area: ${overrides.area ?? "Bugs"}`,
    `- issue: ${overrides.issue ?? "answer changed unexpectedly"}`,
    "- evidence: export const answer = 42",
    "- fix: restore the previous answer",
    "- file: math.ts",
    "- line: 1",
  ].join("\n");
}

function review(options: Record<string, unknown> = {}) {
  return fetchReviewSummary(reference, plan, ".claude/commands/review-mr.md", {
    blocking: true,
    runCommand,
    noComment: true,
    claudeRunner: async () => blockingFinding,
    ...options,
  });
}

describe("adversarial finding defender", () => {
  it("drops a contested finding and records the drop in report metadata", async () => {
    const prompts: string[] = [];
    const result = await review({
      defendRunner: async (prompt: string) => {
        prompts.push(prompt);
        return "VERDICT: DROP\nREASON: The new value is the intended behavior.";
      },
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("severity: HIGH");
    expect(prompts[0]).toContain("area: Bugs");
    expect(prompts[0]).toContain("issue: answer changed unexpectedly");
    expect(prompts[0]).toContain("evidence: export const answer = 42");
    expect(prompts[0]).toContain("fix: restore the previous answer");
    expect(prompts[0]).toContain("file:line: math.ts:1");
    expect(prompts[0]).toContain("DEFENDER_DIFF_MARKER");
    expect(prompts[0]).toContain("when in doubt, UPHOLD");

    expect(result.findings).toEqual([]);
    expect(result.report).not.toContain("**HIGH** [bugs] answer changed unexpectedly");
    expect(result.report).toContain("| Bugs | 0 | 0 | 0 |");
    expect(result.report).toContain("defender_dropped=1");
    expect(result.report).toContain("Contested / dropped");
    expect(result.report).toContain("[bugs] answer changed unexpectedly — The new value is the intended behavior.");
  });

  it("keeps a finding when the defender upholds it", async () => {
    const result = await review({
      defendRunner: async () => "VERDICT: UPHOLD\nREASON: The change breaks the documented contract.",
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].issue).toBe("answer changed unexpectedly");
    expect(result.report).toContain("**HIGH** [bugs] answer changed unexpectedly");
    expect(result.report).toContain("defender_dropped=0");
  });

  it("keeps a finding when the defender throws", async () => {
    const result = await review({
      defendRunner: async () => {
        throw new Error("defender unavailable");
      },
    });

    expect(result.findings).toHaveLength(1);
    expect(result.outcome).toBe("FAIL");
    expect(result.report).toContain("defender_dropped=0");
  });

  it("keeps a finding when the defender verdict is unparseable", async () => {
    const result = await review({
      defendRunner: async () => "probably a false positive",
    });

    expect(result.findings).toHaveLength(1);
    expect(result.outcome).toBe("FAIL");
    expect(result.report).toContain("defender_dropped=0");
  });

  it("re-derives a PASS after the defender drops the only blocking finding", async () => {
    const beforeDefense = await review({ noDefend: true });
    const afterDefense = await review({
      defendRunner: async () => "VERDICT: DROP\nREASON: The value change is required by the updated specification.",
    });

    expect(beforeDefense.outcome).toBe("FAIL");
    expect(afterDefense.outcome).toBe("PASS");
    expect(afterDefense.findings).toEqual([]);
    expect(afterDefense.report).toContain("**Result: PASSED**");
  });

  it("keeps a CRITICAL-severity finding when the defender recommends DROP", async () => {
    const prompts: string[] = [];
    const result = await review({
      claudeRunner: async () => finding({ severity: "cRiTiCaL" }),
      defendRunner: async (prompt: string) => {
        prompts.push(prompt);
        return "VERDICT: DROP\nREASON: This looks harmless.";
      },
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe("critical");
    expect(result.outcome).toBe("FAIL");
    expect(result.report).toContain("defender_dropped=0");
    expect(prompts[0]).toContain(
      "Never recommend DROP for a CRITICAL-severity finding or a security finding; those must always be UPHELD.",
    );
  });

  it("keeps a security-area finding when the defender recommends DROP", async () => {
    const result = await review({
      claudeRunner: async () => finding({ area: "sEcUrItY" }),
      defendRunner: async () => "VERDICT: DROP\nREASON: This looks harmless.",
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].area).toBe("security");
    expect(result.outcome).toBe("FAIL");
    expect(result.report).toContain("defender_dropped=0");
  });

  it("limits concurrent defender calls and preserves finding order", async () => {
    const issues = Array.from({ length: 7 }, (_value, index) => `issue ${index + 1}`);
    let invocations = 0;
    let inFlight = 0;
    let peakInFlight = 0;
    const result = await review({
      claudeRunner: async () => issues.map((issue) => finding({ issue })).join("\n"),
      defendConcurrency: 2,
      defendRunner: async () => {
        invocations += 1;
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        await Bun.sleep(5);
        inFlight -= 1;
        return "VERDICT: UPHOLD\nREASON: The finding remains actionable.";
      },
    });

    expect(peakInFlight).toBeLessThanOrEqual(2);
    expect(peakInFlight).toBe(2);
    expect(invocations).toBe(issues.length);
    expect(result.findings.map(({ issue }) => issue)).toEqual(issues);
  });

  it("keeps a finding when an injected defender runner times out", async () => {
    const result = await review({
      claudeTimeoutMs: 10,
      defendRunner: async () => new Promise<string>(() => {}),
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].issue).toBe("answer changed unexpectedly");
    expect(result.outcome).toBe("FAIL");
    expect(result.report).toContain("defender_dropped=0");
  });
});
