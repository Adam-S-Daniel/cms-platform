#!/usr/bin/env bash
# set-repo-variables.sh — set a consumer site's GitHub Actions *repository
# variables* (the non-secret config the reusable workflows read via `vars.*`),
# derived from the SINGLE source of truth in infrastructure/site-params.env so
# no value is ever typed twice. Idempotent: `gh variable set` upserts.
#
# Usage (the scaffolder's nextSteps points here):
#   set -a; source infrastructure/site-params.env; set +a
#   bash <cms-platform>/scripts/set-repo-variables.sh
# or let the script source the env file itself:
#   bash <cms-platform>/scripts/set-repo-variables.sh --env-file infrastructure/site-params.env
#
# Flags:
#   --env-file PATH    source PATH before deriving (default: env already in scope)
#   --repo OWNER/REPO  override target (default: ${GITHUB_ORG:-Adam-S-Daniel}/$GITHUB_REPO)
#   --dry-run          print what WOULD be set; make no gh calls
#   -h | --help        show this header
#
# Variables set — every value derives from APEX_DOMAIN (+ the same optional
# knobs infrastructure/bootstrap/deploy.sh already reads), so nothing here
# repeats a value defined elsewhere:
#   CMS_APEX        = $APEX_DOMAIN
#   CMS_PROD_URL    = https://$APEX_DOMAIN
#   PREVIEW_BUCKET  = <prefix>-previews          (prefix = APEX_DOMAIN, dots->hyphens)
#   AWS_REGION      = ${AWS_REGION:-us-east-1}
#   PROD_PLAYGROUND_MODE = only when explicitly set (true on a throwaway sandbox
#                          site; leave UNSET on a real prod site so the
#                          prod-mutate loop stays in safe report-only mode).
#   CMS_AUTOMATION_APP_ID = only when explicitly set — the CMS automation
#                          GitHub App's Client ID, read by platform-bump and
#                          dev-hooks-sync (#238): with its private key set as a
#                          secret, the reusables mint a per-run installation
#                          token and CMS_PLATFORM_PAT is never read.
#                          Deliberately a VARIABLE, not a secret, so it can be
#                          read while troubleshooting.
#                          The App's PRIVATE KEY is a SECRET
#                          (CMS_AUTOMATION_APP_PRIVATE_KEY) and is therefore NOT
#                          settable here — set it with `gh secret set`. This
#                          script targets CONSUMERS; cms-platform's own value is
#                          set by hand.
set -euo pipefail

ENV_FILE=""
REPO_OVERRIDE=""
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) ENV_FILE="${2:?--env-file needs a path}"; shift 2 ;;
    --repo)     REPO_OVERRIDE="${2:?--repo needs OWNER/REPO}"; shift 2 ;;
    --dry-run)  DRY_RUN=1; shift ;;
    -h|--help)  sed -n '2,37p' "$0"; exit 0 ;;
    *) echo "set-repo-variables: unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ -n "$ENV_FILE" ]; then
  [ -f "$ENV_FILE" ] || { echo "set-repo-variables: env file not found: $ENV_FILE" >&2; exit 1; }
  set -a
  # shellcheck disable=SC1090  # path is provided at runtime by the caller
  . "$ENV_FILE"
  set +a
fi

: "${APEX_DOMAIN:?set-repo-variables: APEX_DOMAIN is required (source site-params.env first, or pass --env-file)}"
: "${GITHUB_REPO:?set-repo-variables: GITHUB_REPO is required (source site-params.env first, or pass --env-file)}"

OWNER_REPO="${REPO_OVERRIDE:-${GITHUB_ORG:-Adam-S-Daniel}/${GITHUB_REPO}}"

# Derivations — single source = APEX_DOMAIN. The prefix + region defaults MATCH
# infrastructure/bootstrap/deploy.sh (RESOURCE_PREFIX = apex with dots->hyphens,
# AWS_REGION default us-east-1) so the two can never disagree.
PREFIX="${RESOURCE_PREFIX:-${APEX_DOMAIN//./-}}"
REGION="${AWS_REGION:-us-east-1}"

names=(CMS_APEX CMS_PROD_URL PREVIEW_BUCKET AWS_REGION)
values=("$APEX_DOMAIN" "https://$APEX_DOMAIN" "${PREFIX}-previews" "$REGION")

# PROD_PLAYGROUND_MODE is opt-in: only push it when the env explicitly sets it.
if [ -n "${PROD_PLAYGROUND_MODE:-}" ]; then
  names+=(PROD_PLAYGROUND_MODE)
  values+=("$PROD_PLAYGROUND_MODE")
fi

# CMS_AUTOMATION_APP_ID is opt-in too — the second NON-DERIVED passthrough (it
# comes from a GitHub App, not from APEX_DOMAIN). platform-bump + dev-hooks-sync
# read it (#238); its companion CMS_AUTOMATION_APP_PRIVATE_KEY is a SECRET, so
# it is not settable here.
if [ -n "${CMS_AUTOMATION_APP_ID:-}" ]; then
  names+=(CMS_AUTOMATION_APP_ID)
  values+=("$CMS_AUTOMATION_APP_ID")
fi

suffix=""
if [ "$DRY_RUN" = 1 ]; then suffix="  (dry-run)"; fi
echo "set-repo-variables: target ${OWNER_REPO}${suffix}"

for i in "${!names[@]}"; do
  name="${names[$i]}"
  value="${values[$i]}"
  echo "  ${name}=${value}"
  if [ "$DRY_RUN" = 1 ]; then
    echo "    + gh variable set ${name} --body '${value}' -R ${OWNER_REPO}"
  else
    gh variable set "$name" --body "$value" -R "$OWNER_REPO"
  fi
done

echo "set-repo-variables: done (${#names[@]} variables)"
