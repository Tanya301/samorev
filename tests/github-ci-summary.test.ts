import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { formatCiBadge, reviewGateFindings, summarizeGitHubCi, summarizeGitLabCi, TRANSIENT_CI_STATUSES } from "../src/fetchReport";
import { parseGitHubSelfCheckEnv } from "../src/cli";

const publisher = { id: 303, name: "base-controlled samorev publisher" };
const trusted = { runIds: ["303"], name: publisher.name, appId: "15368" };
const parityCases = JSON.parse(readFileSync(new URL("./fixtures/github-ci-parity.json", import.meta.url), "utf8")) as Array<{
  name: string;
  payload: unknown;
  self_check?: { run_ids?: string[]; name?: string; app_id?: string };
  status: string;
  excluded_self: number;
}>;

describe("GitHub CI self-check exclusion", () => {
  test("matches the shared shell/TypeScript fixture table", () => {
    for (const fixture of parityCases) {
      const selfCheck = fixture.self_check ? parseGitHubSelfCheckEnv({
        SAMOREV_IGNORED_GITHUB_CHECK_RUN_IDS: fixture.self_check.run_ids?.join(","),
        SAMOREV_IGNORED_GITHUB_CHECK_NAME: fixture.self_check.name,
        SAMOREV_IGNORED_GITHUB_CHECK_APP_ID: fixture.self_check.app_id,
      }, () => {}) : undefined;
      const summary = summarizeGitHubCi(fixture.payload, selfCheck);
      expect(summary.status, fixture.name).toBe(fixture.status);
      expect(summary.excludedSelf, fixture.name).toBe(fixture.excluded_self);
    }
  });

  test("excludes only the exact configured publisher and discloses it", () => {
    expect(summarizeGitHubCi({ check_runs: [
      { name: "typecheck", conclusion: "success" },
      { ...publisher, app: { id: 15368 }, status: "in_progress", conclusion: null },
    ] }, trusted)).toEqual({
      status: "success",
      summary: "total=1 success=1 failure=0 pending=0 other=0 excluded_self=1",
      excludedSelf: 1,
    });
  });

  test("fails closed when no independent CI remains", () => {
    expect(summarizeGitHubCi({ check_runs: [
      { ...publisher, app: { id: 15368 }, status: "in_progress", conclusion: null },
    ] }, trusted).status).toBe("self-only");
    expect(reviewGateFindings("self-only", false)).toEqual([
      expect.objectContaining({ severity: "HIGH", title: "Pipeline status is self-only" }),
    ]);
    expect(formatCiBadge("self-only")).toBe("FAIL");
  });

  test("does not hide an unrelated completed failure", () => {
    expect(summarizeGitHubCi({ check_runs: [
      { name: "samorev-lint", conclusion: "failure", status: "completed" },
      { ...publisher, app: { id: 15368 }, status: "in_progress", conclusion: null },
    ] }, trusted)).toEqual({
      status: "failure",
      summary: "total=1 success=0 failure=1 pending=0 other=0 excluded_self=1",
      excludedSelf: 1,
    });
  });

  test("keeps a pending exact-name/app check blocking when its id is not trusted", () => {
    expect(summarizeGitHubCi({ check_runs: [
      { ...publisher, id: 999, app: { id: 15368 }, status: "in_progress", conclusion: null },
    ] }, trusted)).toEqual({
      status: "pending",
      summary: "total=1 success=0 failure=0 pending=1 other=0",
      excludedSelf: 0,
    });
  });

  test("does not exclude a completed publisher failure or exclude implicitly", () => {
    expect(summarizeGitHubCi({ check_runs: [
      { ...publisher, app: { id: 15368 }, status: "completed", conclusion: "failure" },
    ] }, trusted).status).toBe("failure");
    expect(summarizeGitHubCi({ check_runs: [
      { ...publisher, status: "in_progress", conclusion: null },
    ] }).status).toBe("pending");
  });

  test("requires the configured publisher name and app as defense in depth", () => {
    const pending = { ...publisher, app: { id: 999 }, status: "in_progress", conclusion: null };
    expect(summarizeGitHubCi({ check_runs: [pending] }, trusted).status).toBe("pending");
    expect(summarizeGitHubCi({ check_runs: [{ ...pending, app: { id: 15368 }, name: "other" }] }, trusted).status).toBe("pending");
  });

  test("parses multiple IDs and warns on malformed or partial configuration", () => {
    const warnings: string[] = [];
    expect(parseGitHubSelfCheckEnv({
      SAMOREV_IGNORED_GITHUB_CHECK_RUN_IDS: "101, abc, 303",
      SAMOREV_IGNORED_GITHUB_CHECK_NAME: publisher.name,
      SAMOREV_IGNORED_GITHUB_CHECK_APP_ID: "15368",
    }, (message) => warnings.push(message))).toEqual({ runIds: ["101", "303"], name: publisher.name, appId: "15368" });
    expect(warnings).toEqual(["Ignoring non-numeric GitHub self-check run IDs"]);
    expect(parseGitHubSelfCheckEnv({ SAMOREV_IGNORED_GITHUB_CHECK_RUN_IDS: "303" }, (message) => warnings.push(message))).toEqual({
      runIds: ["303"], name: "", appId: "", invalid: true,
    });
    expect(warnings.at(-1)).toContain("incomplete or invalid GitHub self-check");
  });

  test("supports multiple trusted pending publisher runs", () => {
    const multi = { ...trusted, runIds: ["303", "404"] };
    expect(summarizeGitHubCi({ check_runs: [
      { ...publisher, app: { id: 15368 }, status: "in_progress", conclusion: null },
      { ...publisher, id: 404, app: { id: 15368 }, status: "queued", conclusion: null },
      { id: 505, name: "typecheck", status: "completed", conclusion: "success" },
    ] }, multi)).toEqual({
      status: "success",
      summary: "total=1 success=1 failure=0 pending=0 other=0 excluded_self=2",
      excludedSelf: 2,
    });
  });

  test("fails closed on an unusable CI payload but permits an explicit empty list", () => {
    expect(summarizeGitHubCi({ message: "Not Found" }).status).toBe("unknown");
    expect(summarizeGitHubCi([{ check_runs: [] }, { message: "partial failure" }]).status).toBe("unknown");
    expect(summarizeGitHubCi({ check_runs: [] }).status).toBe("none");
    expect(reviewGateFindings("none", false)).toEqual([
      expect.objectContaining({ severity: "HIGH", title: "Pipeline status is none" }),
    ]);
    expect(formatCiBadge("none")).toBe("FAIL");
    expect(formatCiBadge("canceled")).toBe("FAIL");
    expect(formatCiBadge("skipped")).toBe("FAIL");
    expect(formatCiBadge("manual")).toBe("FAIL");
  });

  test("treats skipped and neutral checks as successful and stale as failed", () => {
    expect(summarizeGitHubCi({ check_runs: [
      { name: "unit", status: "completed", conclusion: "success" },
      { name: "docs", status: "completed", conclusion: "skipped" },
      { name: "optional", status: "completed", conclusion: "neutral" },
    ] }).status).toBe("success");
    expect(summarizeGitHubCi({ check_runs: [
      { name: "old", status: "completed", conclusion: "stale" },
    ] }).status).toBe("failure");
  });

  test("merges all slurped GitHub check-run pages before evaluating CI", () => {
    expect(summarizeGitHubCi([
      { check_runs: [{ id: 101, name: "unit", status: "completed", conclusion: "success" }] },
      { check_runs: [{ id: 202, name: "lint", status: "completed", conclusion: "failure" }] },
    ])).toEqual({
      status: "failure",
      summary: "total=2 success=1 failure=1 pending=0 other=0",
      excludedSelf: 0,
    });
  });
});

describe("GitLab CI normalization", () => {
  test("keeps every transient status HIGH with a PENDING badge", () => {
    for (const status of TRANSIENT_CI_STATUSES) {
      expect(reviewGateFindings(status, false)[0]?.severity, status).toBe("HIGH");
      expect(formatCiBadge(status), status).toBe("PENDING");
    }
  });

  test("uses the legacy pipeline object when head_pipeline is absent", () => {
    expect(summarizeGitLabCi({ pipeline: { status: "success" } })).toEqual({
      status: "success",
      summary: "pipeline_status=success",
    });
    expect(summarizeGitLabCi({ state: "merged" })).toEqual({
      status: "none",
      summary: "pipeline_status=none",
    });
  });
});
