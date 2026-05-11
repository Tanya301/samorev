import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fetchReviewSummary, FetchError } from "../src/fetchReport";
import { parseReviewReference, planFetch } from "../src/providerPlanning";

const repoRoot = import.meta.dir.replace(/\/tests$/, "");
const fakeBin = join(repoRoot, ".tmp-bun-test-bin");
const originalPath = process.env.PATH ?? "";

async function runSamorev(args: string[]) {
  return Bun.spawn({
    cmd: ["bun", "run", "samorev", ...args],
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${originalPath}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function output(proc: ReturnType<typeof Bun.spawn>) {
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

beforeEach(async () => {
  await rm(fakeBin, { recursive: true, force: true });
  await mkdir(fakeBin, { recursive: true });
});

afterEach(async () => {
  await rm(fakeBin, { recursive: true, force: true });
});

describe("bun samorev CLI", () => {
  it("fetches GitHub provider data and renders a no-comment summary", async () => {
    await writeFile(
      join(fakeBin, "gh"),
      `#!/usr/bin/env bun
const args = Bun.argv.slice(2);
if (args.slice(0, 3).join(" ") === "pr view 17") {
  console.log(JSON.stringify({ title: "Demo PR", state: "OPEN", isDraft: false }));
} else if (args.slice(0, 3).join(" ") === "pr diff 17") {
  Bun.write(Bun.stdout, "diff --git a/app.ts b/app.ts\\n+console.log('demo')\\n-old = true\\n");
} else if (args.slice(0, 2).join(" ") === "api repos/example-org/example-repo/issues/17/comments") {
  console.log(JSON.stringify([{ body: "first" }, { body: "second" }]));
} else if (args.slice(0, 2).join(" ") === "api repos/example-org/example-repo/pulls/17/commits") {
  console.log(JSON.stringify([{ sha: "abc" }, { sha: "def" }, { sha: "ghi" }]));
} else if (args.slice(0, 2).join(" ") === "api repos/example-org/example-repo/commits/pull/17/head/check-runs") {
  console.log(JSON.stringify({ total_count: 2, check_runs: [{ name: "unit", conclusion: "success" }, { name: "lint", conclusion: "failure" }] }));
} else {
  console.error("unexpected gh args: " + JSON.stringify(args));
  process.exit(42);
}
`,
      { mode: 0o755 },
    );

    const result = await output(
      await runSamorev([
        "review",
        "https://github.com/example-org/example-repo/pull/17",
        "--no-comment",
        "--fetch",
      ]),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("Error:");
    expect(result.stdout).toContain("samorev fetch summary");
    expect(result.stdout).toContain("provider=github");
    expect(result.stdout).toContain("kind=pr");
    expect(result.stdout).toContain("project=example-org/example-repo");
    expect(result.stdout).toContain("title=Demo PR");
    expect(result.stdout).toContain("state=OPEN");
    expect(result.stdout).toContain("draft=false");
    expect(result.stdout).toContain("diff_lines=3");
    expect(result.stdout).toContain("diff_added=1");
    expect(result.stdout).toContain("diff_removed=1");
    expect(result.stdout).toContain("comments_count=2");
    expect(result.stdout).toContain("commits_count=3");
    expect(result.stdout).toContain("ci_status=failure");
    expect(result.stdout).toContain("ci_summary=total=2 success=1 failure=1 pending=0 other=0");
    expect(result.stdout).toContain("no_comment=true");
    expect(result.stdout).toContain("live_posting=not-run");
  });

  it("renders GitLab public API fallback summary fields", async () => {
    const reference = parseReviewReference("https://gitlab.com/example-group/example-project/-/merge_requests/42");
    const plan = planFetch(reference);

    const summary = await fetchReviewSummary(reference, plan, ".claude/commands/review-mr.md", {
      blocking: true,
      runCommand: async () => {
        throw new FetchError("glab unavailable");
      },
      httpJson: async (url: string) => {
        if (url.endsWith("/merge_requests/42")) {
          return {
            title: "GitLab fallback demo",
            state: "opened",
            draft: false,
            head_pipeline: { status: "failed" },
          };
        }
        if (url.endsWith("/merge_requests/42/notes?per_page=100")) {
          return [{ body: "first" }, { body: "second" }];
        }
        if (url.endsWith("/merge_requests/42/commits")) {
          return [{ id: "abc" }, { id: "def" }, { id: "ghi" }];
        }
        if (url.endsWith("/merge_requests/42/diffs")) {
          return [
            {
              old_path: "app.ts",
              new_path: "app.ts",
              diff: "@@ -1 +1 @@\n-old = true\n+new = true\n",
            },
          ];
        }
        throw new Error(`unexpected GitLab API URL: ${url}`);
      },
    });

    expect(summary).toContain("provider=gitlab");
    expect(summary).toContain("kind=mr");
    expect(summary).toContain("project=example-group/example-project");
    expect(summary).toContain("number=42");
    expect(summary).toContain("title=GitLab fallback demo");
    expect(summary).toContain("state=opened");
    expect(summary).toContain("draft=false");
    expect(summary).toContain("diff_lines=4");
    expect(summary).toContain("diff_added=1");
    expect(summary).toContain("diff_removed=1");
    expect(summary).toContain("comments_count=2");
    expect(summary).toContain("commits_count=3");
    expect(summary).toContain("ci_status=failed");
    expect(summary).toContain("ci_summary=pipeline_status=failed");
    expect(summary).toContain("blocking=true");
    expect(summary).toContain("no_comment=true");
    expect(summary).toContain("live_posting=not-run");
  });

  it("keeps GitLab public fallback usable when notes are private", async () => {
    const reference = parseReviewReference("https://gitlab.com/example-group/example-project/-/merge_requests/42");
    const plan = planFetch(reference);

    const summary = await fetchReviewSummary(reference, plan, ".claude/commands/review-mr.md", {
      blocking: false,
      runCommand: async () => {
        throw new FetchError("glab unavailable");
      },
      httpJson: async (url: string) => {
        if (url.endsWith("/merge_requests/42")) {
          return { title: "Public MR", state: "merged", draft: false, head_pipeline: { status: "success" } };
        }
        if (url.endsWith("/merge_requests/42/notes?per_page=100")) {
          throw new FetchError("notes are private");
        }
        if (url.endsWith("/merge_requests/42/commits")) {
          return [{ id: "abc" }];
        }
        if (url.endsWith("/merge_requests/42/diffs")) {
          return [{ old_path: "README.md", new_path: "README.md", diff: "+demo\n" }];
        }
        throw new Error(`unexpected GitLab API URL: ${url}`);
      },
    });

    expect(summary).toContain("provider=gitlab");
    expect(summary).toContain("title=Public MR");
    expect(summary).toContain("comments_count=0");
    expect(summary).toContain("commits_count=1");
    expect(summary).toContain("ci_status=success");
    expect(summary).toContain("no_comment=true");
    expect(summary).toContain("live_posting=not-run");
  });

  it("plans numeric GitHub references from remote URL", () => {
    const reference = parseReviewReference("17", "git@github.com:example-org/example-repo.git");
    const plan = planFetch(reference);

    expect(reference.provider).toBe("github");
    expect(reference.kind).toBe("pr");
    expect(reference.projectPath).toBe("example-org/example-repo");
    expect(plan.metadataCommand.join(" ")).toContain("gh pr view 17 --repo example-org/example-repo");
    expect(plan.ciCommand.join(" ")).toContain("repos/example-org/example-repo/commits/pull/17/head/check-runs");
  });

  it("rejects invalid references without a traceback", async () => {
    const result = await output(await runSamorev(["review", "not-a-review", "--no-comment", "--fetch"]));

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Invalid review reference");
    expect(result.stderr).not.toContain("error:");
    expect(result.stderr).not.toContain("Traceback");
  });
});
