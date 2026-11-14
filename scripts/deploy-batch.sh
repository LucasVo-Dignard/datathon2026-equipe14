#!/bin/bash
# Build the daily refresh job image and push it to the batch ECR repository.
# Same approach as deploy-app.sh: one image per git commit, plus "latest".
#
# Usage (from the repo root, with AWS credentials loaded):
#   set -a; source .env-aws; set +a
#   ./scripts/deploy-batch.sh
#
# Needs Docker with buildx, and ../infra-batch applied (ECR repo + job).
# Fargate runs X86_64, so the image is built for linux/amd64.
# Nothing to restart: the job definition runs the "latest" tag, so the next
# run (scheduled or manual) uses the new image.
set -euo pipefail
cd "$(dirname "$0")/.."

REGION="${AWS_DEFAULT_REGION:-us-east-1}"
REPO_URL="$(terraform -chdir=infra-batch output -raw ecr_repository_url)"
TAG="$(git rev-parse --short HEAD)"
if [ -n "$(git status --porcelain -- src pyproject.toml infra-batch/Dockerfile infra-batch/Dockerfile.dockerignore)" ]; then
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
