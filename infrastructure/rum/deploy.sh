#!/usr/bin/env bash
# =============================================================================
# deploy.sh — CloudWatch RUM analytics for adamdaniel.ai
# =============================================================================
#
# One-time setup that creates:
#   1. Cognito identity pool (unauthenticated identities only)
#   2. IAM role scoped to rum:PutRumEvents on this app monitor
#   3. RUM app monitor with CwLogEnabled=true (mirror to CloudWatch Logs)
#
# Prerequisites:
#   • AWS CLI v2  (aws --version)
#   • AWS credentials configured (aws configure or IAM role)
#
# Usage:
#   bash infrastructure/rum/deploy.sh
#
# After it finishes, copy the AppMonitorId and IdentityPoolId outputs into
# `_config.yml` under `analytics.cloudwatch_rum`, then deploy the site.
#
# This script is idempotent — safe to re-run at any time.
# =============================================================================

set -euo pipefail

APEX_DOMAIN="${APEX_DOMAIN:?set APEX_DOMAIN, e.g. example.com}"
RESOURCE_PREFIX="${RESOURCE_PREFIX:-$(printf '%s' "$APEX_DOMAIN" | tr '.' '-')}"
APP_MONITOR_NAME="${APP_MONITOR_NAME:-${RESOURCE_PREFIX}}"
STACK_NAME="${STACK_NAME:-${RESOURCE_PREFIX}-rum}"
AWS_REGION="${AWS_REGION:-us-east-1}"

# ── Colour output ──────────────────────────────────────────────────────────
BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info() { echo -e "${BLUE}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
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

# ── Deploy ─────────────────────────────────────────────────────────────────
aws cloudformation deploy \
  --template-file template.yaml \
  --stack-name "$STACK_NAME" \
  --region "$AWS_REGION" \
  --capabilities CAPABILITY_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides \
  "AppMonitorName=${APP_MONITOR_NAME}" \
  "Domain=${APEX_DOMAIN}"

# ── Fetch outputs ──────────────────────────────────────────────────────────
info "Fetching stack outputs…"
OUTPUTS=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$AWS_REGION" \
  --query 'Stacks[0].Outputs' \
  --output json)

extract() {
  echo "$OUTPUTS" | python3 -c "
import json, sys
outputs = json.load(sys.stdin)
for o in outputs:
    if o['OutputKey'] == '$1':
        print(o['OutputValue'])
        break
"
}

APP_MONITOR_ID=$(extract AppMonitorId)
IDENTITY_POOL_ID=$(extract IdentityPoolId)
REGION=$(extract Region)
LOG_GROUP=$(extract LogGroupName)

# ── Summary ────────────────────────────────────────────────────────────────
echo ""
success "RUM stack deployed!"
echo ""
echo "  ┌─────────────────────────────────────────────────────────────────┐"
echo "  │  Stack outputs                                                  │"
echo "  ├─────────────────────────────────────────────────────────────────┤"
echo -e "  │  App monitor ID:    ${YELLOW}${APP_MONITOR_ID}${NC}"
echo -e "  │  Identity pool ID:  ${YELLOW}${IDENTITY_POOL_ID}${NC}"
echo -e "  │  Region:            ${YELLOW}${REGION}${NC}"
echo -e "  │  Logs group:        ${YELLOW}${LOG_GROUP}${NC}"
echo "  ├─────────────────────────────────────────────────────────────────┤"
echo "  │  Next: paste these into _config.yml                             │"
echo "  ├─────────────────────────────────────────────────────────────────┤"
echo "  │                                                                 │"
echo "  │    analytics:                                                   │"
echo "  │      cloudwatch_rum:                                            │"
echo -e "  │        app_monitor_id: ${YELLOW}\"${APP_MONITOR_ID}\"${NC}"
echo -e "  │        identity_pool_id: ${YELLOW}\"${IDENTITY_POOL_ID}\"${NC}"
echo -e "  │        region: ${YELLOW}\"${REGION}\"${NC}"
echo "  │                                                                 │"
echo "  │  Then deploy the site (push to main) and load it once to        │"
echo "  │  generate the first event. Dashboard:                           │"
echo -e "  │  ${YELLOW}https://${REGION}.console.aws.amazon.com/cloudwatch/home?region=${REGION}#rum:dashboard${NC}"
echo "  └─────────────────────────────────────────────────────────────────┘"
echo ""
