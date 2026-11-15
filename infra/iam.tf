# ---------------------------------------------------------------------------
# IAM role of the web server.
#
# SSM lets us run commands on the instance (e.g. database migrations, see
# ../db/migrate.py) without opening SSH: the SSM agent connects out to AWS,
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
  name               = "${local.prefix}-web"
  assume_role_policy = data.aws_iam_policy_document.web_assume.json
}

resource "aws_iam_role_policy_attachment" "web_ssm" {
  role       = aws_iam_role.web.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "web" {
  name = "${local.prefix}-web"
  role = aws_iam_role.web.name
}

# The app's agent (app/bot.js) calls Claude through Claude in Amazon Bedrock
# (bedrock-mantle endpoint).
resource "aws_iam_role_policy" "web_bedrock" {
  name = "bedrock-inference"
  role = aws_iam_role.web.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "bedrock-mantle:CreateInference"
      Resource = "*"
    }]
  })
}

# The app's agent calls this environment's AgentCore research and reviewer
# harnesses (app/research.js), created by ../infra-agents.
# Their names follow the environment prefix: <prefix with "_">_research-<suffix>
# and <prefix with "_">_reviewer-<suffix>.
resource "aws_iam_role_policy" "web_research_harness" {
  name = "invoke-research-harness"
  role = aws_iam_role.web.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = ["bedrock-agentcore:InvokeHarness", "bedrock-agentcore:InvokeAgentRuntime"]
      Resource = [
        "arn:aws:bedrock-agentcore:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:harness/${replace(local.prefix, "-", "_")}_research-*",
        "arn:aws:bedrock-agentcore:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:harness/${replace(local.prefix, "-", "_")}_reviewer-*",
      ]
    }]
  })
}

# The app fetches the Bigdata.com market tearsheet once a day through the
# research gateway (app/research.js), and shares it between researches.
# The gateway is created by ../infra-agents, its name follows the environment
# prefix: <prefix>-research-<suffix>.
resource "aws_iam_role_policy" "web_research_gateway" {
  name = "invoke-research-gateway"
  role = aws_iam_role.web.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "bedrock-agentcore:InvokeGateway"
      Resource = "arn:aws:bedrock-agentcore:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:gateway/${local.prefix}-research-*"
    }]
  })
}

# The research agent saves the reports that used Bigdata.com to the earnings
# knowledge base (app/research.js), so the same question costs no credits
# next time. Bucket and knowledge base are created by ../infra-agents;
# the bucket name follows the environment prefix.
resource "aws_iam_role_policy" "web_research_kb_write" {
  name = "save-research-reports"
  role = aws_iam_role.web.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "WriteReports"
        Effect = "Allow"
        Action = "s3:PutObject"
        Resource = [
          "arn:aws:s3:::${local.prefix}-earnings-${data.aws_caller_identity.current.account_id}/reports/*",
          "arn:aws:s3:::${local.prefix}-earnings-${data.aws_caller_identity.current.account_id}/metadata/*",
        ]
      },
      {
        Sid      = "SyncKnowledgeBase"
        Effect   = "Allow"
        Action   = "bedrock:StartIngestionJob"
        Resource = "arn:aws:bedrock:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:knowledge-base/*"
      },
    ]
  })
}
