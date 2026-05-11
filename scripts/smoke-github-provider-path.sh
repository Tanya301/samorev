#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MR_REF="${SAMOREV_SMOKE_REF:-https://github.com/example-org/example-repo/pull/17}"
REMOTE_URL="${SAMOREV_SMOKE_REMOTE_URL:-https://github.com/example-org/example-repo.git}"

PLAN_OUTPUT=$(python3 "$repo_root/lib/provider_planning.py" "$MR_REF" --remote-url "$REMOTE_URL" --shell)
eval "$PLAN_OUTPUT"

gh() {
  case "$*" in
    "pr view 17 --repo example-org/example-repo --json "*)
      cat <<'JSON'
{"headRefName":"feature/github-smoke","author":{"login":"octocat"},"body":"Smoke review body with enough detail for metadata parsing.","state":"OPEN","isDraft":false,"title":"Example PR","url":"https://github.com/example-org/example-repo/pull/17"}
JSON
      ;;
    "pr diff 17 --repo example-org/example-repo")
      cat <<'DIFF'
diff --git a/app.py b/app.py
index 1111111..2222222 100644
--- a/app.py
+++ b/app.py
@@ -1,3 +1,3 @@
 # smoke fixture
-print("old")
+print("new")
DIFF
      ;;
    "api repos/example-org/example-repo/issues/17/comments --paginate")
      cat <<'JSON'
[{"created_at":"2026-05-10T12:00:00Z","user":{"login":"reviewer"},"body":"previous discussion"}]
JSON
      ;;
    "api repos/example-org/example-repo/pulls/17/commits --paginate")
      cat <<'JSON'
[{"commit":{"committer":{"date":"2026-05-10T12:10:00Z"}}}]
JSON
      ;;
    "api repos/example-org/example-repo/commits/pull/17/head/check-runs --paginate")
      cat <<'JSON'
{"check_runs":[{"name":"ci","status":"completed","conclusion":"success","html_url":"https://github.com/example-org/example-repo/actions/runs/12345/jobs/67890"}]}
JSON
      ;;
    *)
      echo "Unexpected gh invocation: gh $*" >&2
      return 2
      ;;
  esac
}

MR_JSON=$(eval "$METADATA_COMMAND")
if [ "$REVIEW_PROVIDER" != "github" ]; then
  echo "Expected github provider, got $REVIEW_PROVIDER" >&2
  exit 1
fi

MR_TITLE=$(echo "$MR_JSON" | jq -r '.title')
DIFF_CONTENT=$(eval "$DIFF_COMMAND")
COMMENTS_JSON=$(eval "$COMMENTS_COMMAND")
COMMITS_JSON=$(eval "$COMMITS_COMMAND")
CI_JSON=$(eval "$CI_COMMAND")

PIPELINE_STATUS=$(echo "$CI_JSON" | jq -r '
  (.check_runs // []) as $runs |
  if ($runs | length) == 0 then "unknown"
  elif any($runs[]; (.conclusion // "") == "failure" or (.conclusion // "") == "timed_out" or (.conclusion // "") == "cancelled") then "failed"
  elif all($runs[]; (.conclusion // "") == "success" or (.conclusion // "") == "skipped" or (.conclusion // "") == "neutral") then "success"
  elif any($runs[]; (.status // "") == "queued") then "pending"
  else "running" end')

echo "provider=$REVIEW_PROVIDER"
echo "review=$REVIEW_KIND $PROJECT#$REVIEW_NUMBER"
echo "metadata_title=$MR_TITLE"
echo "diff_lines=$(printf '%s\n' "$DIFF_CONTENT" | wc -l | tr -d ' ')"
echo "comments_seen=$(echo "$COMMENTS_JSON" | jq 'length')"
echo "commits_seen=$(echo "$COMMITS_JSON" | jq 'length')"
echo "ci_status=$PIPELINE_STATUS"
echo "post_command=$POST_COMMENT_COMMAND"
echo "live_posting=not-run"
