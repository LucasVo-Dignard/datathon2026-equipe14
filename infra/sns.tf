# ---------------------------------------------------------------------------
# Price-move alerts by email (Amazon SNS).
#
# One topic per environment. Each user's email subscription has a filter
# policy on the "username" message attribute, so a message published for a
# user reaches that user only.
#
#   - the web app subscribes / unsubscribes users and sends test emails
#     (../app/notifications.js), with the permissions below;
#   - the daily job publishes the real alerts (../src/marketdata/jobs/price_alerts.py);
#     ../infra-batch attaches its publish permission (that stack owns its role).
# ---------------------------------------------------------------------------

resource "aws_sns_topic" "price_alerts" {
  name         = "${local.prefix}-price-alerts"
  display_name = "Alertes portefeuille" # sender name of the emails

  # Encrypted at rest with the AWS managed key for SNS (no key to manage).
  kms_master_key_id = "alias/aws/sns"
}

# Only this account may use the topic, and only over TLS.
data "aws_iam_policy_document" "price_alerts_topic" {
  statement {
    sid     = "OwnerAccountOnly"
    actions = ["sns:Publish", "sns:Subscribe", "sns:GetTopicAttributes", "sns:ListSubscriptionsByTopic"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
    resources = [aws_sns_topic.price_alerts.arn]
  }

  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["sns:*"]
    resources = [aws_sns_topic.price_alerts.arn]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_sns_topic_policy" "price_alerts" {
  arn    = aws_sns_topic.price_alerts.arn
  policy = data.aws_iam_policy_document.price_alerts_topic.json
}

# The web app: email subscriptions on this topic only, and test emails.
data "aws_iam_policy_document" "web_price_alerts" {
  statement {
    actions = [
      "sns:Subscribe",
      "sns:Unsubscribe",
      "sns:GetSubscriptionAttributes",
      "sns:Publish",
    ]
    resources = [aws_sns_topic.price_alerts.arn]
  }
}

resource "aws_iam_role_policy" "web_price_alerts" {
  name   = "sns-price-alerts"
  role   = aws_iam_role.web.id
  policy = data.aws_iam_policy_document.web_price_alerts.json
}
