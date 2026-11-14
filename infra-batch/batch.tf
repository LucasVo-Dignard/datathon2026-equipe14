# ---------------------------------------------------------------------------
# AWS Batch on Fargate: nothing runs (or costs) between jobs. Batch uses its
# service-linked role (AWSServiceRoleForBatch), so no service role is set.
# ---------------------------------------------------------------------------

resource "aws_batch_compute_environment" "main" {
  compute_environment_name = "${local.prefix}-fargate"
  type                     = "MANAGED"

  compute_resources {
    type               = "FARGATE"
    max_vcpus          = 1 # one job at a time is plenty
    subnets            = [data.aws_subnet.public.id]
    security_group_ids = [aws_security_group.job.id]
  }
}

resource "aws_batch_job_queue" "main" {
  name     = "${local.prefix}-jobs"
  state    = "ENABLED"
  priority = 1

  compute_environment_order {
    order               = 1
    compute_environment = aws_batch_compute_environment.main.arn
  }
}

resource "aws_batch_job_definition" "daily_refresh" {
  name                  = "${local.prefix}-daily-refresh"
  type                  = "container"
  platform_capabilities = ["FARGATE"]
  propagate_tags        = true

  # The job exits 1 only when nothing succeeded (DB or network down), which
  # is worth one retry. Per-symbol failures exit 0 and are in the logs.
  retry_strategy {
    attempts = 2
  }

  timeout {
    attempt_duration_seconds = var.job_timeout_seconds
  }

  container_properties = jsonencode({
    image            = "${aws_ecr_repository.job.repository_url}:${var.image_tag}"
    executionRoleArn = aws_iam_role.execution.arn
    jobRoleArn       = aws_iam_role.job.arn

    resourceRequirements = [
      { type = "VCPU", value = var.job_vcpu },
      { type = "MEMORY", value = tostring(var.job_memory_mib) },
    ]

    # Public IP for outbound internet access only; the security group
    # has no inbound rules.
    networkConfiguration         = { assignPublicIp = "ENABLED" }
    fargatePlatformConfiguration = { platformVersion = "LATEST" }
    runtimePlatform = {
      cpuArchitecture       = "X86_64"
      operatingSystemFamily = "LINUX"
    }

    # Where the database is, and which secret holds its credentials. The
    # password itself is read at runtime with the job role, never stored.
    environment = [
      { name = "DB_HOST", value = data.aws_db_instance.main.address },
      { name = "DB_PORT", value = tostring(local.db_port) },
      { name = "DB_NAME", value = data.aws_db_instance.main.db_name },
      { name = "DB_SECRET_ARN", value = local.db_secret_arn },
      { name = "AWS_DEFAULT_REGION", value = data.aws_region.current.name },
      { name = "REFRESH_ENABLED", value = tostring(var.refresh_enabled) },
      # Price-move alerts by email after the refresh (price_alerts.py).
      { name = "NOTIFICATIONS_TOPIC_ARN", value = data.aws_sns_topic.price_alerts.arn },
      { name = "APP_URL", value = "http://${data.aws_eip.web.public_ip}" },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.job.name
        awslogs-region        = data.aws_region.current.name
        awslogs-stream-prefix = "daily-refresh"
      }
    }
  })
}

# ---------------------------------------------------------------------------
# Daily trigger
# ---------------------------------------------------------------------------

resource "aws_scheduler_schedule" "daily_refresh" {
  name                         = "${local.prefix}-daily-refresh"
  schedule_expression          = var.schedule_expression
  schedule_expression_timezone = var.schedule_timezone
  state                        = local.schedule_enabled ? "ENABLED" : "DISABLED"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = "arn:aws:scheduler:::aws-sdk:batch:submitJob"
    role_arn = aws_iam_role.scheduler.arn
    input = jsonencode({
      JobName       = "daily-refresh"
      JobQueue      = aws_batch_job_queue.main.arn
      JobDefinition = aws_batch_job_definition.daily_refresh.arn
    })

    retry_policy {
      maximum_retry_attempts = 2
    }
  }
}
