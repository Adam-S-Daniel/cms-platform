#!/usr/bin/env bash
#
# sync-action-pin-comments.sh — refresh the inline `# vX.Y.Z (YYYY-MM-DD)`
# comments on every `uses: <owner>/<repo>@<sha>` line in
# `.github/workflows/*.yml` to match the SHA's actual tag and the tag's
# commit date.
#
# Why: Dependabot updates the SHA and the version portion of the comment
# but never the date. So once Dependabot has bumped a pin a few times,
# the trailing comment can be wildly stale (see PR #135: comment said
# v1.302.0 (2026-04-15) while the SHA was already v1.305.0). This
# script is the deterministic refresh, runnable locally and from
# .github/workflows/dependabot-comment-sync.yml on every Dependabot PR.
#
# Source-of-truth choice (per spec):
#   * Tag: among tags pointing at the SHA, the most-specific semver tag
#     (vMAJOR.MINOR.PATCH preferred over vMAJOR.MINOR over vMAJOR;
#     ties broken by component values numerically descending). If
#     multiple tags share the same specificity (e.g. v1.302.0 and
#     v1.302.0-beta), the lexicographically largest sorted version
#     wins. Anything that doesn't match `^v?\d+(\.\d+)*` is ignored.
#   * Date: the commit's `committer.date`, formatted YYYY-MM-DD.
#     (Author and committer dates almost always agree; we pick committer
#     and stick with it for determinism.)
#
# Edge case: no tag points at the SHA. Per user direction, the comment
# becomes `  # (no tag found)` and a warning is printed to stderr. The
# script does not fail.
#
# Idempotent: running twice in a row with no upstream activity produces
# no diff. `--check` mode prints what would change and exits non-zero
# without writing.
#
# Dependencies: bash, gh (authenticated), jq, awk, sed, perl. All are
# present on ubuntu-latest runners by default; locally, install gh via
# the GitHub CLI instructions.
#
# Usage:
#   bash scripts/sync-action-pin-comments.sh
#   bash scripts/sync-action-pin-comments.sh --check
#   bash scripts/sync-action-pin-comments.sh --workflows-dir tmp/fixture
#
set -uo pipefail

# ---------- Argument parsing ----------
CHECK_MODE=0
WORKFLOWS_DIR=".github/workflows"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check)
      CHECK_MODE=1
      shift
      ;;
    --workflows-dir)
      WORKFLOWS_DIR="${2:?--workflows-dir requires a value}"
      shift 2
      ;;
    --workflows-dir=*)
      WORKFLOWS_DIR="${1#--workflows-dir=}"
      shift
      ;;
    -h | --help)
      sed -n '2,/^set -uo pipefail/p' "$0" | sed -E 's/^# ?//;/^set/d'
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      echo "usage: $0 [--check] [--workflows-dir DIR]" >&2
      exit 2
      ;;
  esac
done

if [[ ! -d "$WORKFLOWS_DIR" ]]; then
  echo "workflows dir not found: $WORKFLOWS_DIR" >&2
  exit 2
fi

# ---------- Dep checks ----------
for cmd in gh jq awk sed perl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "missing required tool: $cmd" >&2
    exit 2
  fi
done

# ---------- Cache ----------
# Cache resolved (tag, date) per (repo, sha) so a workflow with the
# same SHA referenced N times only hits the API once.
declare -A RESOLVED_TAG
declare -A RESOLVED_DATE

# resolve_pin <owner/repo> <sha>
# Populates RESOLVED_TAG["$key"] and RESOLVED_DATE["$key"].
# Tag empty + date empty => no tag found. Date present + tag empty =>
# (theoretical) tag-resolution skipped, treat as no tag found. Both
# empty + non-zero return => API failure (caller decides what to do).
resolve_pin() {
  local repo="$1" sha="$2"
  local key="${repo}@${sha}"

  if [[ -n "${RESOLVED_TAG[$key]+set}" ]]; then
    return 0
  fi

  # 1) List every tag in the repo, paginated. The API returns
  #    `{ref, object: {sha, type}}`. For lightweight tags the
  #    `object.sha` is the commit; for annotated tags it points at
  #    the tag object, which we have to dereference to get the
  #    commit.
  local tags_json
  if ! tags_json="$(gh api "repos/${repo}/git/matching-refs/tags" --paginate 2>/dev/null)"; then
    echo "warn: failed to list tags for ${repo}" >&2
    RESOLVED_TAG["$key"]=""
    RESOLVED_DATE["$key"]=""
    return 1
  fi

  # 2) Build a list of `<tag>\t<commit-sha>` rows. Annotated tag
  #    objects need a second hop. Most actions repos use lightweight
  #    tags so this is usually free.
  #
  #    A second-hop annotated-tag dereference is rare for action
  #    repos (most use lightweight tags for releases). We collect
  #    annotated-tag object SHAs and dereference them in a second
  #    batch to avoid quadratic API spam.
  local lightweight_rows annotated_rows
  lightweight_rows="$(
    jq -r '
      .[] | select(.object.type == "commit") |
      "\(.ref | sub("^refs/tags/"; ""))\t\(.object.sha)"
    ' <<<"$tags_json"
  )"
  annotated_rows=""
  local annotated_pairs
  annotated_pairs="$(
    jq -r '
      .[] | select(.object.type == "tag") |
      "\(.ref | sub("^refs/tags/"; ""))\t\(.object.sha)"
    ' <<<"$tags_json"
  )"
  if [[ -n "$annotated_pairs" ]]; then
    while IFS=$'\t' read -r tag obj_sha; do
      [[ -z "$tag" ]] && continue
      local commit_sha
      if commit_sha="$(gh api "repos/${repo}/git/tags/${obj_sha}" --jq '.object.sha' 2>/dev/null)"; then
        annotated_rows+="${tag}	${commit_sha}"$'\n'
      fi
    done <<<"$annotated_pairs"
  fi

  local all_rows
  all_rows="$(printf '%s\n%s' "$lightweight_rows" "$annotated_rows")"

  # 3) Filter to tags pointing at the requested SHA. Trim empties.
  local matching
  matching="$(awk -F'\t' -v want="$sha" 'NF==2 && $2==want { print $1 }' <<<"$all_rows")"

  if [[ -z "$matching" ]]; then
    echo "warn: no tag points at ${repo}@${sha}" >&2
    RESOLVED_TAG["$key"]=""
    # Even without a tag we can still resolve the commit date — but
    # per spec, the comment becomes `(no tag found)` (no date), so
    # we don't bother fetching it.
    RESOLVED_DATE["$key"]=""
    return 0
  fi

  # 4) Pick the most-specific semver tag. Ranking key:
  #      (component-count, components numerically...) descending.
  #    Anything not matching `^v?\d+(\.\d+)*(-suffix)?` is sorted
  #    last. We use a sort -k pipeline: emit a sort-stable header
  #    line then the tag.
  local picked
  picked="$(
    awk '
      function rank_components(t,    n, parts, i, suffix) {
        # Strip optional leading v.
        sub(/^v/, "", t);
        # Strip pre-release suffix (e.g. -beta) for ranking purposes;
        # we still tiebreak via lex sort on the original.
        sub(/[-+].*$/, "", t);
        n = split(t, parts, ".");
        # Validate: each component must be digits.
        for (i = 1; i <= n; i++) {
          if (parts[i] !~ /^[0-9]+$/) return "";
        }
        # Pad to 6 components for stable column-wise sort.
        for (i = n + 1; i <= 6; i++) parts[i] = -1;
        return n "\t" parts[1] "\t" parts[2] "\t" parts[3] "\t" parts[4] "\t" parts[5] "\t" parts[6];
      }
      {
        r = rank_components($0);
        if (r == "") next;          # skip non-semver tags entirely
        print r "\t" $0;
      }
    ' <<<"$matching" \
      | sort -t$'\t' -k1,1nr -k2,2nr -k3,3nr -k4,4nr -k5,5nr -k6,6nr -k7,7nr -k8,8 \
      | head -n1 \
      | awk -F'\t' '{print $8}'
  )"

  if [[ -z "$picked" ]]; then
    # Tags exist but none parsed as semver. Fall back to the first
    # matching raw tag (lex order).
    picked="$(printf '%s\n' "$matching" | sort | head -n1)"
    echo "warn: no semver tag among ${repo}@${sha} matches; falling back to '${picked}'" >&2
  fi

  RESOLVED_TAG["$key"]="$picked"

  # 5) Resolve the SHA's committer date.
  local date_iso
  if ! date_iso="$(gh api "repos/${repo}/git/commits/${sha}" --jq '.committer.date' 2>/dev/null)"; then
    echo "warn: failed to fetch commit date for ${repo}@${sha}" >&2
    RESOLVED_DATE["$key"]=""
  else
    # Trim to YYYY-MM-DD.
    RESOLVED_DATE["$key"]="${date_iso:0:10}"
  fi
}

# ---------- Walk workflow files ----------
# A `uses:` line we care about looks like:
#   <indent>(- )?uses: owner/repo@<40-hex>(  # ...)?
# Action paths can also be owner/repo/path@sha (e.g.
# actions/cache/save@...). Capture that whole `owner/repo[/path]`
# slug as the action ref, but the API expects only `owner/repo` —
# strip the trailing path component(s) before calling the API.
#
# We process line-by-line; emit (file, lineno, before, after) records
# for the summary, then rewrite each file once if not in --check.

USES_RE='^([[:space:]]*-?[[:space:]]*uses:[[:space:]]+)([A-Za-z0-9._-]+)/([A-Za-z0-9._/-]+)@([0-9a-f]{40})([[:space:]]*)(#.*)?[[:space:]]*$'

declare -a SUMMARY_LINES=() # human-readable summary
ANY_CHANGE=0

# Re-emit a refreshed line. Preserves the exact "spaces between SHA
# and #" segment if present in the original; if no comment was there,
# falls back to two spaces (the repo convention).
build_new_line() {
  local prefix="$1" owner="$2" repo_path="$3" sha="$4" gap="$5" tag="$6" date="$7"
  local comment
  if [[ -z "$tag" ]]; then
    comment="# (no tag found)"
  elif [[ -z "$date" ]]; then
    comment="# ${tag}"
  else
    comment="# ${tag} (${date})"
  fi
  local effective_gap="$gap"
  if [[ -z "$effective_gap" ]]; then
    effective_gap="  "
  fi
  printf '%s%s/%s@%s%s%s' \
    "$prefix" "$owner" "$repo_path" "$sha" "$effective_gap" "$comment"
}

# Process one file: rewrite in place (unless --check). Sets
# FILE_CHANGED=1 if anything would change.
process_file() {
  local file="$1"
  local tmp
  tmp="$(mktemp)"
  local file_changed=0

  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" =~ $USES_RE ]]; then
      local prefix="${BASH_REMATCH[1]}"
      local owner="${BASH_REMATCH[2]}"
      local repo_path="${BASH_REMATCH[3]}"
      local sha="${BASH_REMATCH[4]}"
      local gap="${BASH_REMATCH[5]}"
      # shellcheck disable=SC2034  # group 6 (existing comment) named for parity with USES_RE; build_new_line regenerates it.
      local existing_comment="${BASH_REMATCH[6]:-}"

      # API repo is just owner/repo (first path segment).
      local repo_root="${repo_path%%/*}"
      local repo="${owner}/${repo_root}"

      resolve_pin "$repo" "$sha" || true
      local tag="${RESOLVED_TAG["${repo}@${sha}"]}"
      local date="${RESOLVED_DATE["${repo}@${sha}"]}"

      local new_line
      new_line="$(build_new_line "$prefix" "$owner" "$repo_path" "$sha" "$gap" "$tag" "$date")"

      if [[ "$new_line" != "$line" ]]; then
        SUMMARY_LINES+=("${file}:${NR:-?}: ${owner}/${repo_path}@${sha:0:7}")
        SUMMARY_LINES+=("  - ${line#"${prefix}"}")
        SUMMARY_LINES+=("  + ${new_line#"${prefix}"}")
        file_changed=1
        ANY_CHANGE=1
      fi
      printf '%s\n' "$new_line" >>"$tmp"
    else
      printf '%s\n' "$line" >>"$tmp"
    fi
    NR=$((${NR:-0} + 1))
  done <"$file"
  unset NR

  if [[ "$file_changed" == "1" && "$CHECK_MODE" == "0" ]]; then
    # Preserve original trailing-newline state. `read` strips it;
    # we always re-add. If the original had no trailing newline,
    # strip one off the tmp before move.
    if [[ "$(tail -c1 "$file" | od -An -c | tr -d ' ')" != '\n' ]]; then
      # Trim final newline from tmp.
      perl -i -pe 'chomp if eof' "$tmp"
    fi
    mv "$tmp" "$file"
  else
    rm -f "$tmp"
  fi
}

# Iterate workflow files in stable order.
shopt -s nullglob
WORKFLOW_FILES=("$WORKFLOWS_DIR"/*.yml "$WORKFLOWS_DIR"/*.yaml)
shopt -u nullglob

if [[ "${#WORKFLOW_FILES[@]}" -eq 0 ]]; then
  echo "no workflow files found in $WORKFLOWS_DIR" >&2
  exit 0
fi

for f in "${WORKFLOW_FILES[@]}"; do
  process_file "$f"
done

# ---------- Summary ----------
if [[ "${#SUMMARY_LINES[@]}" -eq 0 ]]; then
  echo "sync-action-pin-comments: no changes; every comment matches its SHA's tag/date."
else
  if [[ "$CHECK_MODE" == "1" ]]; then
    echo "sync-action-pin-comments: would update the following pin comments:"
  else
    echo "sync-action-pin-comments: updated the following pin comments:"
  fi
  printf '%s\n' "${SUMMARY_LINES[@]}"
fi

if [[ "$CHECK_MODE" == "1" && "$ANY_CHANGE" == "1" ]]; then
  exit 1
fi

exit 0
