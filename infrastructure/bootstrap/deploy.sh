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
#
# Usage:
#   bash infrastructure/bootstrap/deploy.sh
#
# If a GitHub OIDC provider already exists in this account:
#   CREATE_OIDC_PROVIDER=false bash infrastructure/bootstrap/deploy.sh
#
# The template is larger than 51,200 bytes, so the AWS CLI refuses to send it
# inline and it must go through an S3 bucket. On an UPDATE that bucket is the
# stack's own artifact bucket (ARTIFACT_BUCKET), which already exists. The very
# FIRST deploy has no such bucket yet, so name any existing bucket you can
# write to in TEMPLATE_S3_BUCKET (the script never creates one):
#   TEMPLATE_S3_BUCKET=my-existing-bucket bash infrastructure/bootstrap/deploy.sh
# TEMPLATE_S3_BUCKET also overrides the artifact bucket on an update.
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
# Where `aws cloudformation deploy` uploads the (over-51,200-byte) template.
# Empty = use the stack's own artifact bucket, which exists only on an update.
TEMPLATE_S3_BUCKET="${TEMPLATE_S3_BUCKET:-}"
TEMPLATE_S3_PREFIX="bootstrap-templates"

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

# ── Move to script directory ───────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

info "Deploying stack: ${STACK_NAME} to ${AWS_REGION}"
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

# ── Pick the bucket the template is uploaded through ───────────────────────
# template.yaml is over the CLI's 51,200-byte inline limit, so `deploy` needs
# --s3-bucket. The stack's own artifact bucket is the natural home, but only an
# EXISTING stack has it: decide that here, the way oauth-proxy/deploy.sh does.
# A missing stack needs TEMPLATE_S3_BUCKET; any other failure stops the deploy
# rather than guess. The aws error text is never echoed (it can carry account
# detail).
if [[ -z "$TEMPLATE_S3_BUCKET" ]]; then
  if STACK_STATUS="$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$AWS_REGION" \
    --query 'Stacks[0].StackStatus' \
    --output text 2>&1)"; then
    case "$STACK_STATUS" in
      "" | None | REVIEW_IN_PROGRESS | CREATE_FAILED | ROLLBACK_COMPLETE)
        error "Stack ${STACK_NAME} has no artifact bucket to hold the template yet. The template exceeds the AWS CLI's 51,200-byte inline limit, so set TEMPLATE_S3_BUCKET to an existing S3 bucket you can write to, then re-run."
        ;;
    esac
    [[ "$STACK_STATUS" =~ ^[A-Z_]+$ ]] \
      || error "Could not read the status of stack ${STACK_NAME} in ${AWS_REGION}, so the template upload bucket cannot be chosen safely. Re-run, or set TEMPLATE_S3_BUCKET."
    TEMPLATE_S3_BUCKET="$ARTIFACT_BUCKET"
  elif [[ "$STACK_STATUS" == *"Stack with id ${STACK_NAME} does not exist"* ]]; then
    error "Stack ${STACK_NAME} does not exist in ${AWS_REGION}, so its artifact bucket (${ARTIFACT_BUCKET}) does not exist yet. The template exceeds the AWS CLI's 51,200-byte inline limit and must be uploaded through S3: set TEMPLATE_S3_BUCKET to an existing S3 bucket you can write to, then re-run. This script does not create buckets."
  else
    error "Could not tell whether stack ${STACK_NAME} exists in ${AWS_REGION}, so the template upload bucket cannot be chosen safely. Check the AWS session and network, then re-run, or set TEMPLATE_S3_BUCKET."
  fi
fi
info "Template upload: s3://${TEMPLATE_S3_BUCKET}/${TEMPLATE_S3_PREFIX}/"

# ── Deploy ─────────────────────────────────────────────────────────────────
aws cloudformation deploy \
  --template-file template.yaml \
  --s3-bucket "$TEMPLATE_S3_BUCKET" \
  --s3-prefix "$TEMPLATE_S3_PREFIX" \
  --stack-name "$STACK_NAME" \
  --region "$AWS_REGION" \
  --capabilities CAPABILITY_NAMED_IAM \
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
  "AdminCspMode=${ADMIN_CSP_MODE}"

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
