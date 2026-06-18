# samorev bot-operation runbook

This document is the authoritative reference for running `samorev` from an
**autonomous bot** (e.g. openclaw) using **only this repository**. Every command
and flag below is verified against `src/cli.ts` and the Python helpers in `lib/`.

> Companion docs: [`../README.md`](../README.md) (overview), [`../SPEC.md`](../SPEC.md)
> (CLI contract), [`./verdict-parsing.md`](./verdict-parsing.md) (machine-readable output).

---

## 1. What samorev is, and what a review actually checks

samorev has **two distinct review surfaces**. A bot must know which one it is
invoking, because they check different things.

### Surface A — the Bun CLI (`samorev review`) — DETERMINISTIC GATE

This is the surface a bot runs. It is **not** an LLM. Source: `src/cli.ts`,
`src/fetchReport.ts`, `src/providerPlanning.ts`, `src/providerPosting.ts`.

With `--fetch` it does exactly this, with no model calls:

1. Parse the PR/MR reference (`src/providerPlanning.ts`).
2. Fetch provider data via `gh`/`glab` (or the GitLab public REST API):
   metadata, diff, comments, commits, CI status.
3. Compute a **review-gate** in `reviewGateFindings()` (`src/fetchReport.ts`):
   - **CI/Pipeline finding** if the CI status is not `success` or `none`
     (`pending` → HIGH, anything else non-success → CRITICAL).
   - **Metadata finding** if the target is a **draft** (HIGH).
4. Render a Markdown report whose outcome is **PASS** (zero gate findings) or
   **FAIL** (one or more gate findings).
5. Post that report to the PR/MR via `gh`/`glab`, unless `--no-comment` is set.

> The CLI gate is **only** CI-status + draft-state. It does **not** run the
> security/bugs/tests/guidelines/docs analysis itself. The `Security`, `Bugs`,
> `Tests`, `Guidelines`, `Docs` rows in the rendered summary table are always
> `0` from the CLI — they are populated only by Surface B.

### Surface B — the Claude Code slash command (`/review-mr`) — AI AGENTS

Source: `.claude/commands/review-mr.md` + `agents/*.md`. This runs inside an
interactive Claude Code session (not a plain CLI) and launches 5–6 parallel
LLM agents:

| Agent | Model | Focus | Blocking |
|-------|-------|-------|----------|
| Security Reviewer | Opus | OWASP, secrets, injection | Yes |
| Bug Hunter | Opus | Runtime/logic bugs | Yes |
| Test Analyzer | Sonnet | Coverage, test quality | Configurable |
| Guidelines Checker | Sonnet | Conventions / project rules | No |
| Docs Reviewer | Sonnet | Docs, comments | No |
| Sqitch Migration Checker | Opus | PostgreSQL Sqitch migrations | Yes (optional) |

It also does CI/pipeline checks, MR-metadata quality, linked-issue compliance,
prompt-injection sanitization, prior-review memory, and optional SOC2 compliance.

**A bot operating from the repo alone uses Surface A.** Surface B requires a
Claude Code session and is documented here for completeness only.

---

## 2. Install & runtime (Bun)

Runtime: **Bun** (tested with 1.3.x). No Node runtime is required for the CLI.

```bash
git clone https://github.com/Tanya301/samorev.git
cd samorev
bun install
bun run build        # tsc --noEmit + bundle to dist/cli.js
bun test             # 11 tests, no network/auth needed
```

Two equivalent ways to invoke the CLI:

```bash
bun run samorev review ...     # runs src/cli.ts directly (dev path)
bun dist/cli.js review ...     # runs the built bin (after `bun run build`)
```

`package.json` declares `bin.samorev = ./dist/cli.js`, so `bun run build` must be
run before the `dist/cli.js` form works.

External tools used by the CLI (must be on `PATH`):

| Tool | Needed for |
|------|-----------|
| `bun` | running the CLI |
| `gh` (GitHub CLI) | all GitHub PR fetch/post |
| `glab` (GitLab CLI) | authenticated GitLab MR fetch/post |
| — | GitLab **public** MRs work with no `glab` via the public REST API fallback |

`gh`/`glab` are invoked as subprocesses; the CLI never imports a provider SDK.

---

## 3. Credential / setup checklist

The CLI authenticates **entirely through the `gh` and `glab` CLIs' own token
stores** — it does not read provider tokens from environment variables itself.

| What | How the bot sets it | Required for |
|------|--------------------|--------------|
| GitHub auth | `gh auth login` (or `GH_TOKEN` env that `gh` itself honors) | Any GitHub PR fetch; posting comments |
| GitHub token scopes | `repo` (read PR/diff/checks + post comments). `read:org` if reviewing org-private repos. `workflow` only if inspecting Actions run logs. | GitHub reviews |
| GitLab auth | `glab auth login` (or a `glab`-configured token) | Authenticated GitLab MR fetch; posting comments |
| GitLab token scopes | `api` (read MR + post notes) — or `read_api` if the bot only fetches with `--no-comment` | GitLab reviews |
| GitLab public MRs | nothing — public REST API fallback runs when `glab` is missing or its token is bad | Read-only public GitLab MR fetch |

**Verify auth before a posting run** (the CLI runs `gh auth status` / `glab auth
status` internally before posting and exits non-zero with `live_posting=blocked`
if it fails):

```bash
gh auth status
glab auth status
```

### Slash-command-only credentials (Surface B)

Only relevant if the bot drives `/review-mr` inside Claude Code:

| Env var | Used by | Purpose |
|---------|---------|---------|
| `GITLAB_TOKEN` | `lib/review_memory.py` | Fetch prior-review context for GitLab MRs (sent as `PRIVATE-TOKEN`). |
| `GITLAB_HOST` | `lib/review_memory.py` | Override GitLab host (default `gitlab.com`). |
| `REPO_ROOT` / `REV_ROOT` | `.claude/commands/review-mr.md` | Path hints to locate `lib/` helpers. |

### NOT needed to operate samorev

- `ANTHROPIC_API_KEY` — used **only** by the optional agent-quality test suite
  (`pytest -m api`). It is never read by the CLI or by a review run.
- `OPENAI_API_KEY` — not used anywhere in samorev.

> Never write tokens into committed files, agent briefs, or posted comments. Use
> the CLI auth stores and env-var names only.

---

## 4. Command surface (copy-paste)

```
samorev review <reference> [--remote-url <url>] [--no-comment] [--blocking] [--fetch] [--smoke]
```

`review` is the **only** subcommand. Any other first arg prints usage and exits 2.

### Reference forms (verified in `src/providerPlanning.ts`)

| Form | Example |
|------|---------|
| GitHub PR URL | `https://github.com/<owner>/<repo>/pull/<n>` |
| GitLab MR URL | `https://gitlab.com/<group>/<project>/-/merge_requests/<n>` |
| Numeric (needs `--remote-url`) | `123 --remote-url git@github.com:owner/repo.git` |

A bare number without `--remote-url` exits 2 (`Numeric reference requires a git
remote URL`). GitHub remotes resolve to PRs; GitLab remotes resolve to MRs.

### Flags (verified in `parseReviewArgs`, `src/cli.ts`)

| Flag | Effect |
|------|--------|
| `--fetch` | Execute provider fetches, render the PASS/FAIL gate report. Posts it unless `--no-comment`. |
| `--no-comment` | Print report to stdout only; never post to the provider. |
| `--blocking` | Recorded in output as `blocking=true`. **Does not change the CLI exit code** (the CLI does not exit non-zero on gate FAIL today; see gotchas). |
| `--smoke` | Print the provider plan (commands it *would* run) + wiring. No network. |
| `--remote-url <url>` | Resolve a numeric reference to a project. |

### Mode matrix (what each combination does — verified by running the CLI)

| Invocation | Behaviour | Exit |
|-----------|-----------|------|
| `review <ref> --smoke --no-comment` | Print plan only, no network | 0 |
| `review <ref> --no-comment` (no `--fetch`) | Print "handoff" (the planned commands + prompt path) | 0 |
| `review <ref> --no-comment --fetch` | Fetch + render report to stdout, no posting | 0 (1 on fetch error) |
| `review <ref> --fetch` | Fetch + render + **post** via `gh`/`glab` | 0 (1 if auth/posting fails) |
| `review <ref>` (no `--fetch`, no `--no-comment`) | Error: live posting from CLI not enabled; use a flag | 2 |

### Bot recipes

Read-only gate, parse stdout (recommended default for a bot):

```bash
bun run samorev review https://github.com/OWNER/REPO/pull/123 --no-comment --fetch
bun run samorev review https://gitlab.com/GROUP/PROJECT/-/merge_requests/123 --no-comment --fetch
```

Numeric reference from inside a checkout:

```bash
bun run samorev review 123 \
  --remote-url "$(git remote get-url origin)" \
  --no-comment --fetch
```

Gate + post the comment to the PR/MR (requires `gh`/`glab` auth):

```bash
bun run samorev review https://github.com/OWNER/REPO/pull/123 --fetch
```

Dry-run the plan without any network (CI wiring smoke):

```bash
bun run samorev review https://github.com/OWNER/REPO/pull/123 --no-comment --blocking --smoke
```

### Exit codes (verified)

| Code | Meaning |
|------|---------|
| `0` | Successful smoke / handoff / fetch-report / posted comment |
| `1` | Provider fetch failed, required prompt file missing, or posting/auth failed |
| `2` | Invalid arguments or invalid/missing reference |

> A FAIL **verdict** (CI failing / draft) still exits `0` on a successful
> `--fetch`. A bot must parse the report body (Section 5) to get the verdict —
> the process exit code reflects whether the *fetch ran*, not the verdict.

---

## 5. Verdict output a bot parses

Full grammar and parsing recipes are in [`./verdict-parsing.md`](./verdict-parsing.md).
Quick reference — every `--fetch` report ends with a fenced metadata block:

```text
provider=github
kind=pr
project=OWNER/REPO
number=123
target=github:OWNER/REPO#123
state=OPEN
draft=false
diff_lines=72
ci_status=success
ci_summary=total=13 success=13 failure=0 pending=0 other=0
posted_by=local
no_comment=true
live_posting=not-run
```

Verdict logic for a bot:

- **PASS** ⇔ the body contains `**Result: PASSED**` (and no `### BLOCKING
  ISSUES` header).
- **FAIL** ⇔ the body contains a `### BLOCKING ISSUES (N)` header with N ≥ 1.
- `live_posting` is `not-run` (with `--no-comment`), `posted` (comment posted),
  or `blocked` (posting requested but provider auth failed → exit 1).

---

## 6. Gotchas & troubleshooting

- **`--blocking` does not affect exit code.** As of the current CLI it only sets
  `blocking=true` in the output. To gate CI on a FAIL, parse the report body, not
  `$?`. (`SPEC.md §4` states exit-on-findings is deferred.)
- **PASS/FAIL is CI + draft only.** The CLI does not run the AI agents, so a
  clean diff with a green pipeline returns PASS even if it contains bugs. Use the
  `/review-mr` slash command (Surface B) for actual code analysis.
- **GitLab public-fallback CI is approximate.** The gate reads
  `head_pipeline.status`; the public REST API metadata often lacks it, so the CLI
  falls back to the MR `state` (e.g. `merged`, `opened`) as the "CI status".
  That can render a spurious CI finding (e.g. `Pipeline status is merged`) on
  public MRs fetched without `glab` auth. Authenticate `glab` for accurate CI.
- **Expired `glab` token silently falls back to public API.** `glab auth status`
  showing an expired token does **not** fail a public-MR fetch; it quietly uses
  the unauthenticated public REST API (and cannot fetch private MRs or post).
- **`gh` returns exit 1 for a nonexistent PR number** → CLI prints
  `Error: Command failed (1) for gh pr view ...` and exits 1. Verify the number.
- **`Error: review prompt not found`** → run from the repo root (or a full
  checkout); the CLI resolves `.claude/commands/review-mr.md` relative to the
  package, and exits 1 if it is missing.
- **Posting blocked** → output ends with `live_posting=blocked` and exit is 1;
  run `gh auth status` / `glab auth status` and re-auth.
- **Invalid JSON from provider** → `Error: <tool> returned invalid JSON ...`
  (exit 1); usually a `gh`/`glab` auth or rate-limit problem.

---

## 7. What runs where

| Component | Where it runs | Needs |
|-----------|---------------|-------|
| `samorev review` (Bun CLI) | Anywhere with Bun + `gh`/`glab` on PATH | provider CLI auth (or public GitLab) |
| `gh` / `glab` subprocesses | Same host as the CLI | their own auth |
| GitLab public REST API fallback | Outbound HTTPS to `gitlab.com/api/v4` | network only (public MRs) |
| `/review-mr` slash command | Inside a Claude Code session | Claude Code + `gh`/`glab` + `python3`/`jq`; `GITLAB_TOKEN` for GitLab memory |
| LLM review agents (Surface B) | Inside the Claude Code session | Claude Code's model access |
| `pytest -m api` quality tests | CI / dev box | `ANTHROPIC_API_KEY` (tests only) |
| `pytest -m "not api"` + `bun test` | CI / dev box | nothing external |

For a bot: run the **Bun CLI** on any host with `bun`, `gh`, and `glab`
authenticated. Nothing else is required to fetch a PR/MR and produce a gate
verdict.
