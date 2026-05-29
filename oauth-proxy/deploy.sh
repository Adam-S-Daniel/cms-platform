#!/usr/bin/env bash
# =============================================================================
# deploy.sh — Deploy the Sveltia CMS OAuth Proxy to AWS
# =============================================================================
#
# Prerequisites:
#   • AWS CLI v2  (aws --version)
#   • AWS SAM CLI (sam --version)
#   • AWS credentials configured (aws configure or IAM role)
#   • A GitHub OAuth App created at:
#       https://github.com/settings/developers → "OAuth Apps" → "New OAuth App"
#     Settings to use:
#       Application name:      <your-site> CMS
#       Homepage URL:          https://<your-site>
#       Authorization callback URL: (run this script once to get the URL, then update)
#
# Usage:
#   export GITHUB_CLIENT_ID=your_client_id
#   export GITHUB_CLIENT_SECRET=your_client_secret
#   bash deploy.sh
#
# Cost: $0.00/month under AWS free tier (1M Lambda + 1M API Gateway requests).
# =============================================================================

set -euo pipefail

STACK_NAME="${STACK_NAME:?set STACK_NAME, e.g. example-com-oauth-proxy}"
FUNCTION_NAME="${FUNCTION_NAME:-${STACK_NAME}}"
AWS_REGION="${AWS_REGION:-us-east-1}"
SAM_S3_BUCKET="${SAM_S3_BUCKET:-}"
ALLOWED_ORIGINS="${ALLOWED_ORIGINS:?set ALLOWED_ORIGINS, e.g. https://example.com}"
GITHUB_SCOPE="${GITHUB_SCOPE:-repo,user,workflow}"
# Repo identity for the Next-Steps backend snippet (already in site-params.env).
GITHUB_ORG="${GITHUB_ORG:-Adam-S-Daniel}"
GITHUB_REPO="${GITHUB_REPO:-<repo>}"

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

# ── Validate required env vars ────────────────────────────────────────────
[[ -z "${GITHUB_CLIENT_ID:-}" ]] && error "GITHUB_CLIENT_ID is not set"
[[ -z "${GITHUB_CLIENT_SECRET:-}" ]] && error "GITHUB_CLIENT_SECRET is not set"

# ── Move to script directory ──────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

info "Deploying stack: ${STACK_NAME} to ${AWS_REGION}"

# ── sam build ────────────────────────────────────────────────────────────
info "Building SAM application…"
sam build \
  --template-file template.yaml \
  --region "$AWS_REGION"

# ── sam deploy ───────────────────────────────────────────────────────────
info "Deploying to AWS…"

DEPLOY_ARGS=(
  --template-file .aws-sam/build/template.yaml
  --stack-name "$STACK_NAME"
  --region "$AWS_REGION"
  --capabilities CAPABILITY_IAM
  --no-confirm-changeset
  --parameter-overrides
  "GitHubClientId=${GITHUB_CLIENT_ID}"
  "GitHubClientSecret=${GITHUB_CLIENT_SECRET}"
  "AllowedOrigins=${ALLOWED_ORIGINS}"
  "GitHubScope=${GITHUB_SCOPE}"
  "FunctionName=${FUNCTION_NAME}"
)

# Resolve S3 bucket for artifacts (SAM managed or pre-existing)
if [[ -n "$SAM_S3_BUCKET" ]]; then
  DEPLOY_ARGS+=(--s3-bucket "$SAM_S3_BUCKET")
else
  DEPLOY_ARGS+=(--resolve-s3)
fi

sam deploy "${DEPLOY_ARGS[@]}"

# ── Print outputs ────────────────────────────────────────────────────────
info "Fetching stack outputs…"
OUTPUTS=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$AWS_REGION" \
  --query 'Stacks[0].Outputs' \
  --output json)

API_URL=$(echo "$OUTPUTS" | python3 -c "
import json, sys
outputs = json.load(sys.stdin)
for o in outputs:
    if o['OutputKey'] == 'ApiUrl':
        print(o['OutputValue'])
        break
")

CALLBACK_URL=$(echo "$OUTPUTS" | python3 -c "
import json, sys
outputs = json.load(sys.stdin)
for o in outputs:
    if o['OutputKey'] == 'CallbackEndpoint':
        print(o['OutputValue'])
        break
")

# ── Summary ──────────────────────────────────────────────────────────────
echo ""
success "Deployment complete!"
echo ""
echo "  ┌─────────────────────────────────────────────────────────────────┐"
echo "  │  Next steps                                                     │"
echo "  ├─────────────────────────────────────────────────────────────────┤"
echo "  │                                                                 │"
echo -e "  │  1. Update your GitHub OAuth App callback URL to:              │"
echo -e "  │     ${YELLOW}${CALLBACK_URL}${NC}"
echo "  │                                                                 │"
echo "  │  2. Update admin/config.yml in your repo:                       │"
echo "  │                                                                 │"
echo "  │     backend:                                                    │"
echo "  │       name: github                                              │"
echo -e "  │       repo: ${YELLOW}${GITHUB_ORG}/${GITHUB_REPO}${NC}"
echo "  │       branch: main                                              │"
echo -e "  │       base_url: ${YELLOW}${API_URL}${NC}"
echo "  │       auth_endpoint: prod/auth                                  │"
echo "  │                                                                 │"
echo "  └─────────────────────────────────────────────────────────────────┘"
echo ""
