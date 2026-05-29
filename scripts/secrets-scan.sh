#!/usr/bin/env bash
# Pre-commit secret scanner. Runs gitleaks against the staged diff using the
# repo-level .gitleaks.toml — the same tool and configuration as the
# secrets-scan CI job (.github/workflows/secrets-scan.yml), so a leak that
# would block a PR also blocks the commit that introduces it before it
# reaches local git history (and reflog, which survives a force-push).
#
# Bypass for emergencies: SKIP_SECRETS_SCAN=1 git commit ...
# (Prefer that over `git commit --no-verify`, which also disables every
# other pre-commit guard registered on this repo.)
set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT" || exit 1

if [[ "${SKIP_SECRETS_SCAN:-}" == "1" ]]; then
  echo "secrets scan: SKIP_SECRETS_SCAN=1, skipping" >&2
  exit 0
fi

# Single source of truth: parse the version pinned in the CI workflow so
# bumping GITLEAKS_VERSION there automatically updates the local check.
WORKFLOW=".github/workflows/secrets-scan.yml"
EXPECTED_VERSION=""
if [[ -f "$WORKFLOW" ]]; then
  EXPECTED_VERSION="$(grep -E "^[[:space:]]*GITLEAKS_VERSION:" "$WORKFLOW" \
    | head -1 \
    | sed -E "s/.*['\"]([0-9.]+)['\"].*/\1/")"
fi

if ! command -v gitleaks >/dev/null 2>&1; then
  cat >&2 <<EOF
secrets scan: FAIL — gitleaks is not installed.

Install it before committing:
  macOS:    brew install gitleaks
  Linux:    https://github.com/gitleaks/gitleaks/releases${EXPECTED_VERSION:+ (v$EXPECTED_VERSION)}
  Windows:  scoop install gitleaks  (or download the release)

CI uses gitleaks${EXPECTED_VERSION:+ v$EXPECTED_VERSION}; matching the local version
avoids ruleset drift between the hook and the PR gate.

To bypass for one commit (emergency only — CI will still scan the PR):
  SKIP_SECRETS_SCAN=1 git commit ...
EOF
  exit 1
fi

# Soft-warn on version drift. Don't block: the local binary may be newer
# than CI's pin, in which case the developer just sees stricter rules.
if [[ -n "$EXPECTED_VERSION" ]]; then
  actual_version="$(gitleaks version 2>/dev/null | head -1 | awk '{print $NF}' | sed 's/^v//')"
  if [[ -n "$actual_version" && "$actual_version" != "$EXPECTED_VERSION" ]]; then
    echo "secrets scan: warning — local gitleaks $actual_version != CI v$EXPECTED_VERSION" >&2
  fi
fi

# `protect --staged` scans only what's about to be committed (index vs HEAD),
# matching CI's diff-on-PR behaviour. --redact masks any matched secret in
# the printed output so it doesn't leak into shell history or screenshots.
# .gitleaks.toml at the repo root is auto-discovered.
if ! gitleaks protect --staged --redact; then
  cat >&2 <<'EOF'

secrets scan: gitleaks found candidate secrets in your staged changes.

If a finding is a true positive, remove the secret from the staged content
(and rotate it if it was ever real).

If a finding is a false positive (e.g. a test fixture), add an allowlist
entry to .gitleaks.toml rather than disabling the hook — see the existing
entries for the established pattern.

To bypass for one commit (emergency only — CI will still scan the PR):
  SKIP_SECRETS_SCAN=1 git commit ...
EOF
  exit 1
fi

echo "secrets scan: OK"
