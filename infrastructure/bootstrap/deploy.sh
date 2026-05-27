#!/usr/bin/env bash
# =============================================================================
# deploy.sh — Bootstrap AWS account for adamdaniel.ai CI/CD
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
PREVIEW_DOMAIN="${PREVIEW_DOMAIN:-*.${APEX_DOMAIN}}"
STACK_NAME="${STACK_NAME:-${RESOURCE_PREFIX}-bootstrap}"
AWS_REGION="${AWS_REGION:-us-east-1}"
CREATE_OIDC_PROVIDER="${CREATE_OIDC_PROVIDER:-true}"
HOSTED_ZONE_ID="${HOSTED_ZONE_ID:-}"

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

# ── Deploy ─────────────────────────────────────────────────────────────────
aws cloudformation deploy \
  --template-file template.yaml \
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
  "HostedZoneId=${HOSTED_ZONE_ID}" \
  "PreviewDomainName=${PREVIEW_DOMAIN}"

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
