#!/usr/bin/env bash
# =============================================================================
# deploy.sh — Deploy the email-to-draft poller (Fastmail JMAP -> GitHub
#             repository_dispatch) to AWS
# =============================================================================
#
# Prerequisites:
#   • AWS CLI v2  (aws --version)
#   • AWS SAM CLI (sam --version)
#   • python3
#   • AWS credentials configured (aws configure or IAM role)
#   • A Fastmail API token with Email (read/write) scope:
#       Fastmail → Settings → Privacy & Security → Manage API tokens
#   • A GitHub App installed on every routed repo with Contents: read & write
#     (repository_dispatch needs it), and its private key (.pem)
#
# Usage:
#   export ROUTES='[{"mailbox": "Create draft/example.com", "repo": "<owner>/<repo>"}]'
#   export FASTMAIL_API_TOKEN=your_fastmail_token
#   export GITHUB_APP_CLIENT_ID=your_client_id
#   export GITHUB_APP_PRIVATE_KEY_FILE=/path/to/app.private-key.pem
#   bash deploy.sh
#
# Inputs (env):
#   STACK_NAME                  default email-draft-poller
#   AWS_REGION                  default us-east-1
#   ROUTES                      required: non-empty JSON array of
#                               {mailbox, repo[, fastmailTokenSecretArn]}
#   FASTMAIL_API_TOKEN          optional on update (keeps the stored token)
#   GITHUB_APP_CLIENT_ID +
#   GITHUB_APP_PRIVATE_KEY_FILE optional on update; both or neither
#   ALERT_EMAIL                 optional: SNS email subscription for alarms
#   SAM_S3_BUCKET               optional, else sam --resolve-s3
#
# Secrets live in Secrets Manager as ${STACK_NAME}/fastmail-api-token and
# ${STACK_NAME}/github-app; the stack receives only their ARNs. A secret's
# value is never echoed and never put on a command line (where `ps` sees it):
# it goes through a mode-600 temp file that is removed on exit. A value unset
# on an update keeps the stored secret; a first deploy needs every value. A
# placeholder (the Usage lines above, or an all-x value) is refused before
# anything touches AWS.
#
# Cost: well under $1/month (43,200 short Lambda runs, two secrets, two alarms).
# =============================================================================

set -euo pipefail

STACK_NAME="${STACK_NAME:-email-draft-poller}"
AWS_REGION="${AWS_REGION:-us-east-1}"
ROUTES="${ROUTES:?set ROUTES to a JSON array of mailbox/repo routes (see the Usage lines above)}"
FASTMAIL_API_TOKEN="${FASTMAIL_API_TOKEN:-}"
GITHUB_APP_CLIENT_ID="${GITHUB_APP_CLIENT_ID:-}"
GITHUB_APP_PRIVATE_KEY_FILE="${GITHUB_APP_PRIVATE_KEY_FILE:-}"
ALERT_EMAIL="${ALERT_EMAIL:-}"
SAM_S3_BUCKET="${SAM_S3_BUCKET:-}"

FASTMAIL_SECRET_NAME="${STACK_NAME}/fastmail-api-token"
GITHUB_APP_SECRET_NAME="${STACK_NAME}/github-app"

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

command -v python3 >/dev/null || error "python3 is required."

[[ "$STACK_NAME" =~ ^[A-Za-z][A-Za-z0-9-]{0,100}$ ]] \
  || error "STACK_NAME '${STACK_NAME}' is not a valid CloudFormation stack name."

# ── Validate ROUTES before touching AWS ───────────────────────────────────
# Prints the compact JSON on line 1 and the comma-joined distinct per-route
# fastmailTokenSecretArn values (the template's ExtraFastmailTokenSecretArns)
# on line 2. The compact form is handed to sam deploy single-quoted, so a
# single quote or backslash in a mailbox path is refused rather than mangled.
if ! ROUTES_PARSED="$(ROUTES="$ROUTES" python3 - <<'PY'
import json, os, re, sys
def die(msg):
    print(msg, file=sys.stderr)
    sys.exit(1)
try:
    routes = json.loads(os.environ["ROUTES"])
except ValueError:
    die("ROUTES is not valid JSON.")
if not isinstance(routes, list) or not routes:
    die("ROUTES must be a non-empty JSON array.")
arn_re = re.compile(r"^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+$")
extras = []
for i, r in enumerate(routes):
    if not isinstance(r, dict):
        die(f"ROUTES[{i}] is not an object.")
    unknown = set(r) - {"mailbox", "repo", "fastmailTokenSecretArn"}
    if unknown:
        die(f"ROUTES[{i}] has unknown keys: {', '.join(sorted(unknown))}.")
    mb = r.get("mailbox")
    if not isinstance(mb, str) or not mb.strip("/ "):
        die(f"ROUTES[{i}].mailbox must be a non-empty mailbox path, e.g. Create draft/example.com.")
    if not isinstance(r.get("repo"), str) or not re.fullmatch(r"[A-Za-z0-9-]+/[A-Za-z0-9._-]+", r["repo"]):
        die(f"ROUTES[{i}].repo must be owner/name.")
    arn = r.get("fastmailTokenSecretArn")
    if arn is not None:
        if not isinstance(arn, str) or not arn_re.match(arn):
            die(f"ROUTES[{i}].fastmailTokenSecretArn is not a Secrets Manager secret ARN.")
        if arn not in extras:
            extras.append(arn)
compact = json.dumps(routes, separators=(",", ":"), ensure_ascii=False)
if "'" in compact or "\\" in compact:
    die("ROUTES may not contain a single quote or a backslash (sam deploy cannot pass them through).")
print(compact)
print(",".join(extras))
PY
)"; then
  error "ROUTES is invalid (see the message above). Nothing was changed in AWS."
fi
ROUTES_COMPACT="$(sed -n 1p <<<"$ROUTES_PARSED")"
EXTRA_SECRET_ARNS="$(sed -n 2p <<<"$ROUTES_PARSED")"

# ── Validate the credentials (never print a value) ────────────────────────
is_placeholder() {
  [[ "$1" =~ ^x+$ || "$1" == "your_fastmail_token" || "$1" == "your_client_id" ]]
}
for cred_var in FASTMAIL_API_TOKEN GITHUB_APP_CLIENT_ID; do
  if [[ "${!cred_var}" =~ ^[[:space:]]|[[:space:]]$ ]]; then
    error "${cred_var} starts or ends with whitespace. Remove it, or leave ${cred_var} empty to keep the stored secret."
  fi
  if [[ -n "${!cred_var}" ]] && is_placeholder "${!cred_var}"; then
    error "${cred_var} is still the example placeholder, which would overwrite the stored secret and break every poll. Set the real value, or leave it empty to keep the stored secret."
  fi
done
if [[ -n "$GITHUB_APP_CLIENT_ID" && -n "$GITHUB_APP_PRIVATE_KEY_FILE" ]]; then
  APP_MODE="set"
  [[ -r "$GITHUB_APP_PRIVATE_KEY_FILE" ]] \
    || error "GITHUB_APP_PRIVATE_KEY_FILE '${GITHUB_APP_PRIVATE_KEY_FILE}' is not a readable file."
  grep -q -- "-----BEGIN [A-Z ]*PRIVATE KEY-----" "$GITHUB_APP_PRIVATE_KEY_FILE" \
    || error "GITHUB_APP_PRIVATE_KEY_FILE does not hold a PEM private key."
elif [[ -z "$GITHUB_APP_CLIENT_ID" && -z "$GITHUB_APP_PRIVATE_KEY_FILE" ]]; then
  APP_MODE="keep"
else
  error "Set both GITHUB_APP_CLIENT_ID and GITHUB_APP_PRIVATE_KEY_FILE to replace the GitHub App secret, or neither to keep the stored one."
fi
if [[ -n "$ALERT_EMAIL" && ! "$ALERT_EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; then
  error "ALERT_EMAIL is not an email address."
fi

command -v aws >/dev/null || error "AWS CLI v2 is required."
command -v sam >/dev/null || error "AWS SAM CLI is required."

# ── Secrets Manager: create or update, values via a temp file ─────────────
SECRET_TMP="$(umask 077 && mktemp)"
trap 'rm -f "$SECRET_TMP"' EXIT

# Prints the secret's ARN, or nothing when it does not exist; any other
# failure stops the deploy rather than guess.
existing_secret_arn() {
  local out
  if out="$(aws secretsmanager describe-secret --secret-id "$1" --region "$AWS_REGION" \
    --query ARN --output text 2>&1)"; then
    printf '%s' "$out"
  elif [[ "$out" == *ResourceNotFoundException* ]]; then
    printf ''
  else
    error "Could not read secret $1 in ${AWS_REGION}. Check the AWS session, then re-run."
  fi
}

# upsert_secret NAME DESCRIPTION — the value is already in $SECRET_TMP.
upsert_secret() {
  local arn
  arn="$(existing_secret_arn "$1")"
  if [[ -n "$arn" ]]; then
    aws secretsmanager put-secret-value --secret-id "$arn" --region "$AWS_REGION" \
      --secret-string "file://${SECRET_TMP}" --output text --query VersionId >/dev/null
    printf '%s' "$arn"
  else
    aws secretsmanager create-secret --name "$1" --description "$2" --region "$AWS_REGION" \
      --secret-string "file://${SECRET_TMP}" --query ARN --output text
  fi
  : >"$SECRET_TMP"
}

if [[ -n "$FASTMAIL_API_TOKEN" ]]; then
  printf '%s' "$FASTMAIL_API_TOKEN" >"$SECRET_TMP"
  FASTMAIL_SECRET_ARN="$(upsert_secret "$FASTMAIL_SECRET_NAME" "Fastmail API token for ${STACK_NAME}")"
  info "Fastmail token: stored in ${FASTMAIL_SECRET_NAME}"
else
  FASTMAIL_SECRET_ARN="$(existing_secret_arn "$FASTMAIL_SECRET_NAME")"
  [[ -n "$FASTMAIL_SECRET_ARN" ]] \
    || error "FASTMAIL_API_TOKEN is unset and ${FASTMAIL_SECRET_NAME} does not exist yet. Set it for the first deploy."
  info "Fastmail token: keeping the stored ${FASTMAIL_SECRET_NAME}"
fi

if [[ "$APP_MODE" == "set" ]]; then
  # The client id travels by env and the key by file path; python writes the
  # JSON straight into the temp file, so neither value reaches argv or stdout.
  CLIENT_ID="$GITHUB_APP_CLIENT_ID" python3 -c '
import json, os, sys
with open(sys.argv[1], encoding="utf-8") as f:
    key = f.read()
with open(sys.argv[2], "w", encoding="utf-8") as out:
    json.dump({"client_id": os.environ["CLIENT_ID"], "private_key": key}, out)
' "$GITHUB_APP_PRIVATE_KEY_FILE" "$SECRET_TMP"
  GITHUB_APP_SECRET_ARN="$(upsert_secret "$GITHUB_APP_SECRET_NAME" "GitHub App credentials for ${STACK_NAME}")"
  info "GitHub App: stored in ${GITHUB_APP_SECRET_NAME}"
else
  GITHUB_APP_SECRET_ARN="$(existing_secret_arn "$GITHUB_APP_SECRET_NAME")"
  [[ -n "$GITHUB_APP_SECRET_ARN" ]] \
    || error "GITHUB_APP_CLIENT_ID and GITHUB_APP_PRIVATE_KEY_FILE are unset and ${GITHUB_APP_SECRET_NAME} does not exist yet. Set both for the first deploy."
  info "GitHub App: keeping the stored ${GITHUB_APP_SECRET_NAME}"
fi

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
  --no-fail-on-empty-changeset
  --parameter-overrides
  "Routes='${ROUTES_COMPACT}'"
  "FastmailTokenSecretArn=${FASTMAIL_SECRET_ARN}"
  "GitHubAppSecretArn=${GITHUB_APP_SECRET_ARN}"
  "ExtraFastmailTokenSecretArns='${EXTRA_SECRET_ARNS}'"
  "AlertEmail='${ALERT_EMAIL}'"
)
if [[ -n "$SAM_S3_BUCKET" ]]; then
  DEPLOY_ARGS+=(--s3-bucket "$SAM_S3_BUCKET")
else
  DEPLOY_ARGS+=(--resolve-s3)
fi

sam deploy "${DEPLOY_ARGS[@]}"

FUNCTION_NAME="$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='FunctionName'].OutputValue" \
  --output text)"

# ── Summary ──────────────────────────────────────────────────────────────
echo ""
success "Deployment complete!"
echo ""
echo "  Next steps"
echo ""
echo "  1. In Fastmail, create each routed mailbox (and its Processed and"
echo "     Failed children), then add a rule per posting address:"
echo "       Settings → Filters & Rules → New rule"
echo "       If: the message was sent to <secret posting address>"
echo "       Then: move to <the route's mailbox path>"
echo ""
echo "  2. Send a test message to a posting address, then run one poll:"
echo -e "       ${YELLOW}aws lambda invoke --function-name ${FUNCTION_NAME} --region ${AWS_REGION} /dev/stdout${NC}"
echo "     The function's log has one JSON summary line per run (counts per"
echo "     route index); the site repo's Actions tab shows the email-draft run."
echo ""
if [[ -n "$ALERT_EMAIL" ]]; then
  warn "Confirm the SNS subscription email sent to ALERT_EMAIL, or no alarm will reach you."
fi
