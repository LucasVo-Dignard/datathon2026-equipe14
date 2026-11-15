# ---------------------------------------------------------------------------
# AgentCore Gateway: one MCP endpoint (IAM auth) with the research tools.
#   earnings-kb  knowledge base Retrieve, filtered on the stock symbol
#   bigdata      Bigdata.com MCP server (limited credits, rate limited)
#   web-search   AgentCore web search
# ---------------------------------------------------------------------------

# --- Bigdata.com API key ---------------------------------------------------
# Terraform creates the secret, never its value (which would end up in the
# state). Put the key in once, see ../README.md.

resource "aws_secretsmanager_secret" "bigdata" {
  name        = "${local.prefix}/bigdata-api-key"
  description = "Bigdata.com API key (${local.env} research agent)"
  # Dev environments can be destroyed and recreated under the same name.
  recovery_window_in_days = local.is_prod ? 30 : 0
}

# AgentCore Identity reads the key from the secret above on every call.
resource "aws_bedrockagentcore_api_key_credential_provider" "bigdata" {
  name                  = "${local.prefix}-bigdata"
  api_key_secret_source = "EXTERNAL"

  api_key_secret_config {
    secret_id = aws_secretsmanager_secret.bigdata.arn
    json_key  = "api_key"
  }
}

# --- IAM role of the gateway -----------------------------------------------

data "aws_iam_policy_document" "gateway_assume" {
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
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:bedrock-agentcore:${local.region}:${local.account_id}:gateway/*"]
    }
  }
}

resource "aws_iam_role" "gateway" {
  name               = "${local.prefix}-gateway"
  assume_role_policy = data.aws_iam_policy_document.gateway_assume.json
}

data "aws_iam_policy_document" "gateway_tools" {
  statement {
    sid       = "ValidateKnowledgeBase"
    actions   = ["bedrock:GetKnowledgeBase"]
    resources = [aws_bedrockagent_knowledge_base.earnings.arn]
  }
  statement {
    sid       = "RetrieveFromKnowledgeBase"
    actions   = ["bedrock:Retrieve"]
    resources = [aws_bedrockagent_knowledge_base.earnings.arn]
  }
  statement {
    sid       = "InvokeGateway"
    actions   = ["bedrock-agentcore:InvokeGateway"]
    resources = ["arn:aws:bedrock-agentcore:${local.region}:${local.account_id}:gateway/*"]
  }
  statement {
    sid       = "InvokeWebSearch"
    actions   = ["bedrock-agentcore:InvokeWebSearch"]
    resources = ["arn:aws:bedrock-agentcore:${local.region}:aws:tool/web-search.v1"]
  }
}

resource "aws_iam_role_policy" "gateway_tools" {
  name   = "kb-and-web-search"
  role   = aws_iam_role.gateway.id
  policy = data.aws_iam_policy_document.gateway_tools.json
}

data "aws_iam_policy_document" "gateway_bigdata" {
  statement {
    sid     = "BigdataApiKeyFromTokenVault"
    actions = ["bedrock-agentcore:GetResourceApiKey"]
    resources = [
      "arn:aws:bedrock-agentcore:${local.region}:${local.account_id}:token-vault/default",
      aws_bedrockagentcore_api_key_credential_provider.bigdata.credential_provider_arn,
      "arn:aws:bedrock-agentcore:${local.region}:${local.account_id}:workload-identity-directory/default",
      "arn:aws:bedrock-agentcore:${local.region}:${local.account_id}:workload-identity-directory/default/workload-identity/*",
    ]
  }
  statement {
    sid     = "WorkloadIdentityToken"
    actions = ["bedrock-agentcore:GetWorkloadAccessToken"]
    resources = [
      "arn:aws:bedrock-agentcore:${local.region}:${local.account_id}:workload-identity-directory/default",
      "arn:aws:bedrock-agentcore:${local.region}:${local.account_id}:workload-identity-directory/default/workload-identity/*",
    ]
  }
  statement {
    sid       = "BigdataApiKeySecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.bigdata.arn]
  }
}

resource "aws_iam_role_policy" "gateway_bigdata" {
  name   = "bigdata-api-key"
  role   = aws_iam_role.gateway.id
  policy = data.aws_iam_policy_document.gateway_bigdata.json
}

# --- Gateway and targets ---------------------------------------------------

resource "aws_bedrockagentcore_gateway" "research" {
  name            = "${local.prefix}-research"
  description     = "Research tools: earnings KB, Bigdata.com, web search (${local.env})"
  role_arn        = aws_iam_role.gateway.arn
  authorizer_type = "AWS_IAM"
  protocol_type   = "MCP"
}

resource "aws_bedrockagentcore_gateway_target" "earnings_kb" {
  name               = "earnings-kb"
  gateway_identifier = aws_bedrockagentcore_gateway.research.gateway_id
  description        = "Earnings releases knowledge base (filter by symbol)"

  credential_provider_configuration {
    gateway_iam_role {}
  }

  target_configuration {
    mcp {
      connector {
        source {
          connector_id = "bedrock-knowledge-bases"
          version      = "1.0.0"
        }

        configuration {
          name        = "Retrieve"
          description = "Search the earnings releases knowledge base. Always filter on the company's stock symbol with retrievalConfiguration.managedSearchConfiguration.filter = {\"equals\": {\"key\": \"symbol\", \"value\": \"<SYMBOL>\"}} (uppercase ticker, e.g. AAPL). An empty result means no earnings document for that company is in the knowledge base."
          parameter_values = jsonencode({
            knowledgeBaseId = aws_bedrockagent_knowledge_base.earnings.id
            retrievalConfiguration = {
              managedSearchConfiguration = { numberOfResults = 5 }
            }
          })

          parameter_override {
            path        = "$.retrievalQuery.text"
            description = "What to look for in the earnings release, e.g. 'quarterly revenue, EPS and guidance'."
            visible     = true
          }
          parameter_override {
            path        = "$.retrievalConfiguration.managedSearchConfiguration.filter"
            description = "Metadata filter. Use {\"equals\": {\"key\": \"symbol\", \"value\": \"<SYMBOL>\"}}."
            visible     = true
          }
        }
      }
    }
  }

  depends_on = [aws_iam_role_policy.gateway_tools]
}

resource "aws_bedrockagentcore_gateway_target" "web_search" {
  name               = "web-search"
  gateway_identifier = aws_bedrockagentcore_gateway.research.gateway_id
  description        = "Managed web search"

  credential_provider_configuration {
    gateway_iam_role {}
  }

  target_configuration {
    mcp {
      connector {
        source {
          connector_id = "web-search"
          version      = "1.3.0"
        }

        configuration {
          name             = "WebSearch"
          parameter_values = jsonencode({})
        }
      }
    }
  }

  depends_on = [aws_iam_role_policy.gateway_tools]
}

# The gateway lists the Bigdata.com tools when the target is created, so the
# key must already be in the secret (see ../README.md).
resource "aws_bedrockagentcore_gateway_target" "bigdata" {
  name               = "bigdata"
  gateway_identifier = aws_bedrockagentcore_gateway.research.gateway_id
  description        = "Bigdata.com financial search (MCP, limited credits)"

  credential_provider_configuration {
    api_key {
      provider_arn              = aws_bedrockagentcore_api_key_credential_provider.bigdata.credential_provider_arn
      credential_location       = "HEADER"
      credential_parameter_name = "x-api-key"
    }
  }

  target_configuration {
    mcp {
      mcp_server {
        endpoint = var.bigdata_mcp_url
      }
    }
  }

  depends_on = [aws_iam_role_policy.gateway_bigdata]
}

# Protects the Bigdata.com credits. The aws provider has no resource for
# gateway rate limits yet, hence awscc.
resource "awscc_bedrockagentcore_gateway_rate_limit" "bigdata" {
  gateway_identifier = aws_bedrockagentcore_gateway.research.gateway_id
  description        = "Protect the limited Bigdata.com credits"
  dimension_keys     = ["targetName"]

  entries = [{
    dimensions = { targetName = aws_bedrockagentcore_gateway_target.bigdata.name }
    requests = [{
      rate   = var.bigdata_requests_per_minute
      period = "minute"
    }]
  }]
}
