# ---------------------------------------------------------------------------
# Private container registry for the web app image (../Dockerfile).
#
# scripts/deploy-app.sh builds the image, pushes it here and restarts the
# service on the web server through SSM. The server only gets pull access.
# ---------------------------------------------------------------------------

resource "aws_ecr_repository" "app" {
  name                 = "${var.project_name}-app"
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
resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name
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

# The web server may pull from this repository only.
data "aws_iam_policy_document" "web_ecr_pull" {
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
    resources = [aws_ecr_repository.app.arn]
  }
}

resource "aws_iam_role_policy" "web_ecr_pull" {
  name   = "ecr-pull-app"
  role   = aws_iam_role.web.id
  policy = data.aws_iam_policy_document.web_ecr_pull.json
}
