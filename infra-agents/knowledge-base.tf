# ---------------------------------------------------------------------------
# Earnings knowledge base: official earnings releases and the saved research
# reports, in a private bucket (reports/<SYMBOL>/, metadata under metadata/).
# Documents are added by hand or by the app, never by Terraform.
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "earnings" {
  bucket = "${local.prefix}-earnings-${local.account_id}"
  # Dev environments may be destroyed with their documents; prod keeps them.
  force_destroy = !local.is_prod
}

# Datathon rule: Block Public Access stays fully on.
resource "aws_s3_bucket_public_access_block" "earnings" {
  bucket                  = aws_s3_bucket.earnings.id
  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "earnings" {
  bucket = aws_s3_bucket.earnings.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "earnings" {
  bucket = aws_s3_bucket.earnings.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

data "aws_iam_policy_document" "earnings_bucket" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.earnings.arn,
      "${aws_s3_bucket.earnings.arn}/*",
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

resource "aws_s3_bucket_policy" "earnings" {
  bucket = aws_s3_bucket.earnings.id
  policy = data.aws_iam_policy_document.earnings_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.earnings]
}

# --- IAM role of the knowledge base: read-only on the bucket ---------------

data "aws_iam_policy_document" "kb_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["bedrock.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
    condition {
      test     = "ArnLike"
      variable = "AWS:SourceArn"
      values   = ["arn:aws:bedrock:${local.region}:${local.account_id}:knowledge-base/*"]
    }
  }
}

resource "aws_iam_role" "kb" {
  name               = "${local.prefix}-kb"
  assume_role_policy = data.aws_iam_policy_document.kb_assume.json
}

data "aws_iam_policy_document" "kb_read_bucket" {
  statement {
    sid       = "S3ListBucket"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.earnings.arn]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceAccount"
      values   = [local.account_id]
    }
  }
  statement {
    sid       = "S3GetObject"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.earnings.arn}/*"]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_iam_role_policy" "kb_read_bucket" {
  name   = "read-earnings-bucket"
  role   = aws_iam_role.kb.id
  policy = data.aws_iam_policy_document.kb_read_bucket.json
}

# --- Knowledge base and its S3 data source ---------------------------------

resource "aws_bedrockagent_knowledge_base" "earnings" {
  name        = "${local.prefix}-earnings"
  description = "Earnings releases and research reports (${local.env} research agent)"
  role_arn    = aws_iam_role.kb.arn

  # Managed knowledge base: Bedrock runs the vector store and the embeddings.
  # Changing this block replaces the knowledge base (and loses its index).
  knowledge_base_configuration {
    type = "MANAGED"
    managed_knowledge_base_configuration {
      embedding_model_type = "MANAGED"
    }
  }

  depends_on = [aws_iam_role_policy.kb_read_bucket]
}

resource "aws_bedrockagent_data_source" "earnings" {
  knowledge_base_id    = aws_bedrockagent_knowledge_base.earnings.id
  name                 = "earnings-s3"
  description          = "Earnings releases in s3://${aws_s3_bucket.earnings.bucket}/reports/"
  data_deletion_policy = "DELETE"

  data_source_configuration {
    type = "MANAGED_KNOWLEDGE_BASE_CONNECTOR"

    managed_knowledge_base_connector_configuration {
      # Documents under reports/, each with <file>.metadata.json under
      # metadata/ (the "symbol" attribute the agent filters on).
      connector_parameters = jsonencode({
        type                = "S3"
        version             = "1"
        aclEnabled          = false
        metadataFilesPrefix = "metadata/"
        connectionConfiguration = {
          bucketName           = aws_s3_bucket.earnings.bucket
          bucketOwnerAccountId = local.account_id
        }
        filterConfiguration = {
          maxFileSizeInMegaBytes = "50"
          inclusionPrefixes      = ["reports/"]
        }
      })

      deletion_protection_configuration {
        deletion_protection_status    = "DISABLED"
        deletion_protection_threshold = 15
      }

      media_extraction_configuration {
        image_extraction_configuration {
          image_extraction_status = "ENABLED"
        }
      }
    }
  }
}
