#!/usr/bin/env bash
#
# Pre-commit lint of STAGED files only — a fast "shift-left" mirror of the
# code-quality.yml CI gate. Each language's linter runs solely on the files
# of that language staged in this commit, and ONLY if its tool is on PATH;
# a missing tool prints a one-line notice and is skipped (CI is the hard
# gate, so a contributor without the full toolchain is never blocked).
#
# Bypass for one commit (emergency only — CI still lints the PR):
#   SKIP_LINT_STAGED=1 git commit ...
set -euo pipefail

if [ "${SKIP_LINT_STAGED:-}" = "1" ]; then
  echo "lint-staged: skipped (SKIP_LINT_STAGED=1)"
  exit 0
fi

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

# Staged files added/copied/modified (not deletions), NUL-safe.
mapfile -d '' STAGED < <(git diff --cached --name-only --diff-filter=ACM -z)
[ "${#STAGED[@]}" -eq 0 ] && exit 0

# filter <regex> — emit staged paths matching the extended regex.
filter() {
  local f
  for f in "${STAGED[@]}"; do
    printf '%s\n' "$f" | grep -qE "$1" && printf '%s\n' "$f"
  done
}

have() { command -v "$1" >/dev/null 2>&1; }
RC=0
note() { echo "lint-staged: $1 not installed — skipping (CI will lint it)"; }

# ── JavaScript: eslint + prettier ────────────────────────────────────
mapfile -t JS < <(filter '(^|/)(e2e|admin|scripts)/.*\.js$|\.config\.js$')
if [ "${#JS[@]}" -gt 0 ]; then
  if [ -x node_modules/.bin/eslint ]; then
    node_modules/.bin/eslint "${JS[@]}" || RC=1
    node_modules/.bin/prettier --check "${JS[@]}" || RC=1
  else
    note "eslint/prettier (run 'npm ci')"
  fi
fi

# ── Python: ruff (lint + format) ─────────────────────────────────────
mapfile -t PY < <(filter '\.py$')
if [ "${#PY[@]}" -gt 0 ]; then
  if have ruff; then
    ruff check "${PY[@]}" || RC=1
    ruff format --check "${PY[@]}" || RC=1
  else
    note ruff
  fi
fi

# ── Ruby: rubocop ────────────────────────────────────────────────────
mapfile -t RB < <(filter '^_plugins(_test)?/.*\.rb$')
if [ "${#RB[@]}" -gt 0 ]; then
  if have rubocop; then
    rubocop --force-exclusion "${RB[@]}" || RC=1
  else
    note rubocop
  fi
fi

# ── Shell: shellcheck + shfmt ────────────────────────────────────────
mapfile -t SH < <(filter '\.sh$')
if [ "${#SH[@]}" -gt 0 ]; then
  if have shellcheck; then shellcheck "${SH[@]}" || RC=1; else note shellcheck; fi
  if have shfmt; then shfmt -i 2 -ci -bn -d "${SH[@]}" || RC=1; else note shfmt; fi
fi

# ── CSS: stylelint ───────────────────────────────────────────────────
mapfile -t CSS < <(filter '\.css$')
if [ "${#CSS[@]}" -gt 0 ]; then
  if [ -x node_modules/.bin/stylelint ]; then
    node_modules/.bin/stylelint "${CSS[@]}" || RC=1
  else
    note "stylelint (run 'npm ci')"
  fi
fi

if [ "$RC" -ne 0 ]; then
  echo "lint-staged: FAIL — fix the issues above or bypass with SKIP_LINT_STAGED=1 (CI still lints)."
fi
exit "$RC"
