#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchReviewSummary, FetchError } from "./fetchReport";
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
    try {
      if (args.noComment) {
        console.log(
          await fetchReviewSummary(reference, plan, relative(repoRoot, promptPath), {
            blocking: args.blocking,
            noComment: true,
            postedBy: "local",
            livePosting: "not-run",
          }),
        );
        return 0;
      }

      const tool = postingTool(reference);
      const blockedSummary = await fetchReviewSummary(reference, plan, relative(repoRoot, promptPath), {
        blocking: args.blocking,
        noComment: false,
        postedBy: tool,
        livePosting: "blocked",
      });

      try {
        await assertProviderAuth(reference);
      } catch (error) {
        if (error instanceof PostingError) {
          console.log(blockedSummary);
          console.error(error.message);
          return 1;
        }
        throw error;
      }

      const postedSummary = await fetchReviewSummary(reference, plan, relative(repoRoot, promptPath), {
        blocking: args.blocking,
        noComment: false,
        postedBy: tool,
        livePosting: "posted",
      });
      await postProviderSummary(reference, plan, postedSummary);
      console.log(postedSummary);
      return 0;
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
