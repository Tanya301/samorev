# samorev verdict output — machine parsing reference

This describes the exact structure of the report produced by
`samorev review <ref> --fetch` so a bot can parse a PASS/FAIL verdict reliably.
The format is produced by `renderRevLikeReport()` in `src/fetchReport.ts`.

The same report is what gets posted to the PR/MR (unless `--no-comment`).

---

## Report skeleton

```markdown
## samorev Code Review Report

- **PR:** OWNER/REPO#123 - <title>        (GitLab uses "**MR:** GROUP/PROJECT!123")
- **Author:** @<login>
- **AI-Assisted:** Unknown

| Pipeline | Coverage |
|----------|----------|
| <PASS|PENDING|FAIL|<raw status>> | Not reported |

---

<EITHER the BLOCKING block OR the PASS block — see below>

### Summary

| Area | Findings | Potential | Filtered |
|------|----------|-----------|----------|
| CI/Pipeline | <0|1> | 0 | 0 |
| Security | 0 | 0 | 0 |
| Bugs | 0 | 0 | 0 |
| Tests | 0 | 0 | 0 |
| Guidelines | 0 | 0 | 0 |
| Docs | 0 | 0 | 0 |
| Metadata | <0|1> | 0 | 0 |

Note:
- **Findings**: ...
- **Potential**: ...
- **Filtered**: ...

<details>
<summary>Review metadata</summary>

```text
<key=value metadata block — see below>
```

</details>

---
*samorev-assisted review (AI analysis by [Tanya301/samorev](https://github.com/Tanya301/samorev))*
```

> The `Security/Bugs/Tests/Guidelines/Docs` rows are always `0` from the CLI;
> only `CI/Pipeline` and `Metadata` can be non-zero. (The AI agents that fill the
> other rows run only via the `/review-mr` slash command.)

---

## The two outcome blocks

### PASS block (zero gate findings)

```markdown
No issues found. Reviewed for security, bugs, tests, guidelines, and documentation.

**Result: PASSED**
```

### FAIL block (one or more gate findings)

```markdown
### BLOCKING ISSUES (N)

**CRITICAL** `CI/Pipeline` - Pipeline status is <status>
> Provider CI reported status `<status>`.
> **Fix:** Fix failing checks and rerun review.

**HIGH** `MR/PR state` - Review target is draft
> The review target is still marked as draft.
> **Fix:** Mark it ready for review before merge.
```

Gate findings (from `reviewGateFindings()`):

| Trigger | Area | Severity |
|---------|------|----------|
| `draft == true` | Metadata | HIGH |
| CI status not in {`success`, `none`} and `== pending` | CI/Pipeline | HIGH |
| CI status not in {`success`, `none`} and any other | CI/Pipeline | CRITICAL |

---

## Metadata block (the canonical machine-readable payload)

Inside the `<details>` → ```` ```text ```` fence. Every key is `key=value`,
one per line:

| Key | Meaning |
|-----|---------|
| `provider` | `github` or `gitlab` |
| `kind` | `pr` or `mr` |
| `project` | `owner/repo` or `group/project` |
| `number` | PR/MR number |
| `target` | `provider:project#number` |
| `state` | provider state (`OPEN`/`opened`/`merged`/…) |
| `draft` | `true` / `false` |
| `diff_lines` / `diff_added` / `diff_removed` / `diff_bytes` | diff size |
| `comments_count` / `commits_count` | counts |
| `ci_status` | normalized CI status used by the gate |
| `ci_summary` | per-bucket CI detail |
| `prompt` | path to the review prompt |
| `blocking` | echoes the `--blocking` flag |
| `posted_by` | `local`, `gh`, or `glab` |
| `no_comment` | `true` / `false` |
| `live_posting` | `not-run` / `posted` / `blocked` |

---

## Recommended bot parse

```bash
out="$(bun run samorev review "$REF" --no-comment --fetch)" || { echo "fetch failed"; exit 1; }

if grep -q '^\*\*Result: PASSED\*\*$' <<<"$out"; then
  verdict=PASS
elif grep -qE '^### BLOCKING ISSUES \([1-9][0-9]*\)' <<<"$out"; then
  verdict=FAIL
else
  verdict=UNKNOWN   # report shape changed — fail closed
fi

ci_status="$(grep -oE '^ci_status=.*' <<<"$out" | cut -d= -f2-)"
live_posting="$(grep -oE '^live_posting=.*' <<<"$out" | cut -d= -f2-)"
echo "verdict=$verdict ci_status=$ci_status live_posting=$live_posting"
```

Robustness notes:

- A clean `--fetch` exits `0` for **both** PASS and FAIL. Use the body, not `$?`,
  for the verdict. `$? != 0` means the fetch/post itself failed.
- `live_posting=blocked` (with a non-zero exit) means posting was requested but
  provider auth failed — re-auth `gh`/`glab` and retry.
- Treat `UNKNOWN` as a hard failure (fail closed) rather than assuming PASS.
