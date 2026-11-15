# Research agent (AgentCore)

When a chat question is about a specific company, the app's agent
(`app/bot.js`, Claude Opus 5.5 on Bedrock) calls its `research_company` tool.
That tool invokes the **AgentCore research harness** (`app/research.js`), which:

1. queries the **earnings releases knowledge base**, filtered on the company's
   stock symbol (Bedrock managed knowledge base, through AgentCore Gateway);
2. if the knowledge base has nothing useful, queries **Bigdata.com** (premium
   financial data, limited credits, at most 3 calls per research: the company,
   plus one sector, market or economic context call when the question needs it);
3. if still needed, searches the web with the **AgentCore Web Search Tool**
   (one search, a second only if the first gives nothing);
4. returns a factual report with its sources.

**Client's portfolio.** `app/portfolio-context.js` joins the logged-in client's
positions (CAD values, gains, weights) with the database (`company_profiles`:
sector, industry, country), computes the breakdowns by sector, industry, country
and listing currency, and checks the investor profile's guardrails (largest
sector, number of assets, crypto share, excluded activities mapped to database
industries; volatility is not computed, the history being fictional). A compact
summary is added to Claude's system prompt on every message; the full view is
returned by the `get_portfolio_details` tool (no parameters: always the
logged-in user's portfolio). For judgment requests, the summary is also given to
the reviewer, which judges the data against the client's current exposure.

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
(`reports/<TICKER>/<TICKER>-research-<date>-<id>.txt`, `doc_type=research_report`),
so the same question is answered from the knowledge base next time, for free.
Saving needs all three `RESEARCH_KB_*` variables and a ticker; the ticker has no
exchange suffix (`TD.TO` -> `TD`, see `app/peers.js`).

Claude then writes the answer for the user, in Markdown (rendered safely by
`app/public/markdown.js`). Each fact from the report is cited inline as
`[@Short name](url)`, shown as a small source button; the report numbers its
sources S1, S2... and the review R1, R2.... A closing italic line says where
the data comes from: knowledge base (official release or saved research),
Bigdata.com or the web.

The chat agent's tools are `research_company`, `find_similar_companies`,
`get_portfolio_details` and `set_report_schedule` (automatic portfolio reports).
It uses `AGENT_MODEL` (default Claude Opus 5.5) and `AGENT_EFFORT` (default
`low`), at most 4 model turns per reply (`MAX_STEPS`), and retries a refused
request on Claude Opus 4.8 (SDK refusal fallback).

```
app/bot.js (Claude, formatting) --research_company--> AgentCore harness "research"
                                                        | AgentCore Gateway (MCP, IAM auth)
                    +-------------------------+-------------------------+
                    | 1. earnings-kb___Retrieve | 2. bigdata___*        | 3. web-search___WebSearch
                    | (managed KB, by symbol)   | (limited credits)     | (last resort)
```

## Resources (created with the AWS CLI)

Research exists only in the `andre` and prod environments; the others run
without it. In the tables below, IDs are in parentheses or labelled, except
the gateway and harnesses: their value is the ID, which is the name plus a
generated suffix (gateway `datathon2026-equipe14-andre-research`, harness
`datathon2026_equipe14_andre_research`). `scripts/deploy-app.sh` looks
resources up by their bare name.

### Environment `andre`

Not managed by Terraform yet. All names start with `datathon2026-equipe14-andre`.

| Resource | Name / ID |
| --- | --- |
| S3 bucket (private, Block Public Access, SSE) | `datathon2026-equipe14-andre-earnings-779846826297` |
| Knowledge base (managed) + S3 data source | `datathon2026-equipe14-andre-earnings` (`RJ5TCZ4WGW`), data source `KWJIAQK8TJ` |
| IAM role of the knowledge base | `datathon2026-equipe14-andre-kb` (read-only on the bucket) |
| AgentCore Gateway (MCP, `AWS_IAM` inbound auth) | `datathon2026-equipe14-andre-research-nd2eo2zt0r` |
| Gateway targets | `earnings-kb` (connector `bedrock-knowledge-bases`, Retrieve), `web-search` (connector `web-search`) |
| IAM role of the gateway | `datathon2026-equipe14-andre-gateway` (Retrieve on this KB, InvokeWebSearch) |
| AgentCore harness | `datathon2026_equipe14_andre_research-bY6QdFJGK1` (Claude Opus 5.5, tools limited to the gateway, no memory, 7 iterations, 180 s) |
| AgentCore reviewer harness | `datathon2026_equipe14_andre_reviewer-ihPa2Cogb4` (Claude Opus 5.5, tools: knowledge base Retrieve and web search only, 1 spot-check, 3 iterations, 150 s) |
| IAM role of the harnesses | `datathon2026-equipe14-andre-harness` (research and reviewer) |
| Bigdata.com API key | Secrets Manager `datathon2026-equipe14-andre/bigdata-api-key` (JSON `{"api_key": "..."}`) |
| AgentCore Identity credential | `datathon2026-equipe14-andre-bigdata` (API key provider, `EXTERNAL`: reads the secret above) |
| Gateway target `bigdata` | `FQZ7Y2EEGX`, MCP server `https://mcp.bigdata.com/`, key sent in `x-api-key` |
| Gateway rate limit | 6 requests per minute on the `bigdata` target |
| Web server permissions | Terraform, `infra/iam.tf` (`invoke-research-harness`, `invoke-research-gateway`, `save-research-reports`) |

### Prod (created the same way, names without `-andre`)

| Resource | Name / ID |
| --- | --- |
| S3 bucket | `datathon2026-equipe14-earnings-779846826297` (documents copied from andre) |
| Knowledge base + data source | `datathon2026-equipe14-earnings` (`DVTBBDDY9J`), data source `2BU1C0DNEQ` |
| Gateway (+ rate limit 6/min on `bigdata`) | `datathon2026-equipe14-research-zdjyrdguzu` |
| Harnesses | `datathon2026_equipe14_research-31GGlB0x3A` (research), `datathon2026_equipe14_reviewer-cmgGIZ6oX5` (reviewer) |
| IAM roles | `datathon2026-equipe14-kb`, `-gateway`, `-harness` |
| Bigdata.com key | Secrets Manager `datathon2026-equipe14/bigdata-api-key`, credential provider `datathon2026-equipe14-bigdata` (same Bigdata.com account as andre) |

On the prod EC2, `BIGDATA_DAILY_CALLS=9` is in `/etc/chatbot.env` (set through SSM,
next to the alert settings).

The app reads its configuration from environment variables: `RESEARCH_HARNESS_ARN`,
`RESEARCH_REVIEWER_ARN` (peer review; unset = no review),
`RESEARCH_KB_BUCKET`, `RESEARCH_KB_ID`, `RESEARCH_KB_DATA_SOURCE_ID` (where to save
reports), `RESEARCH_GATEWAY_URL` (the gateway's MCP URL, for the daily market
snapshot), `BIGDATA_DAILY_CALLS` (budget, default 9) and `RESEARCH_USAGE_FILE`
(budget counter file, default next to `DATA_FILE`):

- locally: in `.env-dev` (gitignored), loaded by `npm run dev`;
- on the EC2: `scripts/deploy-app.sh` finds the `RESEARCH_*` values by name
  (resources named after the environment prefix, as in the tables above) and
  rewrites them in `/etc/chatbot.env` on every deploy, so a replaced instance
  gets them back at its next deploy. An environment without a research harness
  gets none, and runs without research. `BIGDATA_DAILY_CALLS` is not managed by
  the script: set it by hand through SSM to change the default.

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
# Knowledge base alone (filter on the symbol; a symbol without an earnings
# release or saved research report, under reports/<TICKER>/, returns nothing)
aws bedrock-agent-runtime retrieve --knowledge-base-id RJ5TCZ4WGW \
  --retrieval-query text="quarterly revenue" \
  --retrieval-configuration '{"managedSearchConfiguration":{"numberOfResults":3,"filter":{"equals":{"key":"symbol","value":"MSFT"}}}}'
```

The harness has no AWS CLI invoke command (streaming API): use the app, or
`boto3` `invoke_harness` (see `app/research.js` for the request).

## Bigdata.com credits

- Measured cost (balance before and after, November 2026): the market
  tearsheet alone costs **17 credits** (US$0.17); a research with
  `find_securities` and `bigdata_company_tearsheet` costs about **39 credits**
  (the older figure of 10 credits per call is too low for the tearsheet). The
  plan started with 1,000 credits.
- The harness may only use 6 read tools (`allowedTools`):
  - `find_securities`, then `bigdata_company_tearsheet` or `bigdata_search` for
    the company;
  - one context call, only for questions about the sector, the market or the
    economy, or for judgment requests: `bigdata_market_tearsheet` (no
    parameters: the 11 US sectors, indexes, commodities, currencies, yields),
    `bigdata_country_tearsheet` (one country code: macro data, economic
    calendar) or `bigdata_etf_tearsheet` (a sector ETF; it needs its own
    `find_securities` call, so only when the 3-call limit allows it).

  The tools that write to the Bigdata.com account (monitors, watchlists,
  uploads) are not allowed. Both research harnesses (andre and prod) have this
  prompt and `maxIterations` 7 (the reviewers have 3).
- **Daily market snapshot.** The market tearsheet is the same for every
  company, so when `RESEARCH_GATEWAY_URL` is set the app buys it once per UTC
  day itself (signed MCP call to the gateway, `bedrock-agentcore:InvokeGateway`,
  see `infra/iam.tf`), saves it in `bigdata-market.json` next to the usage
  counter, and keeps only the useful sections (Americas markets, US sectors,
  North American indexes, US yields, energy and metals, style factors: about
  10,000 characters). It is added to the research request when the chat agent
  sets `needs_market_context` (sector, market or macro questions) and for every
  judgment request; the harness then never gets `bigdata_market_tearsheet`.
  The snapshot counts as one call in the daily budget. Without
  `RESEARCH_GATEWAY_URL`, the harness calls the market tearsheet itself.
- `app/research.js` counts the Bigdata.com calls per day (UTC) in
  `bigdata-usage.json` next to the app data. When less than one research (3 calls)
  is left in `BIGDATA_DAILY_CALLS`, the harness is invoked without the Bigdata.com
  tools until the next day. Each research reserves 3 calls before it starts, so
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
harness session (Claude Opus 5.5) plus a few web searches and the Bigdata.com
credits it uses (see above); a judgment request adds one reviewer session.

## Clean up

Delete in this order: the two harnesses, gateway rate limit, gateway targets, gateway,
API key credential provider, data source, knowledge base, bucket (empty it
first), the three IAM roles, then the Bigdata.com secret.
