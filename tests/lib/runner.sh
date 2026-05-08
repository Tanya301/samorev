#!/bin/bash
# runner.sh - Invoke individual REV agents for testing
#
# Usage:
#   ./runner.sh <agent> <fixture_dir> [--model <model>]
#
# Agents: security, bugs, tests, guidelines, docs
# Models: opus, sonnet, haiku

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Defaults
MODEL="opus"
TIMEOUT=120

usage() {
    echo "Usage: $0 <agent> <fixture_dir> [--model <model>]"
    echo ""
    echo "Agents: security, bugs, tests, guidelines, docs"
    echo "Models: opus, sonnet, haiku"
    exit 1
}

# Parse arguments
if [[ $# -lt 2 ]]; then
    usage
fi

AGENT="$1"
FIXTURE_DIR="$2"
shift 2

while [[ $# -gt 0 ]]; do
    case "$1" in
        --model)
            MODEL="$2"
            shift 2
            ;;
        --timeout)
            TIMEOUT="$2"
            shift 2
            ;;
        *)
            echo "Unknown option: $1"
            usage
            ;;
    esac
done

# Validate agent
case "$AGENT" in
    security|bugs|tests|guidelines|docs)
        ;;
    *)
        echo "Invalid agent: $AGENT"
        usage
        ;;
esac

# Check fixture exists
if [[ ! -d "$FIXTURE_DIR" ]]; then
    echo "Fixture directory not found: $FIXTURE_DIR"
    exit 1
fi

DIFF_FILE="$FIXTURE_DIR/diff.patch"
if [[ ! -f "$DIFF_FILE" ]]; then
    echo "No diff.patch found in $FIXTURE_DIR"
    exit 1
fi

# Load diff content
DIFF_CONTENT=$(cat "$DIFF_FILE")

# Load optional fixture metadata
MR_TITLE="Test MR"
MR_DESCRIPTION="Test description"
LANGUAGES="python"
IS_AI_ASSISTED="false"

if [[ -f "$FIXTURE_DIR/metadata.json" ]]; then
    MR_TITLE=$(jq -r '.mr_title // "Test MR"' "$FIXTURE_DIR/metadata.json")
    MR_DESCRIPTION=$(jq -r '.mr_description // "Test description"' "$FIXTURE_DIR/metadata.json")
    LANGUAGES=$(jq -r '.languages // "python"' "$FIXTURE_DIR/metadata.json")
    IS_AI_ASSISTED=$(jq -r '.ai_assisted // "false"' "$FIXTURE_DIR/metadata.json")
fi

# Build agent prompt based on type
build_prompt() {
    local agent="$1"

    case "$agent" in
        security)
            cat <<'PROMPT'
You are a security expert. Review this GitLab MR diff for security issues.

<diff>
__REV_DIFF_7f3a9b2e__
</diff>

<mr_info>
Title: __REV_TITLE_8c4d1a3f__
Description: __REV_DESC_2b5e9c7d__
Languages: __REV_LANG_6a1f4e8b__
AI-Assisted: __REV_AI_3d9c5a2e__
</mr_info>

Focus on:
- OWASP Top 10 vulnerabilities
- Hardcoded secrets, API keys, credentials
- SQL injection (especially in PostgreSQL code)
- Command injection
- XSS vulnerabilities
- Authentication/authorization flaws
- Unsafe deserialization

For each finding, output in this format:
FINDING:
- severity: CRITICAL | HIGH | MEDIUM | LOW
- confidence: <0-10>
- file: <path>
- line: <number>
- issue: <brief description>
- evidence: <the problematic code>
- fix: <remediation>

Confidence scoring (0-10):
- +3: Concrete evidence in code (not theoretical)
- +2: Violates explicit security best practices (OWASP, CWE)
- +2: Definite vulnerability vs. code smell
- +2: A senior security engineer would flag this
- +1: Newly introduced (not pre-existing)

Only report findings with confidence >= 4.
If no security issues found, output: NO_FINDINGS
PROMPT
            ;;
        bugs)
            cat <<'PROMPT'
You are a bug detection expert. Review this GitLab MR diff for bugs and logic errors.

<diff>
__REV_DIFF_7f3a9b2e__
</diff>

<mr_info>
Title: __REV_TITLE_8c4d1a3f__
Description: __REV_DESC_2b5e9c7d__
Languages: __REV_LANG_6a1f4e8b__
AI-Assisted: __REV_AI_3d9c5a2e__
</mr_info>

Focus on:
- Runtime errors that WILL occur
- Logic errors and incorrect behavior
- Off-by-one errors
- Null/undefined handling bugs
- Race conditions
- Resource leaks
- Edge cases not handled
- Type mismatches

For each finding, output in this format:
FINDING:
- severity: CRITICAL | HIGH | MEDIUM | LOW
- confidence: <0-10>
- file: <path>
- line: <number>
- issue: <brief description>
- evidence: <the problematic code>
- fix: <remediation>

Confidence scoring (0-10):
- +3: Concrete evidence the bug WILL occur (not theoretical)
- +2: Clear logical flaw or runtime error
- +2: Definite bug vs. code smell or style issue
- +2: A senior engineer would flag this as a bug
- +1: Newly introduced (not pre-existing)

Only report findings with confidence >= 4.
If no bugs found, output: NO_FINDINGS
PROMPT
            ;;
        tests)
            cat <<'PROMPT'
You are a test quality expert. Review this GitLab MR diff for test coverage and quality.

<diff>
__REV_DIFF_7f3a9b2e__
</diff>

<mr_info>
Title: __REV_TITLE_8c4d1a3f__
Description: __REV_DESC_2b5e9c7d__
Languages: __REV_LANG_6a1f4e8b__
</mr_info>

Focus on:
- New code without corresponding tests
- Modified logic without test updates
- Test quality issues (weak assertions, testing implementation details)
- Missing edge case tests
- Missing error handling tests

For each finding, output in this format:
FINDING:
- severity: HIGH | MEDIUM | LOW
- confidence: <0-10>
- file: <path>
- line: <number>
- issue: <brief description>
- suggestion: <what tests to add>

Confidence scoring (0-10):
- +3: Clear gap in test coverage for critical functionality
- +2: New code path with no corresponding test
- +2: Definite missing test vs. nice-to-have test
- +2: A senior engineer would require this test
- +1: Newly introduced code (not pre-existing)

Only report findings with confidence >= 4.
If no test issues found, output: NO_FINDINGS
PROMPT
            ;;
        guidelines)
            cat <<'PROMPT'
You are a code style and guidelines expert. Review this GitLab MR diff for convention violations.

<diff>
__REV_DIFF_7f3a9b2e__
</diff>

<project_guidelines>
No CLAUDE.md found
</project_guidelines>

<mr_info>
Title: __REV_TITLE_8c4d1a3f__
Languages: __REV_LANG_6a1f4e8b__
</mr_info>

Focus on:
- Naming convention issues
- Code organization problems
- Documentation gaps
- Style inconsistencies with the codebase

For each finding, output in this format:
FINDING:
- severity: INFO
- confidence: <0-10>
- file: <path>
- line: <number>
- issue: <brief description>
- suggestion: <improvement>

Confidence scoring (0-10):
- +3: Clear violation of explicit documented rule
- +2: Definite violation vs. subjective preference
- +2: Consistent with how the rule is applied elsewhere
- +1: Newly introduced (not pre-existing)

Only report findings with confidence >= 4.
If no guideline issues found, output: NO_FINDINGS
PROMPT
            ;;
        docs)
            cat <<'PROMPT'
You are a documentation expert. Review this GitLab MR diff for documentation quality.

<diff>
__REV_DIFF_7f3a9b2e__
</diff>

<mr_info>
Title: __REV_TITLE_8c4d1a3f__
Description: __REV_DESC_2b5e9c7d__
Languages: __REV_LANG_6a1f4e8b__
</mr_info>

Focus on:
- New public functions/methods without documentation
- Outdated comments that don't match the code
- Missing README updates for new features
- Complex logic without explanatory comments
- API changes without documentation updates
- Misleading or incorrect comments

For each finding, output in this format:
FINDING:
- severity: MEDIUM | LOW | INFO
- confidence: <0-10>
- file: <path>
- line: <number>
- issue: <brief description>
- suggestion: <what documentation to add/update>

Confidence scoring (0-10):
- +3: Clear documentation gap for public API or critical code
- +2: Outdated/incorrect comment that will mislead readers
- +2: Definite gap vs. nice-to-have documentation
- +2: A senior engineer would require this documentation
- +1: Newly introduced code (not pre-existing)

Only report findings with confidence >= 4.
If no documentation issues found, output: NO_FINDINGS
PROMPT
            ;;
    esac
}

# Get prompt and substitute placeholders
# Using Python for literal string replacement (no regex special char issues)
PROMPT=$(build_prompt "$AGENT")

PROMPT=$(TEMPLATE="$PROMPT" PLACEHOLDER="__REV_DIFF_7f3a9b2e__" REPLACEMENT="$DIFF_CONTENT" \
    python3 -c "import os; print(os.environ['TEMPLATE'].replace(os.environ['PLACEHOLDER'], os.environ['REPLACEMENT']), end='')")

PROMPT=$(TEMPLATE="$PROMPT" PLACEHOLDER="__REV_TITLE_8c4d1a3f__" REPLACEMENT="$MR_TITLE" \
    python3 -c "import os; print(os.environ['TEMPLATE'].replace(os.environ['PLACEHOLDER'], os.environ['REPLACEMENT']), end='')")

PROMPT=$(TEMPLATE="$PROMPT" PLACEHOLDER="__REV_DESC_2b5e9c7d__" REPLACEMENT="$MR_DESCRIPTION" \
    python3 -c "import os; print(os.environ['TEMPLATE'].replace(os.environ['PLACEHOLDER'], os.environ['REPLACEMENT']), end='')")

PROMPT=$(TEMPLATE="$PROMPT" PLACEHOLDER="__REV_LANG_6a1f4e8b__" REPLACEMENT="$LANGUAGES" \
    python3 -c "import os; print(os.environ['TEMPLATE'].replace(os.environ['PLACEHOLDER'], os.environ['REPLACEMENT']), end='')")

PROMPT=$(TEMPLATE="$PROMPT" PLACEHOLDER="__REV_AI_3d9c5a2e__" REPLACEMENT="$IS_AI_ASSISTED" \
    python3 -c "import os; print(os.environ['TEMPLATE'].replace(os.environ['PLACEHOLDER'], os.environ['REPLACEMENT']), end='')")

# Run agent via claude CLI
# Using --print to get output directly
echo "Running $AGENT agent with model $MODEL on fixture $(basename "$FIXTURE_DIR")..." >&2

OUTPUT=$(echo "$PROMPT" | timeout "$TIMEOUT" claude --print --model "$MODEL" 2>&1) || {
    EXIT_CODE=$?
    if [[ $EXIT_CODE -eq 124 ]]; then
        echo "Agent timed out after ${TIMEOUT}s" >&2
        echo "TIMEOUT"
        exit 0
    fi
    echo "Agent failed with exit code $EXIT_CODE" >&2
    echo "ERROR: $OUTPUT"
    exit 1
}

echo "$OUTPUT"
