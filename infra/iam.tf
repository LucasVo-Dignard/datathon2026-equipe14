# ---------------------------------------------------------------------------
# IAM role of the web server.
#
# SSM lets us run commands on the instance (e.g. database migrations, see
# ../db/README.md) without opening SSH: the SSM agent connects out to AWS,
# so no inbound rule is needed.
#
# Stack-specific permissions are attached by the stacks that own the
# resources (../infra-db attaches read access to the DB secret and the
# migrations bucket), so this stack doesn't depend on them.
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "web_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "web" {
  name               = "${var.project_name}-web"
  assume_role_policy = data.aws_iam_policy_document.web_assume.json
}

resource "aws_iam_role_policy_attachment" "web_ssm" {
  role       = aws_iam_role.web.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "web" {
  name = "${var.project_name}-web"
  role = aws_iam_role.web.name
}
