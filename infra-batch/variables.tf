variable "project_name" {
  description = "Prefix used for resource names and tags. Must match ../infra and ../infra-db, whose resources are found by name."
  type        = string
  default     = "datathon2026-equipe14"
}

variable "region" {
  description = "AWS region. Leave null to use AWS_DEFAULT_REGION from the environment."
  type        = string
  default     = null
}

variable "image_tag" {
  description = "Tag of the job image in ECR. ../scripts/deploy-batch.sh pushes the git SHA and \"latest\"; pin a SHA here to roll back."
  type        = string
  default     = "latest"
}

variable "refresh_enabled" {
  description = "When false, the daily refresh job starts and exits immediately without fetching or writing anything (REFRESH_ENABLED=false). Does not affect the news and reports jobs. Default: on in prod, off in dev environments."
  type        = bool
  default     = null
}

variable "schedule_enabled" {
  description = "Set to false to pause the daily and news runs (and the scheduled reports, unless reports_schedule_enabled is set) without destroying anything. Default: on in prod, off in dev environments (run the jobs by hand there)."
  type        = bool
  default     = null
}

variable "schedule_expression" {
  description = "When the job runs, in schedule_timezone. Default: weekdays at 18:00, after the market close."
  type        = string
  default     = "cron(0 18 ? * MON-FRI *)"
}

variable "schedule_timezone" {
  description = "Time zone of schedule_expression (handles daylight saving time)."
  type        = string
  default     = "America/Toronto"
}

variable "job_vcpu" {
  description = "Fargate vCPU for the job. The job mostly waits on the network, so the minimum is enough."
  type        = string
  default     = "0.25"
}

variable "job_memory_mib" {
  description = "Fargate memory in MiB (0.25 vCPU allows 512, 1024 or 2048). The Node jobs fit in 1024."
  type        = number
  default     = 1024
}

variable "job_timeout_seconds" {
  description = "Batch stops a run that takes longer than this. Default: 4 h in prod (~1 000 tracked symbols at 60 Yahoo calls/min take about 2 h 15), 30 min in dev."
  type        = number
  default     = null
}

variable "log_retention_days" {
  description = "Days of job logs kept in CloudWatch."
  type        = number
  default     = 14
}

variable "news_schedule_expression" {
  description = "When the news job runs, in schedule_timezone. Default: every 2 hours, 7:00 to 23:00."
  type        = string
  default     = "cron(0 7-23/2 * * ? *)"
}

variable "reports_schedule_expression" {
  description = "When the scheduled reports job runs, in schedule_timezone. Default: every hour on the hour, since users pick the hour of their reports."
  type        = string
  default     = "cron(0 * * * ? *)"
}

variable "reports_schedule_enabled" {
  description = "Set to false to pause the scheduled reports, or true to run them in a dev environment. Default: same as schedule_enabled."
  type        = bool
  default     = null
}

