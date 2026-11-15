'use strict';
// ---------------------------------------------------------------------------
// Research on a company through the AgentCore research harness.
//
// The harness (Claude on Bedrock, AgentCore) has its tools behind an AgentCore
// Gateway and uses them in this order:
//   1. the earnings releases knowledge base (Bedrock managed knowledge base,
//      filtered by stock symbol);
//   2. Bigdata.com (premium financial data, limited credits);
//   3. the AgentCore Web Search Tool.
// It returns a factual report with its sources; bot.js then formats the
// answer for the user. See ../agents/README.md.
//
// For judgment requests only (an opinion on a proposal, not objective
// information), a second harness peer-reviews the data the research agent
// selected: source quality, recency, balance, relevance and gaps.
//
// Bigdata.com credits are paid for, so this module:
//   - fetches the Bigdata.com market tearsheet (sectors, indexes, rates: the
//     same for every company, about 17 credits, see ../agents/README.md) once
//     per UTC day through the gateway, and gives it to the researches that need
//     market context instead of letting each of them buy it;
//   - saves every report that used Bigdata.com to the knowledge base, so the
//     same question is answered from it next time, at no cost.
//
// Configuration (environment variables):
//   RESEARCH_HARNESS_ARN        harness to invoke (unset = research disabled)
//   RESEARCH_REVIEWER_ARN       peer-review harness, used for judgment requests
//                               only (unset = no review)
//   RESEARCH_KB_BUCKET, RESEARCH_KB_ID, RESEARCH_KB_DATA_SOURCE_ID
//                               where to save reports (unset = not saved)
//   RESEARCH_GATEWAY_URL        MCP URL of the harness's gateway, for the daily
//                               market snapshot (unset = each research calls
//                               the market tearsheet itself)
// ---------------------------------------------------------------------------

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { BedrockAgentCoreClient, InvokeHarnessCommand } = require('@aws-sdk/client-bedrock-agentcore');

const HARNESS_ARN = process.env.RESEARCH_HARNESS_ARN || '';
const REVIEWER_ARN = process.env.RESEARCH_REVIEWER_ARN || '';
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const KB = {
  bucket: process.env.RESEARCH_KB_BUCKET || '',
  id: process.env.RESEARCH_KB_ID || '',
  dataSourceId: process.env.RESEARCH_KB_DATA_SOURCE_ID || '',
};
const GATEWAY_URL = process.env.RESEARCH_GATEWAY_URL || '';
const MARKET_FILE = path.join(
  path.dirname(process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json')), 'bigdata-market.json');
// Sections of the market tearsheet given to the researches ("## part / ### section"):
// about a third of the whole tearsheet (30,000 characters), to bound the prompt.
const MARKET_SECTIONS = [
  'Global Markets / Americas',
  'Equity Sectors / United States',
  'Major Indexes / North America',
  'Yields / US Yields',
  'Commodities / Energy',
  'Commodities / Metals',
  'Equity Factors / Style (Relative to S&P 500)',
  'Equity Factors / Size & Style (Relative to S&P 500)',
];

// Tool selectors of the harness (same as its allowedTools, see agents/README.md).
const TOOLS_WITHOUT_BIGDATA = ['@research/earnings-kb___Retrieve', '@research/web-search___WebSearch'];
const MARKET_TOOL = '@research/bigdata___bigdata_market_tearsheet';
const BIGDATA_TOOLS = [
  '@research/bigdata___find_securities',
  '@research/bigdata___bigdata_company_tearsheet',
  '@research/bigdata___bigdata_search',
  MARKET_TOOL,
  '@research/bigdata___bigdata_etf_tearsheet',
  '@research/bigdata___bigdata_country_tearsheet',
];
const ALL_TOOLS = [TOOLS_WITHOUT_BIGDATA[0], ...BIGDATA_TOOLS, TOOLS_WITHOUT_BIGDATA[1]];

let client = null;
const getClient = () => (client ??= new BedrockAgentCoreClient({ region: REGION }));

const isEnabled = () => Boolean(HARNESS_ARN);
const today = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Daily market snapshot (Bigdata.com market tearsheet)
// ---------------------------------------------------------------------------

// Keeps the first lines (update time) and the MARKET_SECTIONS of the tearsheet,
// each with its "## part" heading and the source and date lines under it.
function marketExtract(text) {
  const kept = [];
  let part = '';
  let partLines = [];
  let partShown = false;
  let inHeader = false;
  let keep = true;
  for (const line of text.split('\n')) {
    const h2 = line.match(/^## (.+)/);
    const h3 = line.match(/^### (.+)/);
    if (h2) {
      part = h2[1].trim();
      partLines = [line];
      partShown = false;
      inHeader = true;
      keep = false;
    } else if (h3) {
      inHeader = false;
      keep = MARKET_SECTIONS.includes(`${part} / ${h3[1].trim()}`);
      if (keep && !partShown) {
        kept.push(...partLines);
        partShown = true;
      }
      if (keep) kept.push(line);
    } else if (inHeader) {
      partLines.push(line);
    } else if (keep) {
      kept.push(line);
    }
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

let signer = null;

// Calls one tool of the gateway (MCP over HTTP, AWS_IAM inbound auth) and
// returns its text content.
async function callGatewayTool(name, args = {}) {
  // Loaded only when the snapshot is configured.
  const { SignatureV4 } = require('@smithy/signature-v4');
  const { Sha256 } = require('@aws-crypto/sha256-js');
  const { defaultProvider } = require('@aws-sdk/credential-provider-node');
  signer ??= new SignatureV4({ credentials: defaultProvider(), region: REGION, service: 'bedrock-agentcore', sha256: Sha256 });

  const url = new URL(GATEWAY_URL);
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const request = await signer.sign({
    method: 'POST',
    protocol: url.protocol,
    hostname: url.hostname,
    path: url.pathname,
    headers: { host: url.hostname, 'content-type': 'application/json', accept: 'application/json' },
    body,
  });
  const response = await fetch(url, { method: 'POST', headers: request.headers, body, signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`gateway ${response.status}`);
  const json = await response.json();
  if (json.error) throw new Error(`gateway: ${json.error.message}`);
  if (json.result?.isError) throw new Error(`${name}: ${json.result.content?.[0]?.text?.slice(0, 200)}`);
  return (json.result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
}

function readMarketFile() {
  try {
    const saved = JSON.parse(fs.readFileSync(MARKET_FILE, 'utf8'));
    if (saved.date === today() && saved.text) return saved;
  } catch {
    // Missing or unreadable file: fetch a new snapshot.
  }
  return null;
}

// Parallel researches (judgment requests) share one fetch.
let marketFetch = null;

/**
 * Returns today's market snapshot { date, text, fetched } (fetched: bought by
 * this call), or null when it is not configured or the call failed: the
 * research then goes on without it.
 */
async function marketSnapshot() {
  if (!GATEWAY_URL) return null;
  const saved = readMarketFile();
  if (saved) return { ...saved, fetched: false };
  if (marketFetch) return marketFetch;

  marketFetch = (async () => {
    try {
      const text = marketExtract(await callGatewayTool('bigdata___bigdata_market_tearsheet'));
      if (!text) return null;
      const snapshot = { date: today(), text };
      try {
        fs.mkdirSync(path.dirname(MARKET_FILE), { recursive: true });
        fs.writeFileSync(MARKET_FILE, JSON.stringify(snapshot));
      } catch (err) {
        console.error('market snapshot file:', err.message);
      }
      return { ...snapshot, fetched: true };
    } catch (err) {
      console.error('market snapshot:', err.message);
      return null;
    } finally {
      marketFetch = null;
    }
  })();
  return marketFetch;
}

// ---------------------------------------------------------------------------
// Saving reports to the knowledge base
// ---------------------------------------------------------------------------

let s3 = null;
let bedrockAgent = null;

async function saveToKnowledgeBase({ ticker, company, question, report }) {
  if (!KB.bucket || !KB.id || !KB.dataSourceId || !ticker) return false;
  // Loaded only when saving is configured.
  const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
  const { BedrockAgentClient, StartIngestionJobCommand } = require('@aws-sdk/client-bedrock-agent');
  s3 ??= new S3Client({ region: REGION });
  bedrockAgent ??= new BedrockAgentClient({ region: REGION });

  const date = today();
  const key = `reports/${ticker}/${ticker}-research-${date}-${crypto.randomUUID().slice(0, 8)}.txt`;
  const body = `${company} (${ticker}) - Research report (Bigdata.com and other sources)\n`
    + `Written on ${date} by the research agent, for the question: ${question}\n\n${report}\n`;
  const metadata = {
    metadataAttributes: {
      symbol: { value: { type: 'STRING', stringValue: ticker } },
      company: { value: { type: 'STRING', stringValue: company } },
      doc_type: { value: { type: 'STRING', stringValue: 'research_report' } },
      source: { value: { type: 'STRING', stringValue: 'bigdata' } },
      report_date: { value: { type: 'NUMBER', numberValue: Number(date.replaceAll('-', '')) } },
    },
  };
  await s3.send(new PutObjectCommand({ Bucket: KB.bucket, Key: key, Body: body, ContentType: 'text/plain; charset=utf-8' }));
  await s3.send(new PutObjectCommand({
    Bucket: KB.bucket, Key: `metadata/${key}.metadata.json`, Body: JSON.stringify(metadata), ContentType: 'application/json',
  }));
  try {
    await bedrockAgent.send(new StartIngestionJobCommand({ knowledgeBaseId: KB.id, dataSourceId: KB.dataSourceId }));
  } catch (err) {
    // An ingestion is already running: the next save starts a new one.
    console.error('knowledge base ingestion:', err.name, err.message);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Harness invocation
// ---------------------------------------------------------------------------

/**
 * Invokes a harness with one user message and returns { text, tools,
 * stopReason }: text is the final assistant message, tools the names of the
 * tools the agent called.
 */
async function runHarness(harnessArn, prompt, extra = {}, onTool = null) {
  const response = await getClient().send(new InvokeHarnessCommand({
    harnessArn,
    // One isolated session per invocation (at least 33 characters).
    runtimeSessionId: `research-${crypto.randomUUID()}`,
    messages: [{ role: 'user', content: [{ text: prompt }] }],
    ...extra,
  }));

  const tools = [];
  let current = [];
  let text = '';
  let stopReason = null;
  for await (const event of response.stream) {
    if (event.messageStart) {
      current = [];
    } else if (event.contentBlockStart?.start?.toolUse) {
      const name = event.contentBlockStart.start.toolUse.name;
      tools.push(name);
      // Progress callback: errors in it must not break the research.
      try { onTool?.(name); } catch (err) { console.error('onTool:', err.message); }
    } else if (event.contentBlockDelta?.delta?.text) {
      current.push(event.contentBlockDelta.delta.text);
    } else if (event.messageStop) {
      stopReason = event.messageStop.stopReason;
      // Keep the text of the last assistant message: the final report.
      if (current.length) text = current.join('');
    } else if (event.runtimeClientError) {
      throw new Error(`harness: ${event.runtimeClientError.message}`);
    }
  }
  return { text: text.trim(), tools, stopReason };
}

/**
 * Runs one research and returns { report, tools, bigdataCalls, saved, market }.
 * onTool(name) is called each time the agent calls a tool (progress display).
 * kind is "factual" or "judgment": for a judgment, the research agent is asked
 * for a balanced selection (arguments for and against).
 * marketContext: the question needs sector, market or economic context; the
 * daily market snapshot is then added to the request (always for a judgment).
 * market is "cache" or "fetched" when the snapshot was given, null otherwise.
 */
async function researchCompany({ company, ticker, question, kind = 'factual', marketContext = false, onTool = null }) {
  if (!isEnabled()) throw new Error('RESEARCH_HARNESS_ARN is not set');
  const subject = ticker ? `${company} (${ticker})` : company;
  const market = marketContext || kind === 'judgment' ? await marketSnapshot() : null;
  const balance = kind === 'judgment'
    ? '\nThe investor is asking for a judgment on a proposal: collect balanced data, with the facts that support it and those that argue against it (risks, valuation, competition).'
    : '';
  const marketText = market
    ? `\n\nMarket snapshot from the Bigdata.com market tearsheet, retrieved on ${market.date} (already paid for: `
      + 'use it for sector and market context instead of bigdata___bigdata_market_tearsheet, and cite it as '
      + `"Bigdata.com | no URL | Market tearsheet, ${market.date}"):\n${market.text}`
    : '';
  // With the daily snapshot configured, the agent never buys the market
  // tearsheet itself.
  const allowedTools = GATEWAY_URL ? ALL_TOOLS.filter((tool) => tool !== MARKET_TOOL) : null;

  // The harness has no clock: give it today's date so "latest" is resolved correctly.
  const { text: report, tools, stopReason } = await runHarness(
    HARNESS_ARN,
    `Today's date: ${today()}\nCompany: ${subject}\nQuestion: ${question}${balance}${marketText}`,
    allowedTools ? { allowedTools } : {},
    onTool,
  );

  const bigdataCalls = tools.filter((name) => name.startsWith('bigdata___')).length;
  if (!report) throw new Error(`research harness returned no report (stop: ${stopReason})`);

  let saved = false;
  if (bigdataCalls) {
    try {
      saved = await saveToKnowledgeBase({ ticker, company, question, report });
    } catch (err) {
      console.error('save research report:', err.name, err.message);
    }
  }
  return {
    report, tools, stopReason, bigdataCalls, saved,
    market: market ? (market.fetched ? 'fetched' : 'cache') : null,
  };
}

// ---------------------------------------------------------------------------
// Peer review (judgment requests only)
// ---------------------------------------------------------------------------

const isReviewEnabled = () => Boolean(REVIEWER_ARN);

/**
 * Peer-reviews the data the research agent selected for a proposal. Returns
 * { review, tools }: review starts with "VERDICT: SOLID | PARTIAL | WEAK".
 */
async function reviewResearch({ proposal, reports, portfolio = '', onTool = null }) {
  if (!isReviewEnabled()) throw new Error('RESEARCH_REVIEWER_ARN is not set');
  const body = reports
    .map((r, i) => `=== Report ${i + 1}: ${r.subject} (question: ${r.question}) ===\n${r.report}`)
    .join('\n\n');
  const { text: review, tools, stopReason } = await runHarness(
    REVIEWER_ARN,
    `Today's date: ${today()}\nInvestor's proposal or question: ${proposal}\n\n`
      + (portfolio
        ? `Investor's current portfolio (judge the data also against it: concentration, sector exposure, effect of the proposal):\n${portfolio}\n\n`
        : '')
      + body,
    {},
    onTool,
  );
  if (!review) throw new Error(`reviewer harness returned no review (stop: ${stopReason})`);
  return { review, tools };
}

module.exports = { researchCompany, reviewResearch, marketSnapshot, marketExtract, isEnabled, isReviewEnabled };
