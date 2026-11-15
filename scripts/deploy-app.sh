#!/bin/bash
# Build the app image, push it to ECR and restart it on the web server.
#
# Usage (from the repo root, with AWS credentials and your environment loaded):
#   set -a; source .env-aws; source .env-dev; set +a
#   ./scripts/deploy-app.sh                         # your environment
#   TF_WORKSPACE=default ./scripts/deploy-app.sh    # prod
#
# Needs Docker with buildx, and ../infra applied (ECR repo + web server).
# The server is x86_64 (t3.micro), so the image is built for linux/amd64.
# No SSH: the restart goes through AWS Systems Manager (SSM).
set -euo pipefail
cd "$(dirname "$0")/.."

# The terraform outputs below come from the TF_WORKSPACE environment.
if [ -z "${TF_WORKSPACE:-}" ]; then
  echo "Set TF_WORKSPACE (source .env-dev), or TF_WORKSPACE=default for prod." >&2
  exit 1
fi
ENV_NAME="$TF_WORKSPACE"; [ "$ENV_NAME" = default ] && ENV_NAME=prod
echo "==> Environment: $ENV_NAME"

REGION="${AWS_DEFAULT_REGION:-us-east-1}"
REPO_URL="$(terraform -chdir=infra output -raw ecr_repository_url)"
INSTANCE_ID="$(terraform -chdir=infra output -raw instance_id)"
# Empty if the reports bucket (infra/reports.tf) doesn't exist: the app then keeps reports in its JSON file.
REPORTS_BUCKET="$(terraform -chdir=infra output -raw reports_bucket 2>/dev/null || true)"
TAG="$(git rev-parse --short HEAD)"
if [ -n "$(git status --porcelain -- app src package.json package-lock.json Dockerfile)" ]; then
  TAG="$TAG-dirty"
fi

# Research agent settings (app/research.js). Its resources are created with
# the AWS CLI (see ../agents/README.md), not by Terraform, and are named after
# the environment prefix: they are looked up by name here and rewritten in
# /etc/chatbot.env on every deploy, so a replaced instance gets them back.
# An environment without a research harness runs without research.
PREFIX="${REPO_URL##*/}"; PREFIX="${PREFIX%-app}"
ACCOUNT="${REPO_URL%%.*}"
HARNESS_PREFIX="${PREFIX//-/_}"
# Prints the value, or nothing when the resource does not exist. An AWS error
# stops the deploy (set -e), so research is never removed by mistake.
lookup() {
  local v
  v="$("$@" --region "$REGION" --output text)" || return 1
  [ "$v" = None ] && v=""
  echo "${v%%[[:space:]]*}"
}

RESEARCH_HARNESS_ARN="$(lookup aws bedrock-agentcore-control list-harnesses \
  --query "harnesses[?harnessName=='${HARNESS_PREFIX}_research'].arn | [0]")"
RESEARCH_REVIEWER_ARN="" RESEARCH_GATEWAY_URL="" RESEARCH_KB_ID="" RESEARCH_KB_DATA_SOURCE_ID="" RESEARCH_KB_BUCKET=""
if [ -n "$RESEARCH_HARNESS_ARN" ]; then
  RESEARCH_REVIEWER_ARN="$(lookup aws bedrock-agentcore-control list-harnesses \
    --query "harnesses[?harnessName=='${HARNESS_PREFIX}_reviewer'].arn | [0]")"
  GATEWAY_ID="$(lookup aws bedrock-agentcore-control list-gateways \
    --query "items[?name=='${PREFIX}-research'].gatewayId | [0]")"
  if [ -n "$GATEWAY_ID" ]; then
    RESEARCH_GATEWAY_URL="$(lookup aws bedrock-agentcore-control get-gateway \
      --gateway-identifier "$GATEWAY_ID" --query gatewayUrl)"
  fi
  RESEARCH_KB_ID="$(lookup aws bedrock-agent list-knowledge-bases \
    --query "knowledgeBaseSummaries[?name=='${PREFIX}-earnings'].knowledgeBaseId | [0]")"
  if [ -n "$RESEARCH_KB_ID" ]; then
    RESEARCH_KB_DATA_SOURCE_ID="$(lookup aws bedrock-agent list-data-sources \
      --knowledge-base-id "$RESEARCH_KB_ID" --query "dataSourceSummaries[0].dataSourceId")"
    RESEARCH_KB_BUCKET="${PREFIX}-earnings-${ACCOUNT}"
  fi
fi
RESEARCH_VARS="RESEARCH_HARNESS_ARN RESEARCH_REVIEWER_ARN RESEARCH_GATEWAY_URL RESEARCH_KB_ID RESEARCH_KB_DATA_SOURCE_ID RESEARCH_KB_BUCKET"
echo "==> Research settings for $PREFIX"
for VAR in $RESEARCH_VARS; do echo "    $VAR=${!VAR:-(none)}"; done

echo "==> Build and push $REPO_URL:$TAG (+ latest)"
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "${REPO_URL%%/*}"
docker buildx build --platform linux/amd64 \
  -t "$REPO_URL:$TAG" -t "$REPO_URL:latest" --push .

echo "==> Restart the app on $INSTANCE_ID (pulls the new image)"
# REPORTS_BUCKET and the research settings are (re)written in /etc/chatbot.env
# on every deploy, so a replaced instance gets them back too. Other lines
# (alerts...) are left as they are.
SET_ENV="sed -i '/^REPORTS_BUCKET=/d' /etc/chatbot.env"
if [ -n "$REPORTS_BUCKET" ]; then
  SET_ENV="$SET_ENV && echo REPORTS_BUCKET=$REPORTS_BUCKET >> /etc/chatbot.env"
fi
for VAR in $RESEARCH_VARS; do
  SET_ENV="$SET_ENV && sed -i '/^$VAR=/d' /etc/chatbot.env"
  if [ -n "${!VAR}" ]; then
    SET_ENV="$SET_ENV && echo $VAR=${!VAR} >> /etc/chatbot.env"
  fi
done
COMMAND_ID="$(aws ssm send-command --region "$REGION" \
  --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --comment "deploy app $TAG" \
  --parameters "$(printf '{"commands":["%s","systemctl restart chatbot","sleep 5","systemctl is-active chatbot","docker ps --filter name=chatbot --format \\"{{.Image}} {{.Status}}\\""]}' "$SET_ENV")" \
  --query Command.CommandId --output text)"

for _ in $(seq 1 30); do
  STATUS="$(aws ssm get-command-invocation --region "$REGION" --command-id "$COMMAND_ID" \
    --instance-id "$INSTANCE_ID" --query Status --output text 2>/dev/null || echo Pending)"
  case "$STATUS" in
    Pending|InProgress|Delayed) sleep 3 ;;
    *) break ;;
  esac
done

aws ssm get-command-invocation --region "$REGION" --command-id "$COMMAND_ID" \
  --instance-id "$INSTANCE_ID" --query '[Status, StandardOutputContent, StandardErrorContent]' --output text
[ "$STATUS" = "Success" ] || { echo "Deploy failed ($STATUS)" >&2; exit 1; }
echo "==> Deployed $TAG: $(terraform -chdir=infra output -raw url)"
