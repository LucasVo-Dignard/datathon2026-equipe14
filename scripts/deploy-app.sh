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

# Research agents (app/research.js): the app finds this environment's agents by
# name at startup (RESEARCH_ENV); an environment without agents runs without
# research. The older RESEARCH_* lines with each ID are removed from
# /etc/chatbot.env below.
OLD_RESEARCH_VARS="RESEARCH_HARNESS_ARN RESEARCH_REVIEWER_ARN RESEARCH_GATEWAY_URL RESEARCH_KB_ID RESEARCH_KB_DATA_SOURCE_ID RESEARCH_KB_BUCKET"

echo "==> Build and push $REPO_URL:$TAG (+ latest)"
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "${REPO_URL%%/*}"
docker buildx build --platform linux/amd64 \
  -t "$REPO_URL:$TAG" -t "$REPO_URL:latest" --push .

echo "==> Restart the app on $INSTANCE_ID (pulls the new image)"
# REPORTS_BUCKET and RESEARCH_ENV are (re)written in /etc/chatbot.env
# on every deploy, so a replaced instance gets them back too. Other lines
# (alerts...) are left as they are.
SET_ENV="sed -i '/^REPORTS_BUCKET=/d' /etc/chatbot.env"
if [ -n "$REPORTS_BUCKET" ]; then
  SET_ENV="$SET_ENV && echo REPORTS_BUCKET=$REPORTS_BUCKET >> /etc/chatbot.env"
fi
for VAR in $OLD_RESEARCH_VARS RESEARCH_ENV; do
  SET_ENV="$SET_ENV && sed -i '/^$VAR=/d' /etc/chatbot.env"
done
SET_ENV="$SET_ENV && echo RESEARCH_ENV=$ENV_NAME >> /etc/chatbot.env"
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
