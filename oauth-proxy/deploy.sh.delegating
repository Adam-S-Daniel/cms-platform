#!/usr/bin/env bash
# =============================================================================
# deploy.sh — Deploy the CMS OAuth proxy (DELEGATING WRAPPER)
# =============================================================================
#
# This is the file the scaffolder (scaffold/create-site.js) emits into a NEW
# consuming site as `oauth-proxy/deploy.sh`. The site does NOT vendor the OAuth
# proxy's lambda.py / template.yaml — those are the single source of truth in
# cms-platform, so a fix made there (e.g. the /prod/health handler) flows to
# every consumer on the next platform_ref bump instead of being forked.
#
# How it works (mirrors infrastructure/bootstrap/deploy.sh + the repo-wide
# ".cms-platform/ checkout-at-platform_ref" pattern the reusable-workflow
# callers use):
#   1. Read platform_repo + platform_ref from platform.lock.
#   2. Check the platform out at that ref into .cms-platform/ (a dot-dir Jekyll
#      ignores; gitignored — never committed).
#   3. Source infrastructure/site-params.env for the OAuth app id/secret +
#      ALLOWED_ORIGINS + STACK_NAME, then delegate to the platform's
#      .cms-platform/oauth-proxy/deploy.sh (sam build + deploy of the platform
#      template under THIS site's stack name).
#
# Default GitHub OAuth scope is `repo,user,workflow` (the platform default).
# IMPORTANT: if a redeploy WIDENS the scope your live OAuth App was authorized
# with, the OAuth App owner must MANUALLY re-consent (re-authorize the app)
# once — that is a human step GitHub requires; it cannot be automated.
#
# Prerequisites: AWS CLI v2, AWS SAM CLI, git, AWS credentials, a GitHub OAuth
# App, and a filled-in infrastructure/site-params.env (copy from
# infrastructure/site-params.env.example / the platform example).
#
# Usage:
#   bash oauth-proxy/deploy.sh
# (Idempotent — safe to re-run; an in-place stack update keeps the same
#  API Gateway endpoint, so _config.yml cms.oauth_base_url is unchanged.)
# =============================================================================

set -euo pipefail

BLUE='\033[0;34m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info() { echo -e "${BLUE}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

command -v aws >/dev/null 2>&1 || error "AWS CLI not found."
command -v git >/dev/null 2>&1 || error "git not found — needed to check out the cms-platform OAuth proxy."

# ── Locate repo root + platform.lock (oauth-proxy/ is ONE level below root) ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCK_FILE="$REPO_ROOT/platform.lock"
[[ -f "$LOCK_FILE" ]] || error "platform.lock not found at $LOCK_FILE"

read_lock() {
  # shellcheck disable=SC2016  # awk field refs ($1/$2), not shell expansion.
  awk -v k="$1" '$1==k":" {print $2; exit}' "$LOCK_FILE"
}
PLATFORM_REPO="${PLATFORM_REPO:-$(read_lock platform_repo)}"
PLATFORM_REF="${PLATFORM_REF:-$(read_lock platform_ref)}"
[[ -n "$PLATFORM_REPO" ]] || error "platform_repo not found in $LOCK_FILE"
[[ -n "$PLATFORM_REF" ]] || error "platform_ref not found in $LOCK_FILE"

# ── Load site parameters (OAuth id/secret, ALLOWED_ORIGINS, STACK_NAME) ─────
# Pre-exported env wins; otherwise source the (gitignored) site-params.env.
PARAMS_FILE="$REPO_ROOT/infrastructure/site-params.env"
if [[ -f "$PARAMS_FILE" ]]; then
  info "Sourcing $PARAMS_FILE"
  set -a; # shellcheck disable=SC1090
  source "$PARAMS_FILE"; set +a
else
  warn "infrastructure/site-params.env not found — relying on already-exported env (GITHUB_CLIENT_ID/SECRET, ALLOWED_ORIGINS, STACK_NAME)."
fi

# ── Check the platform out at platform_ref into .cms-platform/ ──────────────
PLATFORM_DIR="$REPO_ROOT/.cms-platform"
PLATFORM_URL="${PLATFORM_URL:-https://github.com/${PLATFORM_REPO}.git}"
info "Platform: ${PLATFORM_REPO}@${PLATFORM_REF}"
info "Checking platform out into .cms-platform/ …"
rm -rf "$PLATFORM_DIR"
git clone --quiet --depth 1 --branch "$PLATFORM_REF" "$PLATFORM_URL" "$PLATFORM_DIR" \
  || error "Failed to check out ${PLATFORM_REPO}@${PLATFORM_REF} into .cms-platform/"

PLATFORM_DEPLOY="$PLATFORM_DIR/oauth-proxy/deploy.sh"
PLATFORM_TEMPLATE="$PLATFORM_DIR/oauth-proxy/template.yaml"
[[ -f "$PLATFORM_TEMPLATE" ]] || error "Platform OAuth template missing: $PLATFORM_TEMPLATE"
[[ -f "$PLATFORM_DEPLOY" ]] || error "Platform OAuth deploy script missing: $PLATFORM_DEPLOY"
success "Platform checked out — deploying $PLATFORM_TEMPLATE under stack ${STACK_NAME:-<STACK_NAME unset>}"

# ── Delegate to the platform's oauth-proxy deploy.sh ───────────────────────
# It cd's into its own dir, sam build/deploy's ./template.yaml under STACK_NAME
# (defaults FUNCTION_NAME=STACK_NAME, GITHUB_SCOPE=repo,user,workflow), and
# prints the ApiUrl to put in _config.yml cms.oauth_base_url.
exec bash "$PLATFORM_DEPLOY"
