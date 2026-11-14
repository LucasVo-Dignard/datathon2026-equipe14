#!/bin/bash
# Build the app image, push it to ECR and restart it on the web server.
#
# Usage (from the repo root, with AWS credentials loaded):
#   set -a; source .env-aws; set +a
#   ./scripts/deploy-app.sh
#
# Needs Docker with buildx, and ../infra applied (ECR repo + web server).
# The server is x86_64 (t3.micro), so the image is built for linux/amd64.
# No SSH: the restart goes through AWS Systems Manager (SSM).
set -euo pipefail
cd "$(dirname "$0")/.."

REGION="${AWS_DEFAULT_REGION:-us-east-1}"
REPO_URL="$(terraform -chdir=infra output -raw ecr_repository_url)"
INSTANCE_ID="$(terraform -chdir=infra output -raw instance_id)"
TAG="$(git rev-parse --short HEAD)"
if [ -n "$(git status --porcelain -- app package.json package-lock.json Dockerfile)" ]; then
  TAG="$TAG-dirty"
fi

echo "==> Build and push $REPO_URL:$TAG (+ latest)"
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "${REPO_URL%%/*}"
docker buildx build --platform linux/amd64 \
  -t "$REPO_URL:$TAG" -t "$REPO_URL:latest" --push .

echo "==> Restart the app on $INSTANCE_ID (pulls the new image)"
COMMAND_ID="$(aws ssm send-command --region "$REGION" \
  --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --comment "deploy app $TAG" \
  --parameters 'commands=["systemctl restart chatbot","sleep 5","systemctl is-active chatbot","docker ps --filter name=chatbot --format \"{{.Image}} {{.Status}}\""]' \
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
