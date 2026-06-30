#!/usr/bin/env bash
# Wire this repo's pre-commit guard chain (secrets-scan + lint-staged) into the
# local git config. Idempotent; safe to run from a Claude Code SessionStart hook
# on every session. Platform-authoritative + kept in sync by dev-hooks-sync.yml.
#
# Git >= 2.54 registers each guard individually via .gitconfig-fragment
# (`git hook list pre-commit` then shows them); older git uses core.hooksPath.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

GITCONFIG_FRAGMENT=".gitconfig-fragment"
HOOKS_DIR=".githooks"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "setup-hooks: not a git work tree — skipping" >&2
  exit 0
fi

git_version="$(git --version 2>/dev/null | awk '{print $3}')"
major="${git_version%%.*}"
rest="${git_version#*.}"
minor="${rest%%.*}"

use_config_hooks=0
if [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ ]]; then
  if ((major > 2 || (major == 2 && minor >= 54))); then
    use_config_hooks=1
  fi
fi

if ((use_config_hooks)) && [[ -f "$GITCONFIG_FRAGMENT" ]]; then
  include_value="../$GITCONFIG_FRAGMENT"
  if ! git config --local --get-all include.path 2>/dev/null | grep -qFx "$include_value"; then
    git config --local --add include.path "$include_value"
  fi
  echo "setup-hooks: pre-commit guards registered via $GITCONFIG_FRAGMENT (git $git_version)"
elif [[ -d "$HOOKS_DIR" ]]; then
  git config --local core.hooksPath "$HOOKS_DIR"
  echo "setup-hooks: core.hooksPath set to $HOOKS_DIR (git $git_version)"
else
  echo "setup-hooks: no $GITCONFIG_FRAGMENT or $HOOKS_DIR present — nothing to wire" >&2
fi
