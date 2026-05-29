#!/usr/bin/env bash
#
# Write admin/commit.json (and `_site/admin/commit.json` if `_site/`
# exists) so the admin shell's top-right commit pill renders locally.
# CI's deploy workflows do this automatically; this script is for
# developers who want the pill while running `jekyll serve` or
# `npx serve _site`.
#
# Usage:
#   bash scripts/write-commit-json.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHA=$(git -C "$REPO_ROOT" rev-parse HEAD)
ISO=$(git -C "$REPO_ROOT" log -1 --format=%cI HEAD)
BRANCH=$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)

JSON="{ \"sha\": \"${SHA}\", \"iso\": \"${ISO}\", \"branch\": \"${BRANCH}\" }"

write() {
  local target="$1"
  mkdir -p "$(dirname "$target")"
  printf '%s\n' "$JSON" >"$target"
  echo "Wrote $target"
}

write "${REPO_ROOT}/admin/commit.json"
if [ -d "${REPO_ROOT}/_site/admin" ]; then
  write "${REPO_ROOT}/_site/admin/commit.json"
fi
