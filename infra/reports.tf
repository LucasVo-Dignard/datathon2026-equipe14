# ---------------------------------------------------------------------------
# Private bucket for the simulated reports (Rapports tab, ../app/reports-store.js).
#
# One JSON object per report: reports/<username>/<id>.json. The web server
# reads and writes it; ../scripts/deploy-app.sh passes the bucket name to the
# app (REPORTS_BUCKET in /etc/chatbot.env).
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "reports" {
  bucket = "${local.prefix}-reports-${data.aws_caller_identity.current.account_id}"
  # Dev environments may be destroyed with their reports; prod keeps them.
  force_destroy = !local.is_prod

  tags = { Name = "${local.prefix}-reports" }
}

# Datathon rule: Block Public Access stays fully on.
resource "aws_s3_bucket_public_access_block" "reports" {
  bucket                  = aws_s3_bucket.reports.id
  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "reports" {
  bucket = aws_s3_bucket.reports.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "reports" {
  bucket = aws_s3_bucket.reports.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

data "aws_iam_policy_document" "reports_bucket" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.reports.arn,
      "${aws_s3_bucket.reports.arn}/*",
    ]
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

resource "aws_s3_bucket_policy" "reports" {
  bucket = aws_s3_bucket.reports.id
  policy = data.aws_iam_policy_document.reports_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.reports]
}

# The web server may only list, read, write and delete reports.
data "aws_iam_policy_document" "web_reports" {
  statement {
    sid       = "ListReports"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.reports.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["reports/*"]
    }
  }
  statement {
    sid       = "ReadWriteReports"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.reports.arn}/reports/*"]
  }
}

resource "aws_iam_role_policy" "web_reports" {
  name   = "reports-bucket"
  role   = aws_iam_role.web.id
  policy = data.aws_iam_policy_document.web_reports.json
}
