#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
source_command="$repo_root/.claude/commands/review-mr.md"
target_dir="${CLAUDE_COMMANDS_DIR:-$HOME/.claude/commands}"
target_command="$target_dir/review-mr.md"
install_root="${SAMOREV_INSTALL_ROOT:-$HOME/.claude/samorev}"

if [[ ! -f "$source_command" ]]; then
  echo "Error: review-mr.md not found at $source_command" >&2
  exit 1
fi

if [[ ! -f "$repo_root/lib/provider_planning.py" ||
      ! -f "$repo_root/lib/review_memory.py" ||
      ! -f "$repo_root/lib/compliance.py" ||
      ! -f "$repo_root/scripts/summarize-github-ci.sh" ]]; then
  echo "Error: samorev helper set is incomplete at $repo_root" >&2
  exit 1
fi

mkdir -p "$target_dir"

command_already_installed=0
if [[ -L "$target_command" ]]; then
  current_target="$(readlink -f "$target_command" 2>/dev/null || true)"
  if [[ "$current_target" == "$source_command" ]]; then
    command_already_installed=1
  else
    echo "Error: $target_command already exists and points to $(readlink "$target_command")" >&2
    echo "Remove it first if you want to replace it with samorev." >&2
    exit 1
  fi
elif [[ -e "$target_command" ]]; then
  echo "Error: $target_command already exists" >&2
  echo "Remove or back it up before installing samorev's /review-mr command." >&2
  exit 1
fi

if [[ -e "$install_root" || -L "$install_root" ]]; then
  resolved_install_root="$(cd "$install_root" 2>/dev/null && pwd -P)" || {
    echo "Error: cannot resolve install root $install_root" >&2
    exit 1
  }
  if [[ "$resolved_install_root" != "$repo_root" ]]; then
    echo "Error: $install_root is occupied by a different checkout ($resolved_install_root)" >&2
    exit 1
  fi
else
  mkdir -p "$(dirname "$install_root")"
  ln -s "$repo_root" "$install_root"
fi

if [[ "$command_already_installed" -eq 1 ]]; then
  echo "/review-mr already installed at $target_command; trusted helper root verified"
else
  ln -s "$source_command" "$target_command"
  echo "Installed /review-mr at $target_command"
fi
