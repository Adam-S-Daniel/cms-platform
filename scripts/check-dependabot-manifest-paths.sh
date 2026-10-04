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
# behavior for BOTH gates identically, which is the point of factoring it
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
# when a path is outside the allowlist. Exit 2 + prints "safe=false" when the
# diff cannot be read.
set -euo pipefail

# Workflow commands interpret percent escapes, newlines, and (in properties)
# colons and commas. Escape percent first so the replacement text is not
# escaped again. `printf %q` then keeps the listing to one physical line per
# path while retaining the escaped control characters.
escape_workflow_data() {
  local value=$1
  value=${value//\%/%25}
  value=${value//$'\r'/%0D}
  value=${value//$'\n'/%0A}
  printf '%s' "$value"
}

escape_workflow_property() {
  local value
  value=$(escape_workflow_data "$1")
  value=${value//:/%3A}
  value=${value//,/%2C}
  printf '%s' "$value"
}

if [ "$#" -ne 2 ]; then
  printf 'usage: %q <base-ref> <head-ref-or-sha>\n' "$(escape_workflow_data "$0")" >&2
  exit 2
fi

BASE="$1"
HEAD="$2"

changed_paths=$(mktemp)
diff_stderr=""
trap 'rm -f -- "$changed_paths" "$diff_stderr"' EXIT
diff_stderr=$(mktemp)
if git diff --name-only --no-renames -z "$BASE"..."$HEAD" > "$changed_paths" 2> "$diff_stderr"; then
  :
else
  echo "::error::Could not read the Dependabot PR diff; refusing the manifest check."
  printf 'Git diff diagnostic: %s\n' "$(escape_workflow_data "$(cat "$diff_stderr")")"
  echo "safe=false"
  exit 2
fi
mapfile -d '' -t CHANGED < "$changed_paths"

printf 'Files changed (%q...%q):\n' "$(escape_workflow_data "$BASE")" "$(escape_workflow_data "$HEAD")"
for f in "${CHANGED[@]}"; do
  printf '  - %q\n' "$(escape_workflow_data "$f")"
done

REJECT=0
for f in "${CHANGED[@]}"; do
  case "$f" in
    package.json|*/package.json|package-lock.json|*/package-lock.json) ;;
    Gemfile|*/Gemfile|Gemfile.lock|*/Gemfile.lock) ;;
    .github/workflows/*.yml|.github/workflows/*.yaml) ;;
    *)
      printf '::error file=%s::Dependabot PR touches non-manifest path: %s\n' \
        "$(escape_workflow_property "$f")" "$(escape_workflow_data "$f")"
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
