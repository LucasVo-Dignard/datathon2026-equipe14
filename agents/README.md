# Research agent (AgentCore)

When a chat question is about a specific company, the app's agent
(`app/bot.js`, Claude Opus 5.5 on Bedrock) calls its `research_company` tool.
That tool invokes the **AgentCore research harness** (`app/research.js`), which:

1. queries the **earnings releases knowledge base**, filtered on the company's
   stock symbol (Bedrock managed knowledge base, through AgentCore Gateway);
2. if the knowledge base has nothing useful, queries **Bigdata.com** (premium
   financial data, limited credits, at most 2 calls per research);
3. if still needed, searches the web with the **AgentCore Web Search Tool**
   (one search, a second only if the first gives nothing);
4. returns a factual report with its sources.

**Similar companies.** For questions asking for similar companies,
alternatives, competitors or peers, Claude first calls `find_similar_companies`
(`app/peers.js`): a query on the environment's database (`company_profiles`,
about 1,000 listed companies with sector, industry, country and market cap).
Candidates share the reference's industry first, then its sector; same country
ranks higher, then the closest market cap; other listings of the same company
are dropped. Claude only proposes companies it returns, then researches 2 or 3
of them in parallel. Needs `DATABASE_URL` (on the EC2, set automatically from
the environment's RDS); without it the tool is disabled.

**Peer review (judgment requests only).** Claude classifies each research
request (`request_type` of the tool): `factual` for objective information
(earnings, figures, news) or `judgment` for an opinion on a proposal (buy, sell,
switch, is it risky...). For a judgment, Claude researches every company
involved in the same turn, then a second harness, the **reviewer**, peer-reviews
the data the research agent selected: source quality, recency, balance between
arguments for and against, relevance to the proposal, missing data. It may make
one spot-check with the knowledge base or web search (no Bigdata.com, to save
credits), and returns a verdict (`SOLID`, `PARTIAL`, `WEAK`), issues and
counterpoints with their sources. Claude shows them in a "Points de vigilance"
section and states the verdict. One review per answer; never for a factual
request.

Every report that used Bigdata.com is saved back to the knowledge base
(`reports/<SYMBOL>/<SYMBOL>-research-<date>-<id>.txt`, `doc_type=research_report`),
so the same question is answered from the knowledge base next time, for free.

Claude then writes the answer for the user, in Markdown (rendered safely by
`app/public/markdown.js`), with a "Sources" section saying whether the data
comes from the official earnings release (knowledge base) or from the web.

```
app/bot.js (Claude, formatting) --research_company--> AgentCore harness "research"
                                                        | AgentCore Gateway (MCP, IAM auth)
                    +-------------------------+-------------------------+
                    | 1. earnings-kb___Retrieve | 2. bigdata___*        | 3. web-search___WebSearch
                    | (managed KB, by symbol)   | (limited credits)     | (last resort)
```

## Resources (environment `andre`, created with the AWS CLI)

Not managed by Terraform yet. All names start with `datathon2026-equipe14-andre`.

| Resource | Name / ID |
| --- | --- |
| S3 bucket (private, Block Public Access, SSE) | `datathon2026-equipe14-andre-earnings-779846826297` |
| Knowledge base (managed) + S3 data source | `datathon2026-equipe14-andre-earnings` (`RJ5TCZ4WGW`), data source `KWJIAQK8TJ` |
| IAM role of the knowledge base | `datathon2026-equipe14-andre-kb` (read-only on the bucket) |
| AgentCore Gateway (MCP, `AWS_IAM` inbound auth) | `datathon2026-equipe14-andre-research-nd2eo2zt0r` |
| Gateway targets | `earnings-kb` (connector `bedrock-knowledge-bases`, Retrieve), `web-search` (connector `web-search`) |
| IAM role of the gateway | `datathon2026-equipe14-andre-gateway` (Retrieve on this KB, InvokeWebSearch) |
| AgentCore harness | `datathon2026_equipe14_andre_research-bY6QdFJGK1` (Claude Opus 5.5, tools limited to the gateway, no memory, 6 iterations, 180 s) |
| AgentCore reviewer harness | `datathon2026_equipe14_andre_reviewer-ihPa2Cogb4` (Claude Opus 5.5, tools: knowledge base Retrieve and web search only, 1 spot-check, 3 iterations, 150 s) |
| IAM role of the harnesses | `datathon2026-equipe14-andre-harness` (research and reviewer) |
| Bigdata.com API key | Secrets Manager `datathon2026-equipe14-andre/bigdata-api-key` (JSON `{"api_key": "..."}`) |
| AgentCore Identity credential | `datathon2026-equipe14-andre-bigdata` (API key provider, `EXTERNAL`: reads the secret above) |
| Gateway target `bigdata` | `FQZ7Y2EEGX`, MCP server `https://mcp.bigdata.com/`, key sent in `x-api-key` |
| Gateway rate limit | 6 requests per minute on the `bigdata` target |
| Web server permissions | Terraform, `infra/iam.tf` (`invoke-research-harness`, `save-research-reports`) |

The app reads its configuration from environment variables: `RESEARCH_HARNESS_ARN`,
`RESEARCH_REVIEWER_ARN` (peer review; unset = no review),
`RESEARCH_KB_BUCKET`, `RESEARCH_KB_ID`, `RESEARCH_KB_DATA_SOURCE_ID` (where to save
reports) and `BIGDATA_DAILY_CALLS` (budget, default 9):

- locally: in `.env-dev` (gitignored), loaded by `npm run dev`;
- on the EC2: in `/etc/chatbot.env` (set by hand through SSM; lost if the
  instance is replaced, then set it again).

Without it, the agent still answers, without research.

## Add or update earnings releases

```bash
set -a; source .env-aws; set +a
OUT=$(mktemp -d)
python3 -I agents/knowledge-base/build_earnings_docs.py $OUT   # edit DOCS in the script first
aws s3 sync $OUT/ s3://datathon2026-equipe14-andre-earnings-779846826297/ --exclude "*" --include "reports/*" --include "metadata/*"
aws bedrock-agent start-ingestion-job --knowledge-base-id RJ5TCZ4WGW --data-source-id KWJIAQK8TJ
```

Documents go under `reports/<SYMBOL>/`. Each one needs a metadata file at the
same path under `metadata/` (`<file>.metadata.json`), with at least the
`symbol` attribute: the agent filters on it. The ingestion job reports
`numberOfMetadataDocumentsScanned`; it must match the number of documents.

## Test

```bash
# Knowledge base alone (filter on the symbol; ENB returns nothing)
aws bedrock-agent-runtime retrieve --knowledge-base-id RJ5TCZ4WGW \
  --retrieval-query text="quarterly revenue" \
  --retrieval-configuration '{"managedSearchConfiguration":{"numberOfResults":3,"filter":{"equals":{"key":"symbol","value":"MSFT"}}}}'
```

The harness has no AWS CLI invoke command (streaming API): use the app, or
`boto3` `invoke_harness` (see `app/research.js` for the request).

## Bigdata.com credits

- Measured cost: about **10 credits per Bigdata.com call** (a research makes at most
  2 calls, so about 20 credits, US$0.20). The plan started with 1,000 credits.
- The harness may only use 3 read tools: `find_securities`, `bigdata_company_tearsheet`
  and `bigdata_search` (`allowedTools`). The tools that write to the Bigdata.com
  account (monitors, watchlists, uploads) are not allowed.
- `app/research.js` counts the Bigdata.com calls per day (UTC) in
  `bigdata-usage.json` next to the app data. When less than one research (3 calls)
  is left in `BIGDATA_DAILY_CALLS`, the harness is invoked without the Bigdata.com
  tools until the next day. Each research reserves 2 calls before it starts, so
  parallel researches (judgment requests) cannot exceed the budget together. Each server (local, EC2) has its own counter, but they
  share the same Bigdata.com account.
- Check the balance on https://app.bigdata.com/usage, or with the free
  Bigdata.com MCP tool `bigdata_help` (it is not in the agent's allowed tools).
- Rotate the key: `aws secretsmanager put-secret-value --secret-id
  datathon2026-equipe14-andre/bigdata-api-key --secret-string '{"api_key":"..."}'`
  (no other change: the credential provider reads the secret).

## Cost

The managed knowledge base, the gateway and the harness are billed per use
(no idle cost apart from the few KB of S3 storage). Each research is one
harness session (Claude Opus 5.5) plus a few web searches.

## Clean up

Delete in this order: the two harnesses, gateway rate limit, gateway targets, gateway,
API key credential provider, data source, knowledge base, bucket (empty it
first), the three IAM roles, then the Bigdata.com secret.
