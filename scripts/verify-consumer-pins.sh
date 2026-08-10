#!/usr/bin/env bash
# THIS SCRIPT'S EXIT CODE IS THE DEFINITION OF DONE FOR A CONSUMER PIN BUMP.
# Run it from the CONSUMER repo root; a green run — not a read of the diff, not a
# subagent's prose — is what makes the bump done.
#
# WHY IT EXISTS. The v0.1.76 consumer bump was delegated with an exact spec that
# ended in "run the authoritative gate", and neither agent ran it: one stopped
# after 3 of 5 edit categories (having invented a constraint it was never given),
# left 58 stale `v0.1.75` refs behind, and reported the work as essentially done.
# The other found 35 occurrences where the spec said 34 and dismissed the
# difference as "counting methodology" rather than investigating it. Verification
# that lives in prose is not verification, so it now lives in an exit code.
#
# WHAT IT CHECKS, in order, stopping at the first problem:
#   1. platform.lock declares a `platform_ref` (the canonical version).
#   2. No OTHER platform version ref survives in platform.lock / Gemfile /
#      Gemfile.lock / .github/workflows/ — i.e. no stale pin.
#   3. Every .github/workflows file parses as YAML.
#   4. check-platform-pin-consistency.js passes with --require-canonical (all 96
#      checks, including workflow-SET + workflow-CONTENT parity — the guard
#      degrades to 61 checks and still says "Pins are consistent" without it).
#
# USAGE
#   scripts/verify-consumer-pins.sh [--platform-dir <path>]
#     --platform-dir  where the cms-platform tree is (default: .cms-platform).
#                     Any checkout works, e.g. --platform-dir ../cms-platform.
set -euo pipefail

PLATFORM_DIR=".cms-platform"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --platform-dir)
      if [ "$#" -lt 2 ]; then
        echo "FAIL: --platform-dir needs a path" >&2
        echo "verify-consumer-pins: FAIL (1 problem(s))"
        exit 2
      fi
      PLATFORM_DIR="$2"
      shift 2
      ;;
    -h | --help)
      sed -n '1,26p' "$0"
      exit 0
      ;;
    *)
      echo "FAIL: unknown argument '$1' (usage: $0 [--platform-dir <path>])" >&2
      echo "verify-consumer-pins: FAIL (1 problem(s))"
      exit 2
      ;;
  esac
done

# Every check funnels through these two so the verdict line can never disagree
# with what was printed, and so a FAIL always ends the run (no check may report a
# problem and let the next one paper over it).
fail() {
  echo "FAIL: $1"
  echo "verify-consumer-pins: FAIL (${2:-1} problem(s))"
  exit 1
}
ok() { echo "ok: $1"; }

CHECKER="${PLATFORM_DIR}/scripts/check-platform-pin-consistency.js"
CANONICAL="${PLATFORM_DIR}/examples/site/.github/workflows"
YAML_LIB="${PLATFORM_DIR}/e2e/node_modules/yaml"

# ── 0. the platform tree we were pointed at must actually hold the machinery ──
[ -f "$CHECKER" ] || fail "no checker at ${CHECKER} — pass --platform-dir <cms-platform checkout>"
[ -d "$CANONICAL" ] || fail "no canonical workflow set at ${CANONICAL} — pass --platform-dir <cms-platform checkout>"
ok "platform machinery found under ${PLATFORM_DIR}"

# ── 1. platform.lock platform_ref (the canonical version) ────────────────────
[ -f platform.lock ] || fail "no platform.lock in $(pwd) — run this from a CONSUMER repo root"
REF="$(sed -n 's/^platform_ref:[[:space:]]*["'\'']\{0,1\}\([^"'\''[:space:]]*\).*/\1/p' platform.lock | head -n 1)"
[ -n "$REF" ] || fail "platform.lock has no platform_ref: value (the canonical version)"
ok "platform.lock platform_ref = ${REF}"

# ── 2. no OTHER platform version ref survives (no stale pin) ─────────────────
# Scoped to lines that ALSO mention the platform repo slug, the theme gem, a
# `platform_ref`, or a Gemfile.lock GIT-source `tag:` — so an unrelated version
# string cannot trip it: a third-party action's `# v6.0.2 (…)` pin comment, or a
# prose mention like "since v0.1.4" in a workflow header comment, is ignored.
# (That prose class is real: it is exactly the benign 35-vs-34 count difference
# the delegation incident above shrugged off instead of establishing.)
SLUG="$(sed -n 's/^platform_repo:[[:space:]]*["'\'']\{0,1\}\([^"'\''[:space:]]*\).*/\1/p' platform.lock | head -n 1)"
[ -n "$SLUG" ] || SLUG="Adam-S-Daniel/cms-platform"

SCAN_FILES=(platform.lock)
for f in Gemfile Gemfile.lock; do
  if [ -f "$f" ]; then
    SCAN_FILES+=("$f")
  fi
done
WF_FILES=()
if [ -d .github/workflows ]; then
  while IFS= read -r f; do
    WF_FILES+=("$f")
  done < <(find .github/workflows -type f \( -name '*.yml' -o -name '*.yaml' \) | sort)
fi
if [ "${#WF_FILES[@]}" -gt 0 ]; then
  SCAN_FILES+=("${WF_FILES[@]}")
fi

STALE="$(awk -v REF="$REF" -v SLUG="$SLUG" '
  function mentions_platform(l) {
    if (index(l, SLUG) > 0) return 1
    if (index(l, "platform_ref") > 0) return 1
    if (index(l, "cms-platform-theme") > 0) return 1
    if (l ~ /^[[:space:]]*tag:[[:space:]]/) return 1
    return 0
  }
  {
    if (!mentions_platform($0)) next
    s = $0
    while (match(s, /v[0-9]+\.[0-9]+\.[0-9]+/)) {
      tok = substr(s, RSTART, RLENGTH)
      if (tok != REF) printf "  %s:%d: %s (expected %s)\n", FILENAME, FNR, tok, REF
      s = substr(s, RSTART + RLENGTH)
    }
  }
' "${SCAN_FILES[@]}")"
if [ -n "$STALE" ]; then
  echo "$STALE"
  fail "stale platform ref(s) survive — every platform-version reference must be ${REF}" \
    "$(printf '%s\n' "$STALE" | grep -c .)"
fi
ok "no stale platform ref in platform.lock / Gemfile* / .github/workflows (canonical ${REF})"

# ── 3. every workflow parses as YAML ─────────────────────────────────────────
# A missing node or a missing `yaml` lib is a hard FAIL, never a skip: a check
# that quietly does not run is the defect this whole script exists to prevent.
[ "${#WF_FILES[@]}" -gt 0 ] || fail "no workflow files under .github/workflows — run this from a CONSUMER repo root"
command -v node >/dev/null 2>&1 || fail "node not found — required to parse workflow YAML (this check must not be skipped)"
[ -d "$YAML_LIB" ] || fail "no yaml lib at ${YAML_LIB} — run 'cd ${PLATFORM_DIR}/e2e && npm ci' (this check must not be skipped)"
node -e '
const path = require("node:path");
const fs = require("node:fs");
const YAML = require(path.resolve(process.argv[1]));
let bad = 0;
for (const f of process.argv.slice(2)) {
  try {
    YAML.parse(fs.readFileSync(f, "utf8"));
  } catch (e) {
    console.log(`  ${f}: ${String(e.message).split("\n")[0]}`);
    bad += 1;
  }
}
process.exit(bad ? 1 : 0);
' "$YAML_LIB" "${WF_FILES[@]}" || fail "workflow YAML does not parse (see above)"
ok "all ${#WF_FILES[@]} workflow file(s) parse as YAML"

# ── 4. the authoritative guard, with parity actually verified ────────────────
node "$CHECKER" --require-canonical --canonical-workflows "$CANONICAL" ||
  fail "check-platform-pin-consistency.js failed (see its per-file report above)"
ok "check-platform-pin-consistency.js passed with --require-canonical"

echo "verify-consumer-pins: PASS"
