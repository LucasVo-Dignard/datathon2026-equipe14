# ---------------------------------------------------------------------------
# Price-move alerts by email (Amazon SES).
#
#   - the web app records subscriptions, gets addresses verified while the
#     account is in the SES sandbox, and sends test emails (../app/notifications.js);
#   - the daily job sends the real alerts (../src/marketdata/jobs/price-alerts.js);
#     ../infra-batch gives its role the same send permission.
#
# Sender: the team mailbox, one address per environment so each one has its
# own SES identity (an identity is account-wide: two workspaces can't own the
# same address). Plus-addressing keeps a single inbox:
#   prod -> datathon2026.equipe14@gmail.com, youcef -> datathon2026.equipe14+youcef@gmail.com
# SES emails a verification link to it once, after the first apply: someone
# with access to the team mailbox must click it, or nothing is sent.
# ---------------------------------------------------------------------------

variable "alerts_enabled" {
  description = "Send price-move alerts by email (SES) in this environment."
  type        = bool
  default     = true
}

variable "alerts_sender_email" {
  description = "Override the sender of the price alerts (default: the team mailbox, + the environment name outside prod)."
  type        = string
  default     = null

  validation {
    condition     = var.alerts_sender_email == null || can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.alerts_sender_email))
    error_message = "alerts_sender_email must be an email address."
  }
}

locals {
  alerts_enabled = var.alerts_enabled
  alerts_sender = coalesce(
    var.alerts_sender_email,
    local.is_prod ? "datathon2026.equipe14@gmail.com" : "datathon2026.equipe14+${local.env}@gmail.com",
  )
  ses_identities = "arn:aws:ses:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:identity/*"
}

resource "aws_sesv2_email_identity" "alerts_sender" {
  count          = local.alerts_enabled ? 1 : 0
  email_identity = local.alerts_sender
}

# Every alert goes through this set: TLS required, and addresses that bounce
# or complain are put on the suppression list (kept for production access).
resource "aws_sesv2_configuration_set" "alerts" {
  count                  = local.alerts_enabled ? 1 : 0
  configuration_set_name = "${local.prefix}-alerts"

  delivery_options {
    tls_policy = "REQUIRE"
  }

  reputation_options {
    reputation_metrics_enabled = true
  }

  suppression_options {
    suppressed_reasons = ["BOUNCE", "COMPLAINT"]
  }
}

# Read by ../infra-batch (that stack can't see this one's variables). Not secret.
resource "aws_ssm_parameter" "alerts_sender" {
  count = local.alerts_enabled ? 1 : 0
  name  = "/${local.prefix}/alerts/sender"
  type  = "String"
  value = local.alerts_sender
}

# The web app: send from the alerts address only, through the alerts set, and
# manage recipient verification while the account is in the sandbox.
data "aws_iam_policy_document" "web_alerts" {
  count = local.alerts_enabled ? 1 : 0

  statement {
    sid       = "SendAlertsOnly"
    actions   = ["ses:SendEmail"]
    resources = [local.ses_identities, aws_sesv2_configuration_set.alerts[0].arn]
    condition {
      test     = "StringEquals"
      variable = "ses:FromAddress"
      values   = [local.alerts_sender]
    }
  }

  statement {
    sid       = "VerifyRecipientsInSandbox"
    actions   = ["ses:CreateEmailIdentity", "ses:GetEmailIdentity"]
    resources = [local.ses_identities]
  }

  statement {
    sid       = "ReadSandboxStatus"
    actions   = ["ses:GetAccount"]
    resources = ["*"] # account-level call, no resource
  }
}

resource "aws_iam_role_policy" "web_alerts" {
  count  = local.alerts_enabled ? 1 : 0
  name   = "ses-price-alerts"
  role   = aws_iam_role.web.id
  policy = data.aws_iam_policy_document.web_alerts[0].json
}
