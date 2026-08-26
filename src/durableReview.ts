/**
 * Crash-resumable durable review orchestrator using the Absurd SDK.
 *
 * Only active when SAMOREV_DURABLE=1. Default (unset) path is BYTE-FOR-BYTE
 * unchanged — this module is never imported in the default path.
 *
 * Design:
 *   step("review") — wraps the full fetchReviewSummary call (LLM + defender).
 *                    Cached on resume: expensive LLM work is not re-paid.
 *   step("post")   — wraps postProviderSummary. Only runs when noComment=false.
 *                    Skipped on resume if already committed.
 *
 * The claudeRunner injection seam is preserved for tests. Pass it via
 * createDurableApp options so the stub is baked into the task closure at
 * registration time — no serialisation of the function needed.
 */
import { Absurd } from "absurd-sdk";
import type { WorkerOptions } from "absurd-sdk";
import { fetchReviewSummary, type ClaudeRunner, type FetchReviewResult } from "./fetchReport";
import { postProviderSummary } from "./providerPosting";
import { parseReviewReference, planFetch } from "./providerPlanning";

export const QUEUE_NAME = "samorev-poc";

/** Parameters that get serialised into the Absurd task row. */
export type ReviewTaskParams = {
  url: string;
  promptPath: string;
  noComment: boolean;
  blocking: boolean;
};

/** Options for creating the durable app instance. */
export interface DurableAppOptions {
  /**
   * Optional stub claude runner injected for tests.
   * Production code leaves this unset and the real claude subprocess is used.
   */
  claudeRunner?: ClaudeRunner;
  /**
   * Lease duration in seconds for the worker (default: 10).
   * Keep low in tests so a crashed task resumes fast (otherwise ~2 min default).
   */
  claimTimeout?: number;
}

/**
 * Creates an Absurd app with the durable review task registered.
 * Returns both the app and the resolved claimTimeout for worker startup.
 */
export function createDurableApp(
  dsn: string,
  options: DurableAppOptions = {},
): { app: Absurd; claimTimeout: number } {
  const { claudeRunner, claimTimeout = 10 } = options;

  const app = new Absurd({ db: dsn, queueName: QUEUE_NAME });

  app.registerTask(
    { name: "review", defaultMaxAttempts: 3 },
    async (params: ReviewTaskParams, ctx) => {
      const reference = parseReviewReference(params.url);
      const plan = planFetch(reference);

      // ── step 1: expensive LLM review ────────────────────────────────────────
      const reviewResult = await ctx.step("review", async (): Promise<{
        report: string;
        outcome: string;
        findings: unknown[];
      }> => {
        const result: FetchReviewResult = await fetchReviewSummary(
          reference,
          plan,
          params.promptPath,
          {
            blocking: params.blocking,
            noComment: params.noComment,
            livePosting: "not-run",
            ...(claudeRunner ? { claudeRunner } : {}),
          },
        );
        return {
          report: result.report,
          outcome: result.outcome,
          findings: result.findings,
        };
      });

      // ── step 2: post ─────────────────────────────────────────────────────────
      if (!params.noComment) {
        await ctx.step("post", async () => {
          await postProviderSummary(reference, plan, reviewResult.report);
          return { posted: true };
        });
      }

      return reviewResult;
    },
  );

  return { app, claimTimeout };
}

/**
 * Spawns a durable review task and returns the taskID.
 */
export async function spawnDurableReview(
  dsn: string,
  params: ReviewTaskParams,
  options: DurableAppOptions = {},
): Promise<string> {
  const { app } = createDurableApp(dsn, options);
  await app.createQueue(QUEUE_NAME);
  const result = await app.spawn("review", params);
  await app.close();
  return result.taskID;
}

/**
 * Convenience: spawn + run worker until the task completes, then return the result.
 * Used by the CLI when SAMOREV_DURABLE=1 and you want a single-process flow.
 */
export async function runDurableReview(
  dsn: string,
  params: ReviewTaskParams,
  options: DurableAppOptions = {},
): Promise<{ report: string; outcome: string; findings: unknown[] }> {
  const { app, claimTimeout } = createDurableApp(dsn, options);

  await app.createQueue(QUEUE_NAME);
  const { taskID } = await app.spawn("review", params);
  const worker = await app.startWorker({ concurrency: 1, claimTimeout });
  const snapshot = await app.awaitTaskResult(taskID, { timeout: 900 }); // 15 min max

  await worker.close();
  await app.close();

  if (snapshot.state === "completed") {
    const r = snapshot.result as { report: string; outcome: string; findings: unknown[] };
    return r;
  }
  if (snapshot.state === "failed") {
    throw new Error(`Durable review task failed: ${JSON.stringify(snapshot.failure)}`);
  }
  throw new Error(`Durable review task ended in unexpected state: ${snapshot.state}`);
}
