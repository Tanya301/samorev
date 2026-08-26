# Durable (crash-resumable) review mode

**Default: OFF.** This feature ships dark and must be explicitly enabled.

## What it does

When `SAMOREV_DURABLE=1`, samorev wraps the review pipeline in an
[Absurd](https://github.com/earendil-works/absurd) durable-workflow step. If the
process crashes between the LLM review and the posting step, the review result
is replayed from Postgres — no LLM re-call, no duplicate cost.

Without the flag, the code path is **byte-for-byte unchanged**.

## Prerequisites

1. A reachable Postgres database (any version supported by Absurd).
2. The Absurd schema applied once:
   ```sh
   psql $SAMOREV_DURABLE_DSN -f db/absurd.sql
   ```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `SAMOREV_DURABLE` | unset | Set to `1` to enable |
| `SAMOREV_DURABLE_DSN` | `postgresql://$USER@/samorev_durable_poc?host=/var/run/postgresql` | Postgres connection string |

## Known limitation

The CLI spawns a fresh Absurd task per invocation. Auto-resume after a crash
requires re-running the same CLI command — the in-flight task will be resumed
from its last committed step. True zero-touch auto-resume (persistent worker
keyed by MR ID) is tracked in the follow-up issue.
