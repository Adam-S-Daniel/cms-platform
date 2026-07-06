#!/usr/bin/env bash
# Dependabot manifest-path allowlist — the single source of truth for
# "does this diff only touch paths Dependabot is expected to touch?"
#
# Shared by BOTH:
#   - .github/workflows/dependabot-auto-merge.yml   (the pull_request-triggered
#     per-PR auto-merge gate)
#   - .github/workflows/dependabot-rearm-sweep.yml  (the scheduled re-arm
#     sweep for PRs GitHub auto-disabled auto-merge on after a sibling PR in
#     the same Dependabot batch merged first — see AGENTS.md "Dependabot
#     batch-strand re-arm sweep")
# Keep both call sites in lockstep: a change to the allowlist here changes
# behaviour for BOTH gates identically, which is the point of factoring it
# out rather than duplicating it.
#
# Usage: check-dependabot-manifest-paths.sh <base-ref> <head-ref-or-sha>
# Requires a checkout where both refs are already fetched/resolvable (e.g.
# `actions/checkout` with fetch-depth: 0, plus an explicit `git fetch` of any
# ref not already present locally).
#
# Exit 0 + prints "safe=true" when every path changed between the two refs
# is within the allowlist (npm/bundler manifests + lockfiles, in any
# directory, plus workflow YAML restricted to .github/workflows/). Exit 1 +
# prints "safe=false" (with an `::error file=...` annotation per offender)
# otherwise.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <base-ref> <head-ref-or-sha>" >&2
  exit 2
fi

BASE="$1"
HEAD="$2"

mapfile -t CHANGED < <(git diff --name-only "$BASE"..."$HEAD")
echo "Files changed (${BASE}...${HEAD}):"
printf '  %s\n' "${CHANGED[@]}"

REJECT=0
for f in "${CHANGED[@]}"; do
  case "$f" in
    package.json|*/package.json|package-lock.json|*/package-lock.json) ;;
    Gemfile|*/Gemfile|Gemfile.lock|*/Gemfile.lock) ;;
    .github/workflows/*.yml|.github/workflows/*.yaml) ;;
    *)
      echo "::error file=$f::Dependabot PR touches non-manifest path: $f"
      REJECT=1
      ;;
  esac
done

if [ "$REJECT" = "1" ]; then
  echo "safe=false"
  exit 1
fi

echo "safe=true"
echo "All changed paths are within the manifest allowlist."
