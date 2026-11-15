#!/bin/bash
# Build the Batch jobs image (daily refresh, news, scheduled reports) and push
# it to the batch ECR repository.
# Same approach as deploy-app.sh: one image per git commit, plus "latest".
#
# Usage (from the repo root, with AWS credentials and your environment loaded):
#   set -a; source .env-aws; source .env-dev; set +a
#   ./scripts/deploy-batch.sh                         # your environment
#   TF_WORKSPACE=default ./scripts/deploy-batch.sh    # prod
#
# Needs Docker with buildx, and ../infra-batch applied (ECR repo + job).
# Fargate runs X86_64, so the image is built for linux/amd64.
# Nothing to restart: the job definition runs the "latest" tag, so the next
# run (scheduled or manual) uses the new image.
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
REPO_URL="$(terraform -chdir=infra-batch output -raw ecr_repository_url)"
TAG="$(git rev-parse --short HEAD)"
if [ -n "$(git status --porcelain -- src app package.json package-lock.json infra-batch/Dockerfile infra-batch/Dockerfile.dockerignore)" ]; then
  TAG="$TAG-dirty"
fi

echo "==> Build and push $REPO_URL:$TAG (+ latest)"
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "${REPO_URL%%/*}"
docker buildx build --platform linux/amd64 \
  -f infra-batch/Dockerfile \
  -t "$REPO_URL:$TAG" -t "$REPO_URL:latest" --push .

echo "==> Pushed $TAG. Run it now with:"
echo "    aws batch submit-job --job-name manual-refresh \\"
echo "      --job-queue $(terraform -chdir=infra-batch output -raw job_queue) \\"
echo "      --job-definition $(terraform -chdir=infra-batch output -raw job_definition)"
