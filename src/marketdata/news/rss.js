'use strict';
// Download and parse an RSS 2.0 feed into plain news items.
// The feed is untrusted input: size and time are capped, HTML is stripped from
// titles and summaries, and only http(s) links are kept.

const { XMLParser } = require('fast-xml-parser');

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const SUMMARY_CHARS = 400;
const USER_AGENT = 'datathon2026-equipe14-news/1.0 (educational prototype)';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

// Text of a title or description: no tags, entities decoded, spaces collapsed.
function cleanText(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return cleanText(value[0]);
  const text = String(typeof value === 'object' ? (value['#text'] ?? '') : value);
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 20))}…`;
}

const httpUrl = (value) => {
  try {
    const u = new URL(String(value).trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
};

// Items of an RSS document: [{ externalId, url, title, summary, publishedAt }].
// Items without a title, a valid link or a valid date are skipped.
function parseRss(xml) {
  const parser = new XMLParser({ ignoreAttributes: false, processEntities: false, htmlEntities: false, parseTagValue: false });
  const doc = parser.parse(xml);
  const raw = doc?.rss?.channel?.item;
  const items = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out = [];
  for (const it of items) {
    const title = cleanText(it.title);
    const url = httpUrl(cleanText(it.link));
    const publishedAt = new Date(cleanText(it.pubDate));
    if (!title || !url || Number.isNaN(publishedAt.getTime())) continue;
    const guid = cleanText(it.guid) || url;
    out.push({
      externalId: guid.slice(0, 500),
      url,
      title: truncate(title, 300),
      summary: truncate(cleanText(it.description), SUMMARY_CHARS) || null,
      publishedAt,
    });
  }
  return out;
}

async function fetchFeed(url, { fetchFn = fetch } = {}) {
  const res = await fetchFn(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/xml, text/xml' },
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const length = Number(res.headers.get('content-length') || 0);
  if (length > MAX_BYTES) throw new Error(`feed too large (${length} bytes)`);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error('feed too large');
  return parseRss(text);
}

module.exports = { parseRss, fetchFeed, cleanText, httpUrl, SUMMARY_CHARS };
