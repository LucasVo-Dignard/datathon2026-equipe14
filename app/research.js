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
// Bigdata.com credits are limited, so this module:
//   - counts Bigdata.com tool calls per day and, once BIGDATA_DAILY_CALLS is
//     reached, invokes the harness without the Bigdata.com tools;
//   - saves every report that used Bigdata.com to the knowledge base, so the
//     same question is answered from it next time, at no cost.
//
// Configuration (environment variables):
//   RESEARCH_HARNESS_ARN        harness to invoke (unset = research disabled)
//   RESEARCH_REVIEWER_ARN       peer-review harness, used for judgment requests
//                               only (unset = no review)
//   BIGDATA_DAILY_CALLS         daily budget of Bigdata.com tool calls (default 9:
//                               about 3 researches, ~90 credits)
//   RESEARCH_KB_BUCKET, RESEARCH_KB_ID, RESEARCH_KB_DATA_SOURCE_ID
//                               where to save reports (unset = not saved)
//   RESEARCH_USAGE_FILE         budget counter file (default: next to DATA_FILE)
// ---------------------------------------------------------------------------

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { BedrockAgentCoreClient, InvokeHarnessCommand } = require('@aws-sdk/client-bedrock-agentcore');

const HARNESS_ARN = process.env.RESEARCH_HARNESS_ARN || '';
const REVIEWER_ARN = process.env.RESEARCH_REVIEWER_ARN || '';
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
const DAILY_BUDGET = Number(process.env.BIGDATA_DAILY_CALLS ?? 9);
// The harness prompt allows at most 2 Bigdata.com calls per research.
const CALLS_PER_RESEARCH = 2;
const KB = {
  bucket: process.env.RESEARCH_KB_BUCKET || '',
  id: process.env.RESEARCH_KB_ID || '',
  dataSourceId: process.env.RESEARCH_KB_DATA_SOURCE_ID || '',
};
const USAGE_FILE = process.env.RESEARCH_USAGE_FILE
  || path.join(path.dirname(process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json')), 'bigdata-usage.json');

// Tool selectors of the harness (same as its allowedTools, see agents/README.md).
const TOOLS_WITHOUT_BIGDATA = ['@research/earnings-kb___Retrieve', '@research/web-search___WebSearch'];
const BIGDATA_TOOLS = [
  '@research/bigdata___find_securities',
  '@research/bigdata___bigdata_company_tearsheet',
  '@research/bigdata___bigdata_search',
];

let client = null;
const getClient = () => (client ??= new BedrockAgentCoreClient({ region: REGION }));

const isEnabled = () => Boolean(HARNESS_ARN);
const today = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Daily Bigdata.com budget
// ---------------------------------------------------------------------------

function readUsage() {
  try {
    const usage = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
    if (usage.date === today()) return usage;
  } catch {
    // Missing or unreadable file: start a new day.
  }
  return { date: today(), calls: 0 };
}

function addUsage(calls) {
  if (!calls) return;
  const usage = readUsage();
  usage.calls += calls;
  try {
    fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true });
    fs.writeFileSync(USAGE_FILE, JSON.stringify(usage));
  } catch (err) {
    console.error('bigdata usage file:', err.message);
  }
}

// Calls reserved by the researches in progress: parallel researches (one per
// company of a judgment request) must not all pass the budget check at once.
let reserved = 0;

function bigdataStatus() {
  const { calls } = readUsage();
  return { calls, reserved, budget: DAILY_BUDGET, available: calls + reserved + CALLS_PER_RESEARCH <= DAILY_BUDGET };
}

// Reserves one research's worth of Bigdata.com calls, if the budget allows it.
function reserveBigdata() {
  if (!bigdataStatus().available) return false;
  reserved += CALLS_PER_RESEARCH;
  return true;
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
 * Runs one research and returns { report, tools, usedBigdata, saved }.
 * onTool(name) is called each time the agent calls a tool (progress display).
 * kind is "factual" or "judgment": for a judgment, the research agent is asked
 * for a balanced selection (arguments for and against).
 */
async function researchCompany({ company, ticker, question, kind = 'factual', onTool = null }) {
  if (!isEnabled()) throw new Error('RESEARCH_HARNESS_ARN is not set');
  const subject = ticker ? `${company} (${ticker})` : company;
  const withBigdata = reserveBigdata();
  const balance = kind === 'judgment'
    ? '\nThe investor is asking for a judgment on a proposal: collect balanced data, with the facts that support it and those that argue against it (risks, valuation, competition).'
    : '';

  let run;
  try {
    // The harness has no clock: give it today's date so "latest" is resolved correctly.
    run = await runHarness(
      HARNESS_ARN,
      `Today's date: ${today()}\nCompany: ${subject}\nQuestion: ${question}${balance}`,
      // No reservation (budget used up): the agent gets no Bigdata.com tool until tomorrow.
      withBigdata ? {} : { allowedTools: TOOLS_WITHOUT_BIGDATA },
      onTool,
    );
  } finally {
    if (withBigdata) reserved -= CALLS_PER_RESEARCH;
  }
  const { text: report, tools, stopReason } = run;

  const bigdataCalls = tools.filter((name) => name.startsWith('bigdata___')).length;
  addUsage(bigdataCalls);
  if (!report) throw new Error(`research harness returned no report (stop: ${stopReason})`);

  let saved = false;
  if (bigdataCalls) {
    try {
      saved = await saveToKnowledgeBase({ ticker, company, question, report });
    } catch (err) {
      console.error('save research report:', err.name, err.message);
    }
  }
  return { report, tools, stopReason, usedBigdata: bigdataCalls > 0, bigdataBudget: bigdataStatus(), saved };
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

module.exports = { researchCompany, reviewResearch, isEnabled, isReviewEnabled, bigdataStatus };
