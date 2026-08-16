#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchReviewSummary, FetchError, type GitHubSelfCheck } from "./fetchReport";
import { assertProviderAuth, postProviderSummary, PostingError, postingTool } from "./providerPosting";
import { parseReviewReference, planFetch, ReviewReferenceError } from "./providerPlanning";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const promptPath = join(repoRoot, ".claude", "commands", "review-mr.md");

type ReviewArgs = {
  reference?: string;
  remoteUrl?: string;
  noComment: boolean;
  blocking: boolean;
  smoke: boolean;
  fetch: boolean;
};

export async function main(argv = Bun.argv.slice(2)): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== "review") {
    printUsage();
    return 2;
  }
  try {
    return await review(parseReviewArgs(rest));
  } catch (error) {
    if (error instanceof ReviewReferenceError) {
      console.error(`Error: ${error.message}`);
      return 2;
    }
    throw error;
  }
}

async function review(args: ReviewArgs): Promise<number> {
  if (!args.reference) {
    console.error("Error: missing PR/MR URL or number");
    return 2;
  }

  let reference;
  let plan;
  try {
    reference = parseReviewReference(args.reference, args.remoteUrl);
    plan = planFetch(reference);
  } catch (error) {
    if (error instanceof ReviewReferenceError) {
      console.error(`Error: ${error.message}`);
      return 2;
    }
    throw error;
  }

  if (!existsSync(promptPath)) {
    console.error(`Error: review prompt not found at ${promptPath}`);
    return 1;
  }

  if (args.smoke) {
    console.log(formatSmoke(reference, plan, args.noComment, args.blocking));
    return 0;
  }

  if (args.fetch) {
    const githubSelfCheck = parseGitHubSelfCheckEnv(process.env);
    if (githubSelfCheck && reference.provider !== "github") {
      console.error("GitHub self-check exclusion is ignored for GitLab reviews");
    }
    try {
      if (args.noComment) {
        const { report, outcome } = await fetchReviewSummary(reference, plan, relative(repoRoot, promptPath), {
          blocking: args.blocking,
          noComment: true,
          postedBy: "local",
          livePosting: "not-run",
          githubSelfCheck,
        });
        console.log(report);
        return args.blocking && outcome === "FAIL" ? 1 : 0;
      }

      const tool = postingTool(reference);
      try {
        await assertProviderAuth(reference);
      } catch (error) {
        if (error instanceof PostingError) {
          let blockedReport: string;
          try {
            ({ report: blockedReport } = await fetchReviewSummary(reference, plan, relative(repoRoot, promptPath), {
              blocking: args.blocking,
              noComment: false,
              postedBy: tool,
              livePosting: "blocked",
              githubSelfCheck,
            }));
          } catch (reportError) {
            console.error(error.message);
            throw reportError;
          }
          console.log(blockedReport);
          console.error(error.message);
          return 1;
        }
        throw error;
      }

      const { report: postedReport, outcome: postedOutcome } = await fetchReviewSummary(reference, plan, relative(repoRoot, promptPath), {
        blocking: args.blocking,
        noComment: false,
        postedBy: tool,
        livePosting: "posted",
        githubSelfCheck,
      });
      try {
        await postProviderSummary(reference, plan, postedReport);
        console.log(postedReport);
      } catch (error) {
        if (error instanceof PostingError) {
          try {
            console.log(markPostingBlocked(postedReport));
          } catch (metadataError) {
            console.error(`Error: ${metadataError instanceof Error ? metadataError.message : String(metadataError)}`);
          }
        }
        throw error;
      }
      return args.blocking && postedOutcome === "FAIL" ? 1 : 0;
    } catch (error) {
      if (error instanceof FetchError) {
        console.error(`Error: ${error.message}`);
        return 1;
      }
      if (error instanceof PostingError) {
        console.error(error.message);
        return 1;
      }
      throw error;
    }
  }

  if (args.noComment) {
    console.log(formatHandoff(reference, plan, args.blocking));
    return 0;
  }

  console.error("Error: live posting from the CLI is not enabled yet. Use --no-comment, --fetch, or --smoke.");
  return 2;
}

export function markPostingBlocked(report: string): string {
  const blockStart = report.lastIndexOf("\n```text\n");
  const blockEnd = blockStart < 0 ? -1 : report.indexOf("\n```", blockStart + 9);
  if (blockStart < 0 || blockEnd < 0) throw new Error("posting metadata block is missing; refusing to print a stale posting state");
  const metadata = report.slice(blockStart, blockEnd);
  if (!/^live_posting=posted$/m.test(metadata)) throw new Error("live_posting=posted metadata is missing; refusing to print a stale posting state");
  const blockedMetadata = metadata.replace(/^live_posting=posted$/m, "live_posting=blocked");
  return `${report.slice(0, blockStart)}${blockedMetadata}${report.slice(blockEnd)}`;
}

export function parseGitHubSelfCheckEnv(
  env: Record<string, string | undefined>,
  warn: (message: string) => void = console.error,
): GitHubSelfCheck | undefined {
  const rawIds = (env.SAMOREV_IGNORED_GITHUB_CHECK_RUN_IDS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  const runIds = rawIds.filter((value) => /^\d+$/.test(value));
  const name = (env.SAMOREV_IGNORED_GITHUB_CHECK_NAME ?? "").trim();
  const appId = (env.SAMOREV_IGNORED_GITHUB_CHECK_APP_ID ?? "").trim();
  const configured = rawIds.length > 0 || Boolean(name) || Boolean(appId);
  if (!configured) return undefined;
  if (runIds.length !== rawIds.length) warn("Ignoring non-numeric GitHub self-check run IDs");
  if (!name || !/^\d+$/.test(appId)) {
    warn("Warning: incomplete or invalid GitHub self-check exclusion configuration; run IDs, exact name, and numeric app ID are all required; excluding nothing");
    return { runIds, name, appId, invalid: true };
  }
  if (runIds.length === 0) warn("Warning: no valid GitHub self-check run IDs; excluding no runs while retaining publisher identity");
  return { runIds, name, appId };
}

function parseReviewArgs(argv: string[]): ReviewArgs {
  const args: ReviewArgs = {
    noComment: false,
    blocking: false,
    smoke: false,
    fetch: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--no-comment") {
      args.noComment = true;
    } else if (arg === "--blocking") {
      args.blocking = true;
    } else if (arg === "--smoke") {
      args.smoke = true;
    } else if (arg === "--fetch") {
      args.fetch = true;
    } else if (arg === "--remote-url") {
      args.remoteUrl = argv[++index];
      if (!args.remoteUrl) {
        throw new ReviewReferenceError("--remote-url requires a value");
      }
    } else if (arg.startsWith("-")) {
      throw new ReviewReferenceError(`unknown option ${arg}`);
    } else if (!args.reference) {
      args.reference = arg;
    } else {
      throw new ReviewReferenceError(`unexpected extra argument ${arg}`);
    }
  }
  return args;
}

function formatSmoke(reference: ReturnType<typeof parseReviewReference>, plan: ReturnType<typeof planFetch>, noComment: boolean, blocking: boolean): string {
  return [
    "samorev review smoke",
    `provider=${reference.provider}`,
    `kind=${reference.kind}`,
    `project=${reference.projectPath}`,
    `number=${reference.number}`,
    `metadata_command=${plan.metadataCommand.join(" ")}`,
    `diff_command=${plan.diffCommand.join(" ")}`,
    `comments_command=${plan.commentsCommand.join(" ")}`,
    `commits_command=${plan.commitsCommand.join(" ")}`,
    `ci_command=${plan.ciCommand.join(" ")}`,
    `post_comment_command=${plan.postCommentCommand.join(" ")}`,
    `prompt=${relative(repoRoot, promptPath)}`,
    `no_comment=${String(noComment)}`,
    `blocking=${String(blocking)}`,
    "live_posting=not-run",
  ].join("\n");
}

function formatHandoff(reference: ReturnType<typeof parseReviewReference>, plan: ReturnType<typeof planFetch>, blocking: boolean): string {
  return [
    "samorev CLI review handoff",
    `Review: ${reference.provider} ${reference.kind} ${reference.projectPath}#${reference.number}`,
    `Prompt: ${promptPath}`,
    `Metadata: ${plan.metadataCommand.join(" ")}`,
    `Diff: ${plan.diffCommand.join(" ")}`,
    `Comments: ${plan.commentsCommand.join(" ")}`,
    `Commits: ${plan.commitsCommand.join(" ")}`,
    `CI: ${plan.ciCommand.join(" ")}`,
    `Blocking mode: ${String(blocking)}`,
    "No provider comment will be posted because --no-comment was set.",
    "Use the existing review prompt content as the review procedure; this CLI only performs provider planning and handoff.",
  ].join("\n");
}

function printUsage(): void {
  console.error("Usage: samorev review <PR-or-MR> [--remote-url <url>] [--no-comment] [--blocking] [--fetch] [--smoke]");
}

if (import.meta.main) {
  const code = await main();
  process.exit(code);
}
