'use strict';
// Amazon Comprehend enrichment of news items, once per article, in batches of
// 25: dominant sentiment with its confidence, and the ORGANIZATION entities
// (used to link the article to listed companies, see match.js). Articles are
// kept in their original language (English or French, both supported).
//
// The client is injected so tests run without AWS.

const BATCH = 25; // Comprehend batch limit
const MAX_DOC_CHARS = 1500; // well under Comprehend's 5 000 bytes per document
const MIN_ENTITY_SCORE = 0.8;

const docText = (item) => [item.title, item.summary].filter(Boolean).join('. ').slice(0, MAX_DOC_CHARS);

function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// items: [{ id, language, title, summary }] -> Map id -> { sentiment, sentimentScore, organizations }
async function analyze(comprehend, items) {
  const {
    BatchDetectSentimentCommand, BatchDetectEntitiesCommand,
  } = require('@aws-sdk/client-comprehend');
  const results = new Map();
  for (const lang of ['en', 'fr']) {
    for (const batch of chunks(items.filter((i) => i.language === lang), BATCH)) {
      const TextList = batch.map(docText);
      const [sent, ents] = await Promise.all([
        comprehend.send(new BatchDetectSentimentCommand({ TextList, LanguageCode: lang })),
        comprehend.send(new BatchDetectEntitiesCommand({ TextList, LanguageCode: lang })),
      ]);
      for (const r of sent.ResultList || []) {
        const item = batch[r.Index];
        const key = r.Sentiment.charAt(0) + r.Sentiment.slice(1).toLowerCase(); // Positive, Negative...
        results.set(item.id, {
          sentiment: r.Sentiment,
          sentimentScore: Math.round((r.SentimentScore?.[key] ?? 0) * 1000) / 1000,
          organizations: [],
        });
      }
      for (const r of ents.ResultList || []) {
        const item = batch[r.Index];
        const orgs = [...new Set((r.Entities || [])
          .filter((e) => e.Type === 'ORGANIZATION' && e.Score >= MIN_ENTITY_SCORE)
          .map((e) => e.Text.trim()))];
        const entry = results.get(item.id) || { sentiment: null, sentimentScore: null, organizations: [] };
        entry.organizations = orgs.slice(0, 20);
        results.set(item.id, entry);
      }
      // Documents Comprehend could not process are left for the next run.
      for (const e of [...(sent.ErrorList || []), ...(ents.ErrorList || [])]) {
        results.delete(batch[e.Index].id);
      }
    }
  }
  return results;
}

module.exports = { analyze, docText, BATCH };
