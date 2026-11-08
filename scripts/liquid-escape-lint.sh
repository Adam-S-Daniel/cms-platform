#!/usr/bin/env bash
#
# Pre-commit: run scripts/liquid-escape-lint.rb over the STAGED .html/.xml
# templates. Every Liquid `{{ ... }}` must end in a filter that encodes for
# where it prints (see the .rb file's header). It parses with the `liquid`
# gem, so it uses the repo's bundle when that is installed and plain ruby
# otherwise; with neither ruby nor the gem it prints a notice and skips, since
# CI (site-verify.yml) is the hard gate.
#
# Bypass for one commit (emergency only — CI still lints the PR):
#   SKIP_LIQUID_ESCAPE_LINT=1 git commit ...
set -euo pipefail

if [ "${SKIP_LIQUID_ESCAPE_LINT:-}" = "1" ]; then
  echo "liquid-escape-lint: skipped (SKIP_LIQUID_ESCAPE_LINT=1)"
  exit 0
fi

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

if ! command -v ruby >/dev/null 2>&1; then
  echo "liquid-escape-lint: ruby not installed — skipping (CI will lint it)"
  exit 0
fi

if [ -f Gemfile ] && command -v bundle >/dev/null 2>&1 && bundle check >/dev/null 2>&1; then
  exec bundle exec ruby scripts/liquid-escape-lint.rb --staged
fi
exec ruby scripts/liquid-escape-lint.rb --staged
