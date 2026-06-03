#!/usr/bin/env bash
#
# Write `_site/admin/commit.json` so the admin shell's top-right commit pill
# renders locally (e.g. while running `npx serve _site` after a Jekyll build).
# CI's deploy workflows do this automatically; this is for local dev.
#
# As of v0.1.4 the admin machinery is SERVED from `_site/admin` (the render
# hook copies it there from the gem), so the pill's relative
# `fetch('commit.json')` resolves under `_site/admin/` — there is no longer a
# vendored repo-root `admin/` to write to.
#
# Usage:
#   bash scripts/write-commit-json.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHA=$(git -C "$REPO_ROOT" rev-parse HEAD)
ISO=$(git -C "$REPO_ROOT" log -1 --format=%cI HEAD)
BRANCH=$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)

JSON="{ \"sha\": \"${SHA}\", \"iso\": \"${ISO}\", \"branch\": \"${BRANCH}\" }"

TARGET="${REPO_ROOT}/_site/admin/commit.json"
mkdir -p "$(dirname "$TARGET")"
printf '%s\n' "$JSON" >"$TARGET"
echo "Wrote $TARGET"
