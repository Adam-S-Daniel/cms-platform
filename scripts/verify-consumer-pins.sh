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
#      Gemfile.lock / .github/workflows/ — i.e. no stale pin. This is the most
#      GENERAL pin rule in the repo (it reads LINES, so it sees a trailing
#      `# vX.Y.Z` comment that a parse-only walk cannot), and it now lives in
#      scripts/stale-platform-refs.js so the scaffold-template guard can apply
#      the SAME code to examples/site before a site is ever generated from it —
#      instead of re-implementing an approximation that goes green exactly where
#      this script goes red. Was an inline `awk`; output format is unchanged
#      (verified byte-identical against the awk it replaced).
#   3. Every .github/workflows file parses as YAML.
#   4. check-platform-pin-consistency.js passes with --require-canonical, which
#      is what makes workflow-SET + workflow-CONTENT parity actually RUN. Without
#      it the guard skips both and still EXITS 0 — which is the whole reason the
#      flag exists. It is not silent about it, and has not been since the summary
#      was hardened: a degraded run prints a "workflow-set parity skipped" notice
#      and ends "Pin references are consistent; parity is UNVERIFIED", never the
#      words "Pins are consistent" (see `okSummary`). It USED to report a clean
#      consistent verdict, and that is the incident the flag was added for. Pass
#      the flag anyway: a notice on an exit-0 run is a thing CI does not fail on
#      and a human scrolls past, so "loud" is not the same as "enforced".
#      NO CHECK COUNT IS NAMED HERE ON PURPOSE. This header used to advertise
#      "all 96 checks ... degrades to 61", and both numbers were wrong by the
#      time anyone read them: the count is DERIVED from how many pin references
#      the consumer's tree carries, so it moves with every workflow added or
#      removed. Measured 2026-08-20 against platform_ref v0.1.86: 90 with the
#      canonical set on BOTH adamdaniel.ai and jodidaniel.com, 57 without.
#      A number in a comment cannot be kept true; the script prints the real one
#      on every run ("all N platform-consistency check(s)"), so read it there.
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
      # Print the header by finding where it ENDS, never by a line number. A
      # hardcoded range was '1,26p' against a 33-line header, so `--help`
      # truncated mid-sentence inside "WHAT IT CHECKS" and never reached USAGE.
      # Replacing one stale number with a fresh one just resets that clock — and
      # would contradict item 4 above, which argues a number in a comment cannot
      # be kept true. This form re-measures on every run.
      sed -n '/^set -euo pipefail/q;p' "$0"
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
SCANNER="${PLATFORM_DIR}/scripts/stale-platform-refs.js"
CANONICAL="${PLATFORM_DIR}/examples/site/.github/workflows"
YAML_LIB="${PLATFORM_DIR}/e2e/node_modules/yaml"

# ── 0. the platform tree we were pointed at must actually hold the machinery ──
# node moved UP here from check 3: check 2 now runs the shared scanner, and a
# missing interpreter must be a hard FAIL at the point of use, never a check
# that quietly does not run.
[ -f "$CHECKER" ] || fail "no checker at ${CHECKER} — pass --platform-dir <cms-platform checkout>"
[ -f "$SCANNER" ] ||
  fail "no stale-ref scanner at ${SCANNER} — pass --platform-dir <checkout>"
[ -d "$CANONICAL" ] || fail "no canonical workflow set at ${CANONICAL} — pass --platform-dir <cms-platform checkout>"
command -v node >/dev/null 2>&1 ||
  fail "node not found — required to scan pins and parse workflow YAML (must not be skipped)"
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

# The scanner is three-valued so "found drift" and "could not run" stay distinct:
# 0 clean, 1 stale token(s) printed, 2 could not run. The status is captured with
# an `if` (which `set -e` tolerates) rather than a swallowing `||` fallback — a
# check that can quietly not-run is the exact defect this script exists to
# prevent, and its own structure lint forbids those idioms outright.
if STALE="$(node "$SCANNER" --ref "$REF" --slug "$SLUG" -- "${SCAN_FILES[@]}")"; then
  SCAN_RC=0
else
  SCAN_RC=$?
fi
if [ "$SCAN_RC" -gt 1 ]; then
  fail "stale-ref scan could not run (scanner exited ${SCAN_RC}) — must not be skipped"
fi
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
