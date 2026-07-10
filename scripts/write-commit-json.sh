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
# Same platform_repo/platform_ref read as the deploy workflows (deploy-
# production.yml / deploy-preview.yml) — tolerant of a missing platform.lock
# or missing keys (local dev off a fresh checkout), never failing this
# script; the pill just omits itself when either is empty.
PLATFORM_REPO=$(grep -m1 '^platform_repo:' "$REPO_ROOT/platform.lock" 2>/dev/null | sed -E 's/^[^:]+:[[:space:]]*//;s/[[:space:]]+$//') || true
PLATFORM_REF=$(grep -m1 '^platform_ref:' "$REPO_ROOT/platform.lock" 2>/dev/null | sed -E 's/^[^:]+:[[:space:]]*//;s/[[:space:]]+$//') || true

JSON="{ \"sha\": \"${SHA}\", \"iso\": \"${ISO}\", \"branch\": \"${BRANCH}\", \"platform_repo\": \"${PLATFORM_REPO}\", \"platform_ref\": \"${PLATFORM_REF}\" }"

TARGET="${REPO_ROOT}/_site/admin/commit.json"
mkdir -p "$(dirname "$TARGET")"
printf '%s\n' "$JSON" >"$TARGET"
echo "Wrote $TARGET"
