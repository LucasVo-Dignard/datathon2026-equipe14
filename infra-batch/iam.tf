# ---------------------------------------------------------------------------
# Three roles, each with only what it needs:
# - execution role: used by Fargate to pull the image (batch ECR repo only)
#                   and write logs (this job's log group only)
# - job role:       used by our code; can only read the DB secret
# - scheduler role: used by EventBridge Scheduler; can only submit this job
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

# --- Execution role ------------------------------------------------------------

resource "aws_iam_role" "execution" {
  name               = "${var.project_name}-batch-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

# ECR pull from the batch repository only: see ecr.tf.
# CloudWatch Logs: write to this job's log group only.
data "aws_iam_policy_document" "execution_logs" {
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.job.arn}:*"]
  }
}

resource "aws_iam_role_policy" "execution_logs" {
  name   = "logs-batch"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_logs.json
}

# --- Job role: access to the database credentials ---------------------------
# The RDS master secret is encrypted with the AWS managed key
# (aws/secretsmanager), so no KMS permission is needed.

resource "aws_iam_role" "job" {
  name               = "${var.project_name}-batch-job"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "job" {
  statement {
    sid       = "ReadDbMasterSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [local.db_secret_arn]
  }
}

resource "aws_iam_role_policy" "job" {
  name   = "${var.project_name}-batch-job-db"
  role   = aws_iam_role.job.id
  policy = data.aws_iam_policy_document.job.json
}

# --- Scheduler role ----------------------------------------------------------------

data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name               = "${var.project_name}-batch-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

data "aws_iam_policy_document" "scheduler" {
  statement {
    sid     = "SubmitDailyRefresh"
    actions = ["batch:SubmitJob"]
    resources = [
      aws_batch_job_queue.main.arn,
      aws_batch_job_definition.daily_refresh.arn_prefix,
      "${aws_batch_job_definition.daily_refresh.arn_prefix}:*",
    ]
  }
}

resource "aws_iam_role_policy" "scheduler" {
  name   = "${var.project_name}-batch-scheduler"
  role   = aws_iam_role.scheduler.id
  policy = data.aws_iam_policy_document.scheduler.json
}
