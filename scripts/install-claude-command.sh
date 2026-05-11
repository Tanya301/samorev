#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_command="$repo_root/.claude/commands/review-mr.md"
target_dir="${CLAUDE_COMMANDS_DIR:-$HOME/.claude/commands}"
target_command="$target_dir/review-mr.md"

if [[ ! -f "$source_command" ]]; then
  echo "Error: review-mr.md not found at $source_command" >&2
  exit 1
fi

mkdir -p "$target_dir"

if [[ -L "$target_command" ]]; then
  current_target="$(readlink "$target_command")"
  if [[ "$current_target" == "$source_command" ]]; then
    echo "/review-mr already installed at $target_command"
    exit 0
  fi
  echo "Error: $target_command already exists and points to $current_target" >&2
  echo "Remove it first if you want to replace it with samorev." >&2
  exit 1
elif [[ -e "$target_command" ]]; then
  echo "Error: $target_command already exists" >&2
  echo "Remove or back it up before installing samorev's /review-mr command." >&2
  exit 1
fi

ln -s "$source_command" "$target_command"

echo "Installed /review-mr at $target_command"
