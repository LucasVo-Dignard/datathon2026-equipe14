# ---------------------------------------------------------------------------
# Running Flyway migrations on RDS (see ../db/README.md).
#
# db/migrate.py uploads db/ as a bundle to this bucket, then asks the web
# server (through SSM) to download it and run Flyway against the database.
# The web server is the only machine allowed to reach the database.
# ---------------------------------------------------------------------------

data "aws_caller_identity" "current" {}

# Created in ../infra (iam.tf).
data "aws_iam_role" "web" {
  name = "${local.prefix}-web"
}

# --- Private bucket for migration bundles ------------------------------------

resource "aws_s3_bucket" "migrations" {
  bucket = "${local.prefix}-migrations-${data.aws_caller_identity.current.account_id}"
  # Holds only short-lived copies of db/, so destroy may empty it.
  force_destroy = true

  tags = { Name = "${local.prefix}-migrations" }
}

# Datathon rule: Block Public Access stays fully on.
resource "aws_s3_bucket_public_access_block" "migrations" {
  bucket                  = aws_s3_bucket.migrations.id
  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "migrations" {
  bucket = aws_s3_bucket.migrations.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "migrations" {
  bucket = aws_s3_bucket.migrations.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "migrations" {
  bucket = aws_s3_bucket.migrations.id
  rule {
    id     = "expire-bundles"
    status = "Enabled"
    filter {
      prefix = "bundles/"
    }
    expiration {
      days = 7
    }
  }
}

data "aws_iam_policy_document" "migrations_bucket" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.migrations.arn,
      "${aws_s3_bucket.migrations.arn}/*",
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

resource "aws_s3_bucket_policy" "migrations" {
  bucket = aws_s3_bucket.migrations.id
  policy = data.aws_iam_policy_document.migrations_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.migrations]
}

# --- What the web server may do for migrations --------------------------------
# Only: read the DB master secret, and read bundles from the bucket above.

data "aws_iam_policy_document" "web_migrations" {
  statement {
    sid       = "ReadDbMasterSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_db_instance.main.master_user_secret[0].secret_arn]
  }

  statement {
    sid       = "ReadMigrationBundles"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.migrations.arn}/bundles/*"]
  }
}

resource "aws_iam_role_policy" "web_migrations" {
  name   = "${local.prefix}-db-migrations"
  role   = data.aws_iam_role.web.name
  policy = data.aws_iam_policy_document.web_migrations.json
}
