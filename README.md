# REV - Automated code review for GitLab

REV (Review Engineering Validation) is a Claude Code plugin that automates code review for GitLab Merge Requests using parallel AI agents.

## Features

- **Automatic self-update**: Checks for updates before each review (supports standalone repos and submodule installations)
- **Parallel multi-agent review**: 5 specialized agents analyze code simultaneously (6 for postgres-ai/platform with Sqitch migrations)
- **GitLab native**: Works with GitLab MRs via `glab` CLI
- **PostgresAI rules integration**: Enforces organizational coding standards
- **Confidence scoring**: Rates each finding 0-10, filtering out likely false positives
- **Three-tier findings**: Categorizes into blocking, non-blocking, and potential issues
- **Sqitch migration validation**: Ensures PostgreSQL schema changes have proper migrations (platform repo only)

## Agents

| Agent | Model | Focus | Blocking | Scope |
|-------|-------|-------|----------|-------|
| Security Reviewer | Opus | OWASP, secrets, injection | Yes | All repos |
| Bug Hunter | Opus | Runtime bugs, logic errors | Yes | All repos |
| Test Analyzer | Sonnet | Coverage, test quality | Configurable | All repos |
| Guidelines Checker | Sonnet | Project conventions, rules | No | All repos |
| Docs Reviewer | Sonnet | Documentation, comments | No | All repos |
| Sqitch Migration Checker | Opus | PostgreSQL migrations (Sqitch) | Yes | platform only |

## Installation

### Prerequisites

1. **Claude Code** (latest stable version recommended) installed and configured
2. **glab CLI** (v1.30.0 or later) authenticated with GitLab:
   ```bash
   glab auth login
   ```

### Global Installation (recommended)

Install REV globally so `/review-mr` works from any directory:

```bash
# Clone to Claude Code's config directory
git clone --recurse-submodules https://gitlab.com/postgres-ai/rev.git ~/.claude/rev

# Create symlink for the command
mkdir -p ~/.claude/commands
ln -s ~/.claude/rev/.claude/commands/review-mr.md ~/.claude/commands/review-mr.md
```

To update:
```bash
cd ~/.claude/rev && git pull && git submodule update --init --recursive
```

### Project-local Installation

If you prefer to install REV as part of a specific project:

```bash
# Clone the repo with submodules
git clone --recurse-submodules https://gitlab.com/postgres-ai/rev.git

# Or if already cloned, initialize submodules
git submodule update --init --recursive
```

The `/review-mr` command will be available when running Claude Code from within the REV directory or any project that includes REV as a submodule.

## Usage

```bash
# Review a GitLab MR by URL
/review-mr https://gitlab.com/postgres-ai/platform/-/merge_requests/123

# Review by MR number (uses current repo context)
/review-mr 123

# Review without posting comment (output to terminal only)
/review-mr 123 --no-comment

# Exit with code 1 if blocking issues found (for CI integration)
/review-mr 123 --blocking
```

**Flags:**
- `--no-comment` - Output review to terminal only, don't post to MR
- `--blocking` - Exit with code 1 if BLOCKING issues (CRITICAL/HIGH/MEDIUM) are found

## Configuration

### Claude Code permissions (`.claude/settings.json`)

The repository includes a `.claude/settings.json` file that configures safe default permissions for Claude Code:

- **Allowed**: Git, glab, common dev tools (node, python, go, docker, psql, sqitch), file operations, web fetch
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
│  (git pull/       │
│   submodule update)
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
│  │  Docs   │          │ Sqitch (platform only)  │ │
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
## REV Code Review Report

- **MR:** postgres-ai/platform!123 - Add user authentication
- **Author:** @developer
- **AI-Assisted:** No

| Pipeline | Coverage |
|----------|----------|
| [![pipeline](https://gitlab.com/postgres-ai/platform/badges/feat/auth/pipeline.svg)](link) | [![coverage](https://gitlab.com/postgres-ai/platform/badges/feat/auth/coverage.svg)](link) |

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

*Only for postgres-ai/platform repository

Note:
- **Findings**: High-confidence issues (8-10/10) - blocking or non-blocking per severity
- **Potential**: Medium-confidence issues (4-7/10) - review manually
- **Filtered**: Low-confidence issues (0-3/10) - excluded as likely false positives

---

### SOC2 COMPLIANCE (0)

All SOC2 checks passed.

---
*REV-assisted review (AI analysis by [postgres-ai/rev](https://gitlab.com/postgres-ai/rev))*
```

## Testing Framework

REV includes a testing framework to validate agent quality and catch regressions.

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

The GitLab CI pipeline runs:
1. **lint** - Markdown and Python linting
2. **test** - Unit tests and integration tests
3. **quality-gate** - Verify metrics meet thresholds

## Development

### Project structure

```
rev/
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
│   └── sqitch-migration-checker.md # Sqitch migrations (platform only)
├── rules/                    # Submodule: postgres-ai/rules
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

## Integration with PostgresAI rules

REV automatically fetches rules from https://gitlab.com/postgres-ai/rules and includes them in the Guidelines Checker agent. Rules cover:

- Git commit standards (Conventional Commits)
- SQL style guide
- Shell script best practices
- Documentation standards
- Core development principles
- Writing rules (title capitalization, terminology, professional communication)
- Platform neutrality
- Binary units standards

## License

MIT

## Links

- **Issue Tracker**: https://gitlab.com/postgres-ai/internal/-/issues/183
- **PostgresAI Rules**: https://gitlab.com/postgres-ai/rules
- **Claude Code**: https://claude.ai/claude-code
