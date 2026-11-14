# Image of the daily refresh job (src/marketdata/jobs/daily_refresh.py), run
# by AWS Batch on Fargate. Built and pushed to ECR by scripts/deploy-batch.sh.
#
# The build context is the repo root (the root Dockerfile is the web app's):
#   docker build -f infra-batch/Dockerfile -t marketdata-job .
#   docker run --rm -e DATABASE_URL=postgresql://bncd_admin:localdev@host.docker.internal:5432/marketdata marketdata-job
#
# What goes into the image is set by Dockerfile.dockerignore next to this
# file (BuildKit reads it instead of the root .dockerignore).
#
# No credentials are baked in: on AWS the job reads the DB password from
# Secrets Manager at runtime, with the IAM role of the job.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app
COPY pyproject.toml ./
COPY src ./src
RUN pip install . && rm -rf build && useradd --create-home --uid 1000 job

USER job
ENTRYPOINT ["python", "-m", "marketdata.jobs.daily_refresh"]
