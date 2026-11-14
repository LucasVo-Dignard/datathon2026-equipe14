# ---------------------------------------------------------------------------
# Private container registry for the job image (./Dockerfile).
#
# Same setup as the web app's repository (../infra/ecr.tf), but owned by this
# stack: ../scripts/deploy-batch.sh builds the image and pushes it here.
# Only the Batch execution role may pull from it (iam.tf).
# ---------------------------------------------------------------------------

resource "aws_ecr_repository" "job" {
  name                 = "${local.prefix}-batch"
  image_tag_mutability = "MUTABLE" # "latest" is moved on every deploy; git-SHA tags are kept too
  force_delete         = true      # let `terraform destroy` remove the repo even if it holds images

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}

# Keep storage (and cost) small: only the 10 most recent images.
resource "aws_ecr_lifecycle_policy" "job" {
  repository = aws_ecr_repository.job.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the 10 most recent images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 10
      }
      action = { type = "expire" }
    }]
  })
}

# Fargate pulls the image with the execution role. Pull-only, and only this
# repository (the AWS managed execution policy would allow every repository).
data "aws_iam_policy_document" "execution_ecr_pull" {
  statement {
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"] # this action does not support resource-level permissions
  }
  statement {
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [aws_ecr_repository.job.arn]
  }
}

resource "aws_iam_role_policy" "execution_ecr_pull" {
  name   = "ecr-pull-batch"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_ecr_pull.json
}
