#!/usr/bin/env bash
# =============================================================================
# deploy.sh — Bootstrap AWS account for a platform site's CI/CD
# =============================================================================
#
# One-time setup that creates:
#   1. S3 bucket for CloudFormation/SAM deployment artifacts
#   2. GitHub OIDC identity provider in AWS IAM
#   3. IAM role for GitHub Actions (assumed via OIDC — no long-lived keys)
#
# Prerequisites:
#   • AWS CLI v2  (aws --version)
#   • AWS credentials configured (aws configure or IAM role)
#   • Ruby (its standard-library YAML parser minifies the template) and python3
#
# Usage:
#   bash infrastructure/bootstrap/deploy.sh
#
# If a GitHub OIDC provider already exists in this account:
#   CREATE_OIDC_PROVIDER=false bash infrastructure/bootstrap/deploy.sh
#
# STACK_NAME defaults to <prefix>-bootstrap. site-params.env exports STACK_NAME
# for the OAuth proxy stack, so after sourcing it run this script as
#   STACK_NAME= bash infrastructure/bootstrap/deploy.sh
# or it aims the bootstrap template at the proxy stack (the guard below then
# refuses, because every proxy resource would be removed).
#
# Template size: template.yaml is over the AWS CLI's 51,200-byte inline limit
# as written, because of its comments. The script deploys a minified copy
# (minify-template.rb: a real YAML parse and re-emit that keeps every tag and
# value) and stops, before any AWS call, if that copy is still over the limit.
#
# Destructive-change guard: the script creates a change set instead of
# deploying directly, prints every resource action, and refuses to execute it
# when any resource would be removed or replaced, unless the operator sets
#   ALLOW_DESTRUCTIVE_CHANGES=1 bash infrastructure/bootstrap/deploy.sh
# A refused change set is left in place for review; nothing is changed.
#
# This script is idempotent — safe to re-run at any time.
# =============================================================================

set -euo pipefail

# Site parameters. Export per site (the scaffolder writes these); only
# GITHUB_REPO + APEX_DOMAIN are required, the rest derive sensibly.
GITHUB_ORG="${GITHUB_ORG:-Adam-S-Daniel}"
GITHUB_REPO="${GITHUB_REPO:?set GITHUB_REPO, e.g. example.com}"
APEX_DOMAIN="${APEX_DOMAIN:?set APEX_DOMAIN, e.g. example.com}"
RESOURCE_PREFIX="${RESOURCE_PREFIX:-$(printf '%s' "$APEX_DOMAIN" | tr '.' '-')}"
ARTIFACT_BUCKET="${ARTIFACT_BUCKET:-${RESOURCE_PREFIX}-cfn-artifacts}"
PREVIEW_BUCKET="${PREVIEW_BUCKET:-${RESOURCE_PREFIX}-previews}"
PRODUCTION_BUCKET="${PRODUCTION_BUCKET:-${RESOURCE_PREFIX}-production}"
# Deliberately NOT defaulted to "${RESOURCE_PREFIX}-media-archive": unlike the
# three buckets above, this one is opt-in. Defaulting it would hand every
# existing site a new bucket on its next bootstrap redeploy, which nobody asked
# for. Set it to opt in; see docs/MEDIA-ARCHIVE.md.
MEDIA_ARCHIVE_BUCKET="${MEDIA_ARCHIVE_BUCKET:-}"
# OPTIONAL editor host on its own origin, e.g. admin.<apex> (#517). Unset = off;
# a redeploy WITHOUT it removes a host that was set. See
# docs/ADMIN-AUTH-SECURITY.md.
ADMIN_DOMAIN="${ADMIN_DOMAIN:-}"
PREVIEW_DOMAIN="${PREVIEW_DOMAIN:-*.${APEX_DOMAIN}}"
STACK_NAME="${STACK_NAME:-${RESOURCE_PREFIX}-bootstrap}"
AWS_REGION="${AWS_REGION:-us-east-1}"
CREATE_OIDC_PROVIDER="${CREATE_OIDC_PROVIDER:-true}"
HOSTED_ZONE_ID="${HOSTED_ZONE_ID:-}"
# Security headers (cms-platform#515); defaults match the template's. See
# docs/ADMIN-AUTH-SECURITY.md before widening HSTS_SCOPE or enforcing the CSP.
HSTS_MAX_AGE_SECONDS="${HSTS_MAX_AGE_SECONDS:-31536000}"
HSTS_SCOPE="${HSTS_SCOPE:-this-host-only}"
ADMIN_CSP_MODE="${ADMIN_CSP_MODE:-report-only}"
# The AWS CLI's (and CloudFormation's) limit on a template sent inline.
INLINE_LIMIT_BYTES=51200

# ── Colour output ──────────────────────────────────────────────────────────
BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info() { echo -e "${BLUE}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() {
  echo -e "${RED}[ERROR]${NC} $*" >&2
  exit 1
}

# ── Validate prerequisites ─────────────────────────────────────────────────
command -v aws >/dev/null 2>&1 || error "AWS CLI not found. Install: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
command -v ruby >/dev/null 2>&1 || error "Ruby not found. It minifies the template before the deploy (the platform's Jekyll toolchain already needs it)."
command -v python3 >/dev/null 2>&1 || error "python3 not found. It reads the change set before anything is executed."

# ── Move to script directory ───────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Minify the template so it can be sent inline ───────────────────────────
# Done before ANY aws call, so an over-size template stops here with nothing
# touched. minify-template.rb refuses itself if its output would parse to
# anything other than the original (tags, values, block scalars).
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
DEPLOY_TEMPLATE="${WORK_DIR}/template.yaml"
ruby minify-template.rb template.yaml "$DEPLOY_TEMPLATE" \
  || error "Could not minify template.yaml (see the message above); nothing was deployed."
TEMPLATE_BYTES="$(wc -c <"$DEPLOY_TEMPLATE")"
TEMPLATE_BYTES="${TEMPLATE_BYTES//[[:space:]]/}"
if ((TEMPLATE_BYTES > INLINE_LIMIT_BYTES)); then
  error "The minified template is ${TEMPLATE_BYTES} bytes, over the ${INLINE_LIMIT_BYTES}-byte limit for a template sent inline; nothing was deployed. Shrink template.yaml (comments do not count, everything else does)."
fi

info "Deploying stack: ${STACK_NAME} to ${AWS_REGION}"
info "Template: ${TEMPLATE_BYTES} bytes minified (inline limit ${INLINE_LIMIT_BYTES})"
info "Create OIDC provider: ${CREATE_OIDC_PROVIDER}"
info "Admin CSP mode: ${ADMIN_CSP_MODE}; HSTS: max-age=${HSTS_MAX_AGE_SECONDS}, ${HSTS_SCOPE}"

# ── Auto-detect Route53 hosted zone if not specified ───────────────────────
if [[ -z "$HOSTED_ZONE_ID" ]]; then
  info "Looking up Route53 hosted zone for ${APEX_DOMAIN}…"
  HOSTED_ZONE_ID=$(aws route53 list-hosted-zones-by-name \
    --dns-name "${APEX_DOMAIN}" \
    --query "HostedZones[?Name=='${APEX_DOMAIN}.'].Id" \
    --output text | sed 's|/hostedzone/||')
  [[ -z "$HOSTED_ZONE_ID" ]] && error "No Route53 hosted zone found for ${APEX_DOMAIN}. Set HOSTED_ZONE_ID manually."
  info "Found hosted zone: ${HOSTED_ZONE_ID}"
fi

# ── Create the change set (never executed blind) ───────────────────────────
# Every parameter is passed explicitly from this script's defaults, so a run
# with a missing setting (CREATE_APEX_DNS_RECORDS, ADMIN_DOMAIN, a STACK_NAME
# meant for another stack) can remove live resources. The change set is read
# back below and refused if anything would be removed or replaced.
info "Creating change set for ${STACK_NAME}…"
CHANGESET_OUTPUT="$(aws cloudformation deploy \
  --template-file "$DEPLOY_TEMPLATE" \
  --stack-name "$STACK_NAME" \
  --region "$AWS_REGION" \
  --capabilities CAPABILITY_NAMED_IAM \
  --no-execute-changeset \
  --no-fail-on-empty-changeset \
  --parameter-overrides \
  "GitHubOrg=${GITHUB_ORG}" \
  "GitHubRepo=${GITHUB_REPO}" \
  "ResourcePrefix=${RESOURCE_PREFIX}" \
  "ArtifactBucketName=${ARTIFACT_BUCKET}" \
  "PreviewBucketName=${PREVIEW_BUCKET}" \
  "ProductionBucketName=${PRODUCTION_BUCKET}" \
  "ProductionDomainName=${APEX_DOMAIN}" \
  "CreateOIDCProvider=${CREATE_OIDC_PROVIDER}" \
  "CreateApexDnsRecords=${CREATE_APEX_DNS_RECORDS:-false}" \
  "HostedZoneId=${HOSTED_ZONE_ID}" \
  "PreviewDomainName=${PREVIEW_DOMAIN}" \
  "MediaArchiveBucketName=${MEDIA_ARCHIVE_BUCKET}" \
  "AdminDomainName=${ADMIN_DOMAIN}" \
  "HstsMaxAgeSeconds=${HSTS_MAX_AGE_SECONDS}" \
  "HstsScope=${HSTS_SCOPE}" \
  "AdminCspMode=${ADMIN_CSP_MODE}")" \
  || error "Creating the change set failed (see the AWS CLI message above); nothing was executed."

# --no-execute-changeset prints the new change set's ARN; an empty change set
# prints "No changes to deploy" instead and exits 0.
CHANGESET_ARN_RE='(arn:aws[a-z-]*:cloudformation:[a-z0-9-]+:[0-9]+:changeSet/[^[:space:]]+)'
if [[ "$CHANGESET_OUTPUT" =~ $CHANGESET_ARN_RE ]]; then
  CHANGESET_ARN="${BASH_REMATCH[1]}"
elif [[ "$CHANGESET_OUTPUT" == *"No changes to deploy"* ]]; then
  CHANGESET_ARN=""
  success "No changes to deploy: stack ${STACK_NAME} is up to date."
else
  error "Could not find the change set ARN in the AWS CLI output, so nothing was executed."
fi

if [[ -n "$CHANGESET_ARN" ]]; then
  CHANGESET_JSON="$(aws cloudformation describe-change-set \
    --change-set-name "$CHANGESET_ARN" \
    --region "$AWS_REGION" \
    --output json)" \
    || error "Could not read change set ${CHANGESET_ARN}, so nothing was executed."

  # Print one line per resource action; exit 3 if any is destructive, 4 if
  # the response cannot be trusted to list every change. Fails closed: only an
  # Add, Modify or Import that replaces nothing counts as safe, so an unknown
  # or missing action (a Remove the guard cannot see, a nested stack's
  # Dynamic) is refused too.
  info "Change set for ${STACK_NAME}:"
  GUARD_STATUS=0
  python3 -c "
import json, sys
data = json.load(sys.stdin)
changes = data.get('Changes') if isinstance(data, dict) else None
# No Changes list, or a NextToken (a page the CLI did not fetch): unreadable.
if not isinstance(changes, list) or data.get('NextToken'):
    sys.exit(4)
destructive = False
for change in changes:
    rc = (change.get('ResourceChange') if isinstance(change, dict) else None) or {}
    action = str(rc.get('Action', '?'))
    replacement = str(rc.get('Replacement', ''))
    line = '  %-8s %s (%s)' % (action, rc.get('LogicalResourceId', '?'), rc.get('ResourceType', '?'))
    if replacement:
        line += ' replacement=' + replacement
    if action not in ('Add', 'Modify', 'Import') or replacement not in ('', 'False'):
        destructive = True
        line += '  <- DESTRUCTIVE'
    print(line)
if not changes:
    print('  (no resource changes)')
sys.exit(3 if destructive else 0)
" <<<"$CHANGESET_JSON" || GUARD_STATUS=$?

  case "$GUARD_STATUS" in
    0) ;;
    3)
      if [[ "${ALLOW_DESTRUCTIVE_CHANGES:-}" == "1" ]]; then
        warn "ALLOW_DESTRUCTIVE_CHANGES=1: executing a change set that removes or replaces resources."
      else
        error "Refusing to execute: the change set above removes or replaces resources (marked DESTRUCTIVE), and nothing was changed. Check STACK_NAME, CREATE_APEX_DNS_RECORDS and ADMIN_DOMAIN first. If the change is intended, re-run with ALLOW_DESTRUCTIVE_CHANGES=1. The change set is left for review: ${CHANGESET_ARN}"
      fi
      ;;
    *) error "Could not read change set ${CHANGESET_ARN}, so nothing was executed." ;;
  esac

  # A change set for a new stack leaves it in REVIEW_IN_PROGRESS until executed.
  STACK_STATUS="$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$AWS_REGION" \
    --query 'Stacks[0].StackStatus' \
    --output text)" \
    || error "Could not read the status of stack ${STACK_NAME}, so nothing was executed."
  if [[ "$STACK_STATUS" == "REVIEW_IN_PROGRESS" ]]; then
    WAITER="stack-create-complete"
  else
    WAITER="stack-update-complete"
  fi

  info "Executing change set…"
  aws cloudformation execute-change-set \
    --change-set-name "$CHANGESET_ARN" \
    --region "$AWS_REGION" \
    || error "Executing change set ${CHANGESET_ARN} failed."
  info "Waiting for ${WAITER}…"
  aws cloudformation wait "$WAITER" \
    --stack-name "$STACK_NAME" \
    --region "$AWS_REGION" \
    || error "Stack ${STACK_NAME} did not reach ${WAITER#stack-}; check its events in the CloudFormation console."
  success "Stack ${STACK_NAME} deployed."
fi

# ── Fetch outputs ──────────────────────────────────────────────────────────
info "Fetching stack outputs…"
OUTPUTS=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$AWS_REGION" \
  --query 'Stacks[0].Outputs' \
  --output json)

ROLE_ARN=$(echo "$OUTPUTS" | python3 -c "
import json, sys
outputs = json.load(sys.stdin)
for o in outputs:
    if o['OutputKey'] == 'RoleArn':
        print(o['OutputValue'])
        break
")

BUCKET_NAME=$(echo "$OUTPUTS" | python3 -c "
import json, sys
outputs = json.load(sys.stdin)
for o in outputs:
    if o['OutputKey'] == 'ArtifactsBucketName':
        print(o['OutputValue'])
        break
")

CF_DISTRIBUTION_ID=$(echo "$OUTPUTS" | python3 -c "
import json, sys
outputs = json.load(sys.stdin)
for o in outputs:
    if o['OutputKey'] == 'PreviewDistributionId':
        print(o['OutputValue'])
        break
")

PREVIEW_URL=$(echo "$OUTPUTS" | python3 -c "
import json, sys
outputs = json.load(sys.stdin)
for o in outputs:
    if o['OutputKey'] == 'PreviewURL':
        print(o['OutputValue'])
        break
")

PROD_CF_DISTRIBUTION_ID=$(echo "$OUTPUTS" | python3 -c "
import json, sys
outputs = json.load(sys.stdin)
for o in outputs:
    if o['OutputKey'] == 'ProductionDistributionId':
        print(o['OutputValue'])
        break
")

PROD_URL=$(echo "$OUTPUTS" | python3 -c "
import json, sys
outputs = json.load(sys.stdin)
for o in outputs:
    if o['OutputKey'] == 'ProductionURL':
        print(o['OutputValue'])
        break
")

# ── Summary ────────────────────────────────────────────────────────────────
echo ""
success "Bootstrap complete!"
echo ""
echo "  ┌─────────────────────────────────────────────────────────────────┐"
echo "  │  Stack outputs                                                  │"
echo "  ├─────────────────────────────────────────────────────────────────┤"
echo "  │                                                                 │"
echo -e "  │  Role ARN:            ${YELLOW}${ROLE_ARN}${NC}"
echo -e "  │  Artifacts bucket:    ${YELLOW}${BUCKET_NAME}${NC}"
echo -e "  │  Preview CF ID:       ${YELLOW}${CF_DISTRIBUTION_ID}${NC}"
echo -e "  │  Preview URL:         ${YELLOW}${PREVIEW_URL}${NC}"
echo -e "  │  Production CF ID:    ${YELLOW}${PROD_CF_DISTRIBUTION_ID}${NC}"
echo -e "  │  Production URL:      ${YELLOW}${PROD_URL}${NC}"
echo "  │                                                                 │"
echo "  ├─────────────────────────────────────────────────────────────────┤"
echo "  │  Next steps                                                     │"
echo "  ├─────────────────────────────────────────────────────────────────┤"
echo "  │                                                                 │"
echo "  │  1. Add these GitHub Actions secrets:                           │"
echo "  │     Repo → Settings → Secrets → Actions → New secret            │"
echo "  │                                                                 │"
echo -e "  │     Name:  ${YELLOW}AWS_ROLE_ARN${NC}"
echo -e "  │     Value: ${YELLOW}${ROLE_ARN}${NC}"
echo "  │                                                                 │"
echo -e "  │     Name:  ${YELLOW}PREVIEW_CLOUDFRONT_ID${NC}"
echo -e "  │     Value: ${YELLOW}${CF_DISTRIBUTION_ID}${NC}"
echo "  │                                                                 │"
echo -e "  │     Name:  ${YELLOW}PRODUCTION_CLOUDFRONT_ID${NC}"
echo -e "  │     Value: ${YELLOW}${PROD_CF_DISTRIBUTION_ID}${NC}"
echo "  │                                                                 │"
echo "  │  2. Remove old access key secrets (after verifying OIDC works): │"
echo -e "  │     Delete: ${YELLOW}AWS_ACCESS_KEY_ID${NC}"
echo -e "  │     Delete: ${YELLOW}AWS_SECRET_ACCESS_KEY${NC}"
echo "  │                                                                 │"
echo "  └─────────────────────────────────────────────────────────────────┘"
echo ""
