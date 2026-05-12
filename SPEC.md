# samorev - Product Spec

- **Version:** v0.2 draft
- **Status:** implementation-ready for early CLI demos
- **Scope:** CLI-first review runner, TypeScript on Bun, GitHub PRs and GitLab MRs
- **Related quality work:** NikolayS/samospec#165, "Keep generated specs detailed but concise"

## 1. Goal

Make `samorev` a Bun/TypeScript CLI that LLM agents can run from a checkout to fetch PR/MR context, render a compact PASS/FAIL review-gate report, post that report provider-native when requested, and preserve the existing REV-like Claude Code prompt/agent workflow.

## 2. Non-Goals

- Do not replace the review agents with a new autonomous review engine.
- Do not require hosted services, databases, or non-git state.
- Do not make Python the primary CLI surface for new users.

## 2.1 Repository Layout Convention

`samorev` follows the shared Samo repository layout:

- `samo/` contains visible, reviewable project knowledge such as review policy, tool descriptions, sprint notes, and optional rule files.
- `.samo/` contains machine config, cache, runtime state, and generated local artifacts.

Repository-specific review behavior should be readable from `samo/review-policy.md` or `samo/rules/*.mdc`, with `.samo/config.yaml` carrying pointers and tool settings. Legacy `.rev.yml` and `rules/rules/*.mdc` inputs remain compatibility paths during migration.

## 3. Primary Workflows

### Checkout Demo

```bash
bun install
bun test
bun run build
bun run samorev review <PR-or-MR> --no-comment --fetch
```

Expected result: a terminal review-gate comment containing PASS or FAIL, findings or `No blocking findings.`, provider, kind, project, number, target, title, state, draft status, diff size, comment count, commit count, CI status, prompt path, `posted_by`, `no_comment=true`, and `live_posting=not-run`.

### LLM Agent Review Prep

```bash
bun run samorev review https://github.com/OWNER/REPO/pull/123 --no-comment --fetch
bun run samorev review https://gitlab.com/GROUP/PROJECT/-/merge_requests/123 --no-comment --fetch
```

The CLI fetches provider context. The LLM uses `.claude/commands/review-mr.md` and `agents/*.md` for the review procedure and specialist personas.

### Claude Code Slash Command

`/review-mr <PR-or-MR> [--no-comment] [--blocking]` remains available. It must continue to parse provider references safely and use the same provider concepts as the Bun CLI. Delegating more of this path to the Bun CLI is allowed if behavior stays compatible.

## 4. CLI Contract

Command:

```bash
bun run samorev review <reference> [--remote-url <url>] [--no-comment] [--blocking] [--fetch] [--smoke]
```

Inputs:

- GitHub PR URL: `https://github.com/<owner>/<repo>/pull/<number>`
- GitLab MR URL: `https://gitlab.com/<group>/<project>/-/merge_requests/<number>`
- Numeric reference: requires `--remote-url`; GitHub remotes produce PRs, GitLab remotes produce MRs.

Modes:

- `--fetch`: execute provider metadata, diff, comments, commits, and CI fetches; renders a PASS/FAIL review-gate comment and posts it provider-native unless `--no-comment` is set.
- `--smoke`: render provider plan and prompt wiring; no provider network fetch.
- `--blocking`: report blocking-mode intent in output; exit semantics for actual findings are deferred until agent execution is wired into the CLI.
- no `--fetch` and `--no-comment`: print handoff instructions.

Exit behavior:

- `0`: successful smoke, handoff, fetch report, or provider-native summary post.
- `1`: provider fetch failed or required prompt missing.
- `1`: posting requested but provider auth/posting failed; output includes `live_posting=blocked` for auth blockers.
- `2`: invalid arguments or invalid reference.

## 5. Provider Behavior

### GitHub

Provider command source: `gh`.

Fetches:

- Metadata: `gh pr view <number> --repo <owner>/<repo> --json ...`
- Diff: `gh pr diff <number> --repo <owner>/<repo>`
- Comments: `gh api repos/<owner>/<repo>/issues/<number>/comments --paginate`
- Commits: `gh api repos/<owner>/<repo>/pulls/<number>/commits --paginate`
- CI: `gh api repos/<owner>/<repo>/commits/pull/<number>/head/check-runs --paginate`
- Posting: `gh pr comment <number> --repo <owner>/<repo> --body <summary>`

CI summary buckets: `success`, `failure`, `pending`, `other`.

### GitLab

Primary provider command source: `glab`.

Fallback: GitLab public REST API for public MRs when `glab` is missing or unusable.

Fetches:

- Metadata: merge request JSON.
- Diff: MR diff text or rendered public API diff entries.
- Comments: notes; inaccessible notes become `comments_count=0` only in public fallback.
- Commits: MR commits.
- CI: `head_pipeline.status` when present; otherwise provider state fallback.
- Posting: `glab mr comment <number> --repo <group>/<project> -m <summary>`

## 6. Architecture

```text
CLI args
  -> src/cli.ts
      -> src/providerPlanning.ts
          parses reference, validates provider, creates fetch plan
      -> src/fetchReport.ts
          executes provider fetches, normalizes counts/status, renders summary
      -> src/providerPosting.ts
          verifies provider auth, posts rendered summary through gh/glab
      -> .claude/commands/review-mr.md
          remains the review orchestration prompt
      -> agents/*.md
          specialist review personas
```

Boundaries:

- Provider CLIs and public APIs are external systems.
- `src/providerPlanning.ts` owns input validation and command construction.
- `src/fetchReport.ts` owns data fetching and report normalization.
- `src/providerPosting.ts` owns provider auth checks and native comment posting.
- `.claude/commands/review-mr.md` owns agent orchestration semantics.

## 7. Evidence Standards

Every PR changing CLI behavior must include inline evidence, not only links:

- RED test command and failing reason.
- GREEN test commands and pass counts.
- `bun install`, `bun test`, and `bun run build` output summary.
- At least one no-comment GitHub fetch report or a clear reason it was not possible.
- GitLab fetch coverage through `glab` or documented public API fallback.
- Explicit statement whether live provider comments were posted, blocked, or skipped via `--no-comment`.

## 8. Acceptance Criteria

- `package.json`, `tsconfig.json`, and `src/` exist.
- `bun install` works from checkout.
- `bun test` passes.
- `bun run build` typechecks and writes the installable bin target.
- `bun run samorev review <PR-or-MR> --no-comment --fetch` works from checkout.
- Built bin path works after build.
- GitHub PR fetch/report behavior is covered by automated tests.
- GitLab MR fetch/report fallback behavior is covered by automated tests.
- GitHub and GitLab provider-native posting behavior is covered by automated tests.
- Posted provider-native bodies are PASS/FAIL review-gate comments, not raw fetch summaries.
- Missing provider auth exits non-zero with a clear blocker and `live_posting=blocked`.
- `--no-comment` fetch/report behavior never invokes provider posting.
- Existing Python compatibility tests for slash-command packaging continue to pass until that path is fully delegated.
- Obsolete Python package wrapper paths are absent; retained Python compatibility helpers are excluded from GitHub language stats through checked Linguist attributes.
- README documents Bun as the primary CLI workflow.

## 9. Open Follow-Ups

- Delegate `/review-mr` provider planning directly to the Bun CLI after installed-path behavior is proven.
- Add release provenance for the Bun package before the first public tag.
