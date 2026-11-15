# ---------------------------------------------------------------------------
# AgentCore harnesses, called by the app (../app/research.js):
#   research  finds the facts on a company, returns a sourced report
#   reviewer  peer-reviews the reports of a judgment request
# Prompts are in ../agents/prompts/: edit them there, then apply.
# ---------------------------------------------------------------------------

locals {
  # Normalized so a CRLF checkout on Windows doesn't update the harnesses.
  prompts = {
    for name in ["research", "reviewer"] :
    name => chomp(replace(file("${path.module}/../agents/prompts/${name}.md"), "\r\n", "\n"))
  }

  # Tool names are @<harness tool name>/<gateway target>___<tool>.
  research_tools = [
    "@research/earnings-kb___Retrieve",
    "@research/bigdata___find_securities",
    "@research/bigdata___bigdata_company_tearsheet",
    "@research/bigdata___bigdata_search",
    "@research/bigdata___bigdata_market_tearsheet",
    "@research/bigdata___bigdata_etf_tearsheet",
    "@research/bigdata___bigdata_country_tearsheet",
    "@research/web-search___WebSearch",
  ]
  # AgentCore stores it as a float32: 0.3 would show a change on every plan.
  summary_ratio = 0.30000001192092896

  # No Bigdata.com for the reviewer, to save credits.
  reviewer_tools = [
    "@research/earnings-kb___Retrieve",
    "@research/web-search___WebSearch",
  ]
}

# --- IAM role of the harnesses (both) --------------------------------------

data "aws_iam_policy_document" "harness_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["bedrock-agentcore.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_iam_role" "harness" {
  name               = "${local.prefix}-harness"
  assume_role_policy = data.aws_iam_policy_document.harness_assume.json
}

data "aws_iam_policy_document" "harness" {
  statement {
    sid     = "BedrockModelInvocation"
    actions = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
    resources = [
      "arn:aws:bedrock:*::foundation-model/anthropic.claude-opus-5-5*",
      "arn:aws:bedrock:*:${local.account_id}:inference-profile/global.anthropic.claude-opus-5-5",
      "arn:aws:bedrock:*:${local.account_id}:inference-profile/us.anthropic.claude-opus-5-5",
    ]
  }
  # The harness runtime pulls its image from ECR Public.
  statement {
    sid       = "EcrPublicTokenAccess"
    actions   = ["ecr-public:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid       = "StsForEcrPublicPull"
    actions   = ["sts:GetServiceBearerToken"]
    resources = ["*"]
  }
  statement {
    sid = "XRayTracingAccess"
    actions = [
      "xray:PutTraceSegments",
      "xray:PutTelemetryRecords",
      "xray:GetSamplingRules",
      "xray:GetSamplingTargets",
    ]
    resources = ["*"]
  }
  statement {
    sid       = "CloudWatchLogsGroup"
    actions   = ["logs:CreateLogGroup", "logs:DescribeLogStreams"]
    resources = ["arn:aws:logs:${local.region}:${local.account_id}:log-group:/aws/bedrock-agentcore/runtimes/*"]
  }
  statement {
    sid       = "CloudWatchLogsDescribeGroups"
    actions   = ["logs:DescribeLogGroups"]
    resources = ["arn:aws:logs:${local.region}:${local.account_id}:log-group:*"]
  }
  statement {
    sid       = "CloudWatchLogsStream"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["arn:aws:logs:${local.region}:${local.account_id}:log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*"]
  }
  statement {
    sid       = "CloudWatchMetricsPublish"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = ["bedrock-agentcore"]
    }
  }
  statement {
    sid = "AgentCoreWorkloadIdentity"
    actions = [
      "bedrock-agentcore:GetWorkloadAccessToken",
      "bedrock-agentcore:GetWorkloadAccessTokenForJWT",
    ]
    resources = [
      "arn:aws:bedrock-agentcore:${local.region}:${local.account_id}:workload-identity-directory/default",
      "arn:aws:bedrock-agentcore:${local.region}:${local.account_id}:workload-identity-directory/default/workload-identity/*",
    ]
  }
  statement {
    sid       = "AgentCoreGatewayAccess"
    actions   = ["bedrock-agentcore:InvokeGateway"]
    resources = [aws_bedrockagentcore_gateway.research.gateway_arn]
  }
}

resource "aws_iam_role_policy" "harness" {
  name   = "research-harness"
  role   = aws_iam_role.harness.id
  policy = data.aws_iam_policy_document.harness.json
}

# --- Harnesses ---------------------------------------------------------------

resource "aws_bedrockagentcore_harness" "research" {
  harness_name       = "${local.harness_prefix}_research"
  execution_role_arn = aws_iam_role.harness.arn

  model {
    bedrock_model_config {
      model_id   = var.model_id
      max_tokens = 8000
      api_format = "converse_stream"
    }
  }

  system_prompt {
    text = local.prompts.research
  }

  tool {
    type = "agentcore_gateway"
    name = "research"
    config {
      agentcore_gateway {
        gateway_arn = aws_bedrockagentcore_gateway.research.gateway_arn
        outbound_auth {
          aws_iam = true
        }
      }
    }
  }

  allowed_tools   = local.research_tools
  max_iterations  = 7
  timeout_seconds = 180

  truncation {
    strategy = "summarization"
    config {
      summarization {
        summary_ratio            = local.summary_ratio
        preserve_recent_messages = 10
      }
    }
  }

  memory {
    disabled {}
  }

  environment {
    agentcore_runtime_environment {
      lifecycle_configuration {
        idle_runtime_session_timeout = 900
        max_lifetime                 = 28800
      }
      network_configuration {
        network_mode = "PUBLIC"
      }
    }
  }

  depends_on = [aws_iam_role_policy.harness]
}

resource "aws_bedrockagentcore_harness" "reviewer" {
  harness_name       = "${local.harness_prefix}_reviewer"
  execution_role_arn = aws_iam_role.harness.arn

  model {
    bedrock_model_config {
      model_id   = var.model_id
      max_tokens = 8000
      api_format = "converse_stream"
    }
  }

  system_prompt {
    text = local.prompts.reviewer
  }

  tool {
    type = "agentcore_gateway"
    name = "research"
    config {
      agentcore_gateway {
        gateway_arn = aws_bedrockagentcore_gateway.research.gateway_arn
        outbound_auth {
          aws_iam = true
        }
      }
    }
  }

  allowed_tools   = local.reviewer_tools
  max_iterations  = 3
  timeout_seconds = 150

  truncation {
    strategy = "summarization"
    config {
      summarization {
        summary_ratio            = local.summary_ratio
        preserve_recent_messages = 10
      }
    }
  }

  memory {
    disabled {}
  }

  environment {
    agentcore_runtime_environment {
      lifecycle_configuration {
        idle_runtime_session_timeout = 900
        max_lifetime                 = 28800
      }
      network_configuration {
        network_mode = "PUBLIC"
      }
    }
  }

  depends_on = [aws_iam_role_policy.harness]
}
