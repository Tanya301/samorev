/**
 * TDD: crash-resumable durable review using Absurd + real Postgres.
 *
 * RED phase: tests written before implementation.
 * GREEN phase: after src/durableReview.ts + cli.ts wiring.
 *
 * Uses REAL local Postgres (samorev_durable_poc DB).
 * Stubs ONLY the LLM subprocess (claudeRunner option).
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Absurd } from "absurd-sdk";
import { createDurableApp, spawnDurableReview, QUEUE_NAME } from "../src/durableReview";

const DSN = "postgresql://testuser@/samorev_durable_poc?host=/var/run/postgresql";

const COUNTER_FILE = join(tmpdir(), "samorev-llm-call-count.txt");

async function getCounter(): Promise<number> {
  try {
    return parseInt(await readFile(COUNTER_FILE, "utf-8"), 10) || 0;
  } catch {
    return 0;
  }
}

async function resetCounter(): Promise<void> {
  await writeFile(COUNTER_FILE, "0", "utf-8");
}

const CANNED_FINDINGS = `FINDING:
- severity: HIGH
- confidence: 9
- area: Bugs
- issue: off-by-one error in loop bounds
- evidence: for (let i = 0; i <= arr.length; i++)
- fix: use i < arr.length
`;

const stubClaudeRunner = async (_prompt: string): Promise<string> => {
  const n = await getCounter();
  await writeFile(COUNTER_FILE, String(n + 1), "utf-8");
  return CANNED_FINDINGS;
};

describe("durable step caching — crash before post (real Postgres, stub LLM)", () => {
  const TEST_QUEUE = "samorev-crash-test";

  beforeAll(async () => {
    await resetCounter();
    const app = new Absurd({ db: DSN, queueName: TEST_QUEUE });
    await app.createQueue(TEST_QUEUE);
    await app.close();
  });

  it("LLM stub is called exactly once even when post crashes (counter=1 after resume)", async () => {
    await resetCounter();

    let postCallCount = 0;

    const app = new Absurd({ db: DSN, queueName: TEST_QUEUE });

    app.registerTask(
      { name: "crash-resume-test", defaultMaxAttempts: 3 },
      async (_params: Record<string, unknown>, ctx) => {
        const reviewResult = await ctx.step("review", async () => {
          const output = await stubClaudeRunner("dummy prompt");
          return { report: output, findings: ["off-by-one"] };
        });

        await ctx.step("post", async () => {
          postCallCount += 1;
          if (postCallCount === 1) {
            throw new Error("Simulated crash: post not yet committed");
          }
          return { posted: true, reportLength: reviewResult.report.length };
        });

        return reviewResult;
      },
    );

    await app.startWorker({ concurrency: 1, claimTimeout: 10 });
    const { taskID } = await app.spawn("crash-resume-test", { run: 1 });
    const snapshot = await app.awaitTaskResult(taskID, { timeout: 60 });

    await app.close();

    expect(snapshot.state).toBe("completed");
    const callCount = await getCounter();
    expect(callCount).toBe(1);
    expect(postCallCount).toBe(2);
  }, 90_000);
});

describe("createDurableApp — API smoke test", () => {
  it("registers and creates queue without throwing", async () => {
    const { app } = createDurableApp(DSN, { claudeRunner: stubClaudeRunner });
    await app.createQueue(QUEUE_NAME);
    await app.close();
    expect(true).toBe(true);
  });
});

describe("flag-off regression — durableReview module does not pollute fetchReport", () => {
  it("fetchReviewSummary is still importable and unchanged", async () => {
    const { fetchReviewSummary } = await import("../src/fetchReport");
    expect(typeof fetchReviewSummary).toBe("function");
  });

  it("SAMOREV_DURABLE env var is not set in this test process", () => {
    expect(process.env.SAMOREV_DURABLE).toBeUndefined();
  });
});
