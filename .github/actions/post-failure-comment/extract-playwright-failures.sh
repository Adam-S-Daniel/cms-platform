#!/usr/bin/env bash
#
# Extract just the failure blocks from a captured Playwright run log.
# Each failure block runs from a `  N) ` header line through (but
# not including) the next failure header or the summary line. Caps
# total output at ~200KB before scrubbing — the workflow further
# truncates to fit a GitHub comment.
#
# Usage: extract-playwright-failures.sh <log-file> > <out-file>

set -euo pipefail

LOG="${1:?usage: extract-playwright-failures.sh <log-file>}"

if [ ! -f "$LOG" ]; then
  echo "log file not found: $LOG" >&2
  exit 0
fi

awk '
  # Toggle into "capturing" when we see a numbered failure header.
  /^  [0-9]+\) / { capture = 1 }

  # Toggle out when the per-test summary line lands.
  /^  [0-9]+ failed$/ { capture = 0 }

  # `  N skipped` and `  N passed` lines are summary; stop on them
  # to avoid pulling the whole tail.
  /^  [0-9]+ (skipped|passed)/ { capture = 0 }

  capture { print }
' "$LOG" | head -c 200000
