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
# Credentials (#518): both set replaces the stack's values. Both unset (or
# empty) on an update keeps the values the stack already has, so a code or
# AllowedOrigins change never needs the secret. A new stack needs both. One of
# the two set, a placeholder (the lines above, or the example file's all-x
# values), or a value with surrounding whitespace is refused before anything
# touches AWS.
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

# ── Validate the OAuth App credentials (#518) ─────────────────────────────
# Deploying a placeholder overwrites the live client secret and breaks every
# sign-in, so refuse the shapes this repo ships as examples: the all-x values
# in infrastructure/site-params.example.env and the Usage lines above. Never
# print a credential's value.
is_placeholder() {
  [[ "$1" =~ ^x+$ || "$1" == "your_client_id" || "$1" == "your_client_secret" ]]
}
for cred_var in GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET; do
  # A real id or secret never has surrounding whitespace, and a blank-looking
  # " " would otherwise count as set and replace the live value.
  if [[ "${!cred_var:-}" =~ ^[[:space:]]|[[:space:]]$ ]]; then
    error "${cred_var} starts or ends with whitespace, which would overwrite the live credential with a value GitHub rejects. Remove the whitespace, or make both GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET empty to keep the deployed stack's credentials."
  fi
  if [[ -n "${!cred_var:-}" ]] && is_placeholder "${!cred_var}"; then
    error "${cred_var} is still the example placeholder, which would overwrite the live credential and break every sign-in. Set it to the OAuth App's real value, or leave both GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET unset (or empty) to keep the deployed stack's credentials."
  fi
done
if [[ -n "${GITHUB_CLIENT_ID:-}" && -n "${GITHUB_CLIENT_SECRET:-}" ]]; then
  CREDENTIAL_MODE="set"
elif [[ -z "${GITHUB_CLIENT_ID:-}" && -z "${GITHUB_CLIENT_SECRET:-}" ]]; then
  CREDENTIAL_MODE="keep"
else
  only_set="GITHUB_CLIENT_SECRET"
  [[ -n "${GITHUB_CLIENT_ID:-}" ]] && only_set="GITHUB_CLIENT_ID"
  error "Only ${only_set} is set. Set both GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET to replace the stack's credentials, or leave both unset (or empty) to keep the ones it has."
fi

# The proxy refuses every login when ALLOWED_ORIGINS has no valid entry, so
# catch a bad value here instead of deploying a proxy nobody can sign in to.
# Same grammar as _origin_patterns in lambda.py: https:// origins, optional
# port, `*` allowed inside a host label but never in the last two labels.
ORIGIN_RE='^https://[a-z0-9*-]+(\.[a-z0-9*-]+)+(:[0-9]{1,5})?$'
VALID_ORIGINS=0
IFS=',' read -r -a ORIGIN_ENTRIES <<<"$ALLOWED_ORIGINS"
for raw_entry in "${ORIGIN_ENTRIES[@]}"; do
  entry="${raw_entry#"${raw_entry%%[![:space:]]*}"}"
  entry="${entry%"${entry##*[![:space:]]}"}"
  [[ -z "$entry" ]] && continue
  entry="$(printf '%s' "${entry%/}" | tr '[:upper:]' '[:lower:]')"
  host="${entry#https://}"
  host="${host%%:*}"
  last_label="${host##*.}"
  second_label="${host%.*}"
  second_label="${second_label##*.}"
  if [[ ! "$entry" =~ $ORIGIN_RE || "$last_label$second_label" == *'*'* ]]; then
    error "ALLOWED_ORIGINS entry '${entry}' is not valid. Use comma-separated https:// origins, e.g. https://example.com,https://preview-*.example.com ('*' only inside a host label, never in the last two)."
  fi
  VALID_ORIGINS=$((VALID_ORIGINS + 1))
done
[[ "$VALID_ORIGINS" -gt 0 ]] || error "ALLOWED_ORIGINS has no origin. Set it to e.g. https://example.com,https://preview-*.example.com"

# ── Keep the stack's credentials only on an update (#518) ─────────────────
# sam deploy sends every parameter missing from --parameter-overrides as
# UsePreviousValue on an UPDATE and drops it on a CREATE, so "keep" works only
# when the stack exists. Decide that here, the way sam does: a missing stack
# (or one stuck in REVIEW_IN_PROGRESS, which sam treats as missing) needs both
# credentials, and any other failure stops the deploy rather than guess.
if [[ "$CREDENTIAL_MODE" == "keep" ]]; then
  if STACK_STATUS="$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$AWS_REGION" \
    --query 'Stacks[0].StackStatus' \
    --output text 2>&1)"; then
    if [[ -z "$STACK_STATUS" || "$STACK_STATUS" == "None" || "$STACK_STATUS" == "REVIEW_IN_PROGRESS" ]]; then
      error "GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are unset, and stack ${STACK_NAME} has no deployed credentials to keep. Set both to create it."
    fi
    [[ "$STACK_STATUS" =~ ^[A-Z_]+$ ]] \
      || error "Could not read the status of stack ${STACK_NAME} in ${AWS_REGION}, so the credentials cannot be kept safely. Re-run, or set both credentials."
  elif [[ "$STACK_STATUS" == *"Stack with id ${STACK_NAME} does not exist"* ]]; then
    error "GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are unset, and stack ${STACK_NAME} does not exist in ${AWS_REGION}. Set both to create it."
  else
    error "Could not tell whether stack ${STACK_NAME} exists in ${AWS_REGION}, so the credentials cannot be kept safely. Check the AWS session and network, then re-run."
  fi
  info "Credentials: keeping the stack's existing credentials (GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are unset)"
else
  info "Credentials: setting credentials from the environment (GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET)"
fi

# ── Move to script directory ──────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── The release this build comes from (#518) ─────────────────────────────
# /prod/health reports it so a person can name the live build. It is read
# from this checkout, never from the environment: the release tag when HEAD
# is exactly one (the delegating wrapper clones at platform.lock's tag),
# otherwise the commit. The probe compares the handler digest, not this.
if ! PROXY_RELEASE="$(git -C "$SCRIPT_DIR" describe --tags --exact-match HEAD 2>/dev/null)"; then
  PROXY_RELEASE="$(git -C "$SCRIPT_DIR" rev-parse HEAD 2>/dev/null)" || PROXY_RELEASE="unknown"
fi
[[ "$PROXY_RELEASE" =~ ^[A-Za-z0-9._/+-]{1,100}$ ]] || PROXY_RELEASE="unknown"

info "Deploying stack: ${STACK_NAME} to ${AWS_REGION} (platform ${PROXY_RELEASE})"

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
  "AllowedOrigins=${ALLOWED_ORIGINS}"
  "GitHubScope=${GITHUB_SCOPE}"
  "FunctionName=${FUNCTION_NAME}"
  "PlatformRelease=${PROXY_RELEASE}"
)
# Omitted in "keep" mode, so CloudFormation keeps the stack's current values.
if [[ "$CREDENTIAL_MODE" == "set" ]]; then
  DEPLOY_ARGS+=(
    "GitHubClientId=${GITHUB_CLIENT_ID}"
    "GitHubClientSecret=${GITHUB_CLIENT_SECRET}"
  )
fi

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
# Display-only: if GITHUB_REPO already contains "owner/repo", print it as-is;
# otherwise prefix it with GITHUB_ORG. Avoids mangled "org/owner/repo" output.
if [[ "$GITHUB_REPO" == */* ]]; then
  REPO_DISPLAY="${GITHUB_REPO}"
else
  REPO_DISPLAY="${GITHUB_ORG}/${GITHUB_REPO}"
fi

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
echo -e "  │       repo: ${YELLOW}${REPO_DISPLAY}${NC}"
echo "  │       branch: main                                              │"
echo -e "  │       base_url: ${YELLOW}${API_URL}${NC}"
echo "  │       auth_endpoint: prod/auth                                  │"
echo "  │                                                                 │"
echo "  └─────────────────────────────────────────────────────────────────┘"
echo ""
