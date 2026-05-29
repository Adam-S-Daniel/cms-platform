#!/usr/bin/env bash
#
# Patch admin/config.yml (in-place) so a preview deploy's CMS points at the
# right host and branch. See deploy-preview.yml for why each field changes.
#
# Domain-agnostic: the preview host is passed in as an argument, so this
# script is reused verbatim by every site built on the platform.
#
# Usage: patch-preview-config.sh <config_file> <pr_number> <branch> <preview_host>
set -euo pipefail

if [[ $# -ne 4 ]]; then
  echo "usage: $0 <config_file> <pr_number> <branch> <preview_host>" >&2
  exit 2
fi

CONFIG="$1"
# shellcheck disable=SC2034  # reserved for future use
PR_NUMBER="$2"
BRANCH="$3"
PREVIEW_HOST="$4"

PREVIEW_URL="https://${PREVIEW_HOST}"

# 1. site_url: Decap keeps only .origin() from this, so the host must be
#    the full subdomain. No path component needed — each PR lives at the
#    root of its own subdomain, so preview and prod share URL paths.
sed -i -E "s|^site_url:.*|site_url: ${PREVIEW_URL}|" "$CONFIG"

# 2. display_url: used by the "Open Production Site" button only. Points
#    at the same preview so the button doesn't fling editors at prod.
sed -i -E "s|^display_url:.*|display_url: ${PREVIEW_URL}|" "$CONFIG"

# 3. backend.branch: Decap's GitHub backend fetches posts from whichever
#    branch is listed here, not whichever branch the preview was *built*
#    from. Without repointing, Decap reads stale `main` copies and the
#    editor sees last-merged content instead of this PR's.
sed -i -E "s|^(  branch:).*|\\1 ${BRANCH}|" "$CONFIG"

# preview_path is intentionally left alone: pages on the subdomain live
# at the same paths as on prod (/blog/:slug/), so the checked-in template
# is already correct for previews.
