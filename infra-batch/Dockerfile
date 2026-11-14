# Image of the daily refresh job (src/marketdata/jobs/daily-refresh.js), run
# by AWS Batch on Fargate. Built and pushed to ECR by scripts/deploy-batch.sh.
#
# The build context is the repo root (the root Dockerfile is the web app's):
#   docker build -f infra-batch/Dockerfile -t marketdata-job .
#   docker run --rm -e DATABASE_URL=postgres://bncd_admin:localdev@host.docker.internal:5432/marketdata marketdata-job
#
# What goes into the image is set by Dockerfile.dockerignore next to this
# file (BuildKit reads it instead of the root .dockerignore).
#
# No credentials are baked in: on AWS the job reads the DB password from
# Secrets Manager at runtime, with the IAM role of the job.
FROM node:22-alpine

WORKDIR /job
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src

USER node
ENV NODE_ENV=production
ENTRYPOINT ["node", "src/marketdata/jobs/daily-refresh.js"]
