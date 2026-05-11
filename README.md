# samorev - automated code review

samorev is a Claude Code prompt/command pack for reviewing GitHub Pull Requests and GitLab Merge Requests. The `/review-mr` slash command uses a shared provider-planning core for GitHub `gh` and GitLab `glab` fetch/comment operations; the first release proves installed command discovery and provider planning, not live posting.

## Features

- **Automatic self-update**: Checks for updates before each review (supports standalone checkout and project-local installations)
- **Parallel multi-agent review**: 5 specialized agents analyze code simultaneously, with optional repository-specific agents
- **Provider scope**: Plans GitHub PR operations via `gh` and GitLab MR operations via `glab`
- **Optional rules integration**: Loads optional project-specific rules when a repository provides them
- **Confidence scoring**: Rates each finding 0-10, filtering out likely false positives
- **Three-tier findings**: Categorizes into blocking, non-blocking, and potential issues
- **Sqitch migration validation**: Optionally ensures PostgreSQL schema changes have proper migrations

## Agents

| Agent | Model | Focus | Blocking | Scope |
|-------|-------|-------|----------|-------|
| Security Reviewer | Opus | OWASP, secrets, injection | Yes | All repos |
| Bug Hunter | Opus | Runtime bugs, logic errors | Yes | All repos |
| Test Analyzer | Sonnet | Coverage, test quality | Configurable | All repos |
| Guidelines Checker | Sonnet | Project conventions, rules | No | All repos |
| Docs Reviewer | Sonnet | Documentation, comments | No | All repos |
| Sqitch Migration Checker | Opus | PostgreSQL migrations (Sqitch) | Yes | Optional |

## Installation

### Prerequisites

1. **Python 3.11+**
2. **Claude Code** (latest stable version recommended) installed and configured for slash-command review use
3. **GitHub CLI** authenticated when reviewing GitHub PRs:
   ```bash
   gh auth login
   ```
4. **GitLab CLI** authenticated when reviewing GitLab MRs:
   ```bash
   glab auth login
   ```

### Claude Code slash-command installation

Install samorev globally so `/review-mr` works from any directory:

```bash
# Clone to Claude Code's config directory
git clone https://github.com/Tanya301/samorev.git ~/.claude/samorev

# Install the slash command
cd ~/.claude/samorev
bash scripts/install-claude-command.sh
```

To update:
```bash
cd ~/.claude/samorev && git pull
```

### Project-local Installation

If you prefer to install samorev as part of a specific project:

```bash
# Clone the repo
git clone https://github.com/Tanya301/samorev.git
```

The `/review-mr` command will be available when running Claude Code from within the samorev directory or any project that includes samorev as a submodule.

## Usage

```bash
# Review a GitLab MR by URL through Claude Code
/review-mr https://gitlab.com/example-org/example-repo/-/merge_requests/123

# Plan/review a GitHub PR by URL through Claude Code
/review-mr https://github.com/example-org/example-repo/pull/123

# Review by number (uses current repo context)
/review-mr 123

# Review without posting comment (output to terminal only)
/review-mr 123 --no-comment

# Exit with code 1 if blocking issues found (for CI integration)
/review-mr 123 --blocking
```

**Flags:**
- `--no-comment` - Output review to terminal only, don't post to MR
- `--blocking` - Exit with code 1 if BLOCKING issues (CRITICAL/HIGH/MEDIUM) are found

### Provider planning smoke

The slash command delegates provider detection and command planning to `lib/provider_planning.py`. You can verify that wiring from a clean checkout without running a full AI review:

```bash
python lib/provider_planning.py https://github.com/example-org/example-repo/pull/123 --shell
python lib/provider_planning.py https://gitlab.com/example-org/example-repo/-/merge_requests/123 --shell
```

### Standalone CLI

Standalone CLI packaging is not part of the first prompt-pack release. Track it separately if a binary becomes useful beyond slash-command install and provider-planning smoke checks.

## Configuration

### Claude Code permissions (`.claude/settings.json`)

The repository includes a `.claude/settings.json` file that configures safe default permissions for Claude Code:

- **Allowed**: Git, gh, glab, common dev tools (node, python, go, docker, psql, sqitch), file operations, web fetch
- **Denied**: Destructive commands (rm, sudo), network tools that bypass logging (curl, wget), access to secrets (.env*, secrets/**)

### Per-repository config (`.rev.yml`) - planned feature

> **Note:** Configuration file support is a planned feature and not yet implemented. See the project roadmap for updates.

```yaml
# Example configuration (planned)
version: "1"
review:
  blocking:
    # CRITICAL, HIGH, and MEDIUM severity issues block merge
    security: [critical, high, medium]
    bugs: [critical, high, medium]
    coverage_threshold: 80
  non_blocking:
    # LOW and INFO severity issues are suggestions
    style: true
    docs: true
languages:
  - typescript
  - python
  - sql
ignore:
  - "*.generated.ts"
  - "migrations/*.sql"
```

## Architecture

```
/review-mr invoked
        │
        ▼
┌───────────────────┐
│  Self-Update      │
│  (git pull)       │
└───────────────────┘
        │
        ▼
┌───────────────────┐
│  Pre-flight Check │
│  (skip draft/closed)
└───────────────────┘
        │
        ▼
┌───────────────────┐
│  Gather Context   │
│  • Fetch diff     │
│  • Get CLAUDE.md  │
│  • Load rules     │
└───────────────────┘
        │
        ▼
┌───────────────────────────────────────────────────┐
│           PARALLEL AGENT EXECUTION                │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌──────────┐│
│  │Security │ │  Bugs   │ │  Tests  │ │Guidelines││
│  │ (Opus)  │ │ (Opus)  │ │(Sonnet) │ │ (Sonnet) ││
│  └─────────┘ └─────────┘ └─────────┘ └──────────┘│
│  ┌─────────┐          ┌─────────────────────────┐ │
│  │  Docs   │          │ Sqitch (optional)       │ │
│  │(Sonnet) │          │        (Opus)           │ │
│  └─────────┘          └─────────────────────────┘ │
└───────────────────────────────────────────────────┘
        │
        ▼
┌───────────────────┐
│  Consolidate &    │
│  Report Findings  │
└───────────────────┘
```

## Review output

```markdown
## samorev Code Review Report

- **MR:** example-org/example-repo!123 - Add user authentication
- **Author:** @developer
- **AI-Assisted:** No

| Pipeline | Coverage |
|----------|----------|
| [![pipeline](https://gitlab.com/example-org/example-repo/badges/feat/auth/pipeline.svg)](link) | [![coverage](https://gitlab.com/example-org/example-repo/badges/feat/auth/coverage.svg)](link) |

---

### BLOCKING ISSUES (1)

**HIGH** `src/auth/login.ts:45` - SQL Injection
> User input directly concatenated into query
> **Fix:** Use parameterized query with $1 placeholder

---

### NON-BLOCKING (1)

Minor issues and suggestions (high-confidence LOW, INFO severity).

**INFO** `src/auth/login.ts:12` - Missing docstring
> **Suggestion:** Add JSDoc describing parameters and return value

---

### POTENTIAL ISSUES (1)

Issues with moderate confidence (4-7/10). Review manually - may be false positives.

**MEDIUM** `src/auth/utils.ts:28` - Possible race condition *(confidence: 6/10)*
> Multiple async calls without locking
> **Suggestion:** Consider adding mutex or using atomic operations

---

### Summary

| Area | Findings | Potential | Filtered |
|------|----------|-----------|----------|
| CI/Pipeline | 0 | 0 | 0 |
| Security | 1 | 0 | 1 |
| Bugs | 0 | 1 | 0 |
| Tests | 0 | 0 | 0 |
| Guidelines | 0 | 0 | 0 |
| Docs | 1 | 0 | 0 |
| Sqitch Migrations* | 0 | 0 | 0 |
| Metadata | 0 | 0 | 0 |

*Only when the optional Sqitch migration checker is enabled for the reviewed repository

Note:
- **Findings**: High-confidence issues (8-10/10) - blocking or non-blocking per severity
- **Potential**: Medium-confidence issues (4-7/10) - review manually
- **Filtered**: Low-confidence issues (0-3/10) - excluded as likely false positives

---

### SOC2 COMPLIANCE (0)

All SOC2 checks passed.

---
*samorev-assisted review (AI analysis by [Tanya301/samorev](https://github.com/Tanya301/samorev))*
```

## Testing Framework

samorev includes a testing framework to validate agent quality and catch regressions.

### Running Tests

```bash
# Run unit tests (no API calls)
pytest tests/ -m "not api" -v

# Run integration tests (requires ANTHROPIC_API_KEY)
pytest tests/ -m "api" -v --model opus

# Limit fixtures for faster testing
pytest tests/ -m "api" --max-fixtures=3

# Save golden outputs for baseline comparison
pytest tests/ -m "api" --save-golden
```

### Test Structure

```
tests/
├── conftest.py          # Pytest configuration and fixtures
├── test_agents.py       # Unit and integration tests
├── fixtures/            # Test cases per agent
│   ├── security/        # Security agent test cases
│   ├── bugs/            # Bug hunter test cases
│   └── ...
├── golden/              # Baseline outputs for regression testing
└── lib/
    ├── compare.py       # Semantic matching for findings
    ├── metrics.py       # Quality metrics calculation
    └── runner.sh        # Agent invocation script
```

### Creating Test Fixtures

Each fixture is a directory with:
- `diff.patch` - The code diff to analyze
- `expected.json` - Expected findings with semantic matchers
- `metadata.json` (optional) - Additional context

Example `expected.json`:
```json
{
  "must_find": [
    {
      "severity_min": "HIGH",
      "file": "vulnerable.py",
      "line_range": [10, 15],
      "issue_contains": ["SQL", "injection"]
    }
  ],
  "must_not_find": [
    {
      "file": "safe.py",
      "issue_contains": ["false positive"]
    }
  ]
}
```

### Quality Thresholds

Agents are held to minimum quality standards:

| Agent | Min Recall | Max FP Rate |
|-------|------------|-------------|
| Security | 98% | 5% |
| Bugs | 95% | 10% |
| Tests | 85% | 15% |
| Guidelines | 80% | 20% |
| Docs | 80% | 20% |

### CI Pipeline

The CI pipeline runs:
1. **lint** - Markdown and Python linting
2. **test** - Unit tests and integration tests
3. **quality-gate** - Verify metrics meet thresholds

## Development

### Project structure

```
samorev/
├── .claude/
│   ├── commands/
│   │   └── review-mr.md     # Main review command (slash command)
│   └── settings.json        # Claude Code permissions config
├── .gitlab-ci.yml           # CI/CD pipeline configuration
├── agents/
│   ├── security-reviewer.md      # OWASP, secrets, injection
│   ├── bug-hunter.md             # Runtime bugs, logic errors
│   ├── test-analyzer.md          # Coverage, test quality
│   ├── guidelines-checker.md     # Project conventions
│   ├── docs-reviewer.md          # Documentation review
│   └── sqitch-migration-checker.md # Optional Sqitch migrations
├── rules/                    # Optional project-specific and shared rules
├── tests/                    # Testing framework
│   ├── conftest.py          # Pytest configuration
│   ├── test_agents.py       # Agent tests
│   ├── fixtures/            # Test fixtures per agent
│   └── lib/                 # Test utilities
└── README.md
```

### Adding new agents

1. Create agent file in `agents/`
2. Update `.claude/commands/review-mr.md` to include the agent in Step 4
3. For repository-specific agents (like Sqitch Migration Checker):
   - Add conditional logic to only run for specific projects
   - Document the scope in the agent file and README

## Optional project rules

samorev can load optional project-specific rules from the `rules/` directory and include them in the Guidelines Checker agent. Rules can cover:

- Git commit standards (Conventional Commits)
- SQL style guide
- Shell script best practices
- Documentation standards
- Core development principles
- Writing rules (title capitalization, terminology, professional communication)
- Platform neutrality
- Binary units standards

## License

Apache License 2.0

## Release provenance checklist

- Source history: seeded from https://gitlab.com/postgres-ai/rev
- License: Apache License 2.0 in this repository.
- Public package target: Claude Code prompt/command pack with `/review-mr` installed by `scripts/install-claude-command.sh`.
- Before the first tagged release, confirm repository owner approval for this repackaging and re-audit docs for stale install URLs, provider assumptions, and project-specific defaults.

## Links

- **Issue Tracker**: https://github.com/Tanya301/samorev/issues
- **Source history**: seeded from https://gitlab.com/postgres-ai/rev
- **Claude Code**: https://claude.ai/claude-code
