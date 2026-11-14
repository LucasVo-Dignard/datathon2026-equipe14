'use strict';
// Prototype chatbot server. Profiles and chats go to Postgres when DATABASE_URL
// is set (see profile-store.js, chat-store.js); users, login sessions and, without
// a database, everything else live in one JSON file.
// Login is username-only (no password) on purpose: this is a prototype.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { reply } = require('./bot');
const profile = require('./profile');
const { createProfileStore } = require('./profile-store');
const { createChatStore } = require('./chat-store');
const { getPortfolio } = require('./portfolio');
const { createStockLookup, normalizeSymbol } = require('./stocks');

const PORT = Number(process.env.PORT || 3000);
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY_BYTES = 64 * 1024;
const MAX_MESSAGE_CHARS = 4000;
const MAX_TITLE_CHARS = 80;
const DEFAULT_TITLE = 'Nouvelle conversation';
const USERNAME_RE = /^[\p{L}\p{N}_.-]{1,32}$/u;
const COOKIE = 'sid';

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function loadDb() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return { users: {}, sessions: {}, chats: {} };
    throw err;
  }
}

const db = loadDb();

function saveDb() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DATA_FILE);
}

// Profils investisseurs : Postgres si DATABASE_URL est défini, sinon le fichier JSON.
const profiles = createProfileStore({ db, saveDb });
// Conversations du chat : idem (tables chats / chat_messages).
const chats = createChatStore({ db, saveDb });
const stocks = createStockLookup();

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Requête trop volumineuse'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'JSON invalide'));
      }
    });
    req.on('error', reject);
  });
}

function getCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function currentUser(req) {
  const token = getCookie(req, COOKIE);
  return token && Object.hasOwn(db.sessions, token) ? db.sessions[token] : null;
}

function requireUser(req) {
  const user = currentUser(req);
  if (!user) throw new HttpError(401, 'Non connecté');
  return user;
}

const chatNotFound = () => new HttpError(404, 'Conversation introuvable');

function cleanText(value, max, field) {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${field} requis`);
  const text = value.trim();
  if (text.length > max) throw new HttpError(400, `${field} trop long (max ${max} caractères)`);
  return text;
}

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

async function handleApi(req, res, pathname) {
  const method = req.method;

  if (pathname === '/api/login' && method === 'POST') {
    const { username } = await readJson(req);
    if (typeof username !== 'string' || !USERNAME_RE.test(username.trim())) {
      throw new HttpError(400, "Nom d'utilisateur invalide (1 à 32 lettres, chiffres, _ . -)");
    }
    const name = username.trim();
    if (!Object.hasOwn(db.users, name)) db.users[name] = { createdAt: Date.now() };
    const token = crypto.randomBytes(32).toString('hex');
    db.sessions[token] = name;
    saveDb();
    return sendJson(res, 200, { username: name }, {
      'Set-Cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`,
    });
  }

  if (pathname === '/api/logout' && method === 'POST') {
    const token = getCookie(req, COOKIE);
    if (token && Object.hasOwn(db.sessions, token)) {
      delete db.sessions[token];
      saveDb();
    }
    return sendJson(res, 200, { ok: true }, {
      'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
    });
  }

  if (pathname === '/api/me' && method === 'GET') {
    return sendJson(res, 200, { username: requireUser(req) });
  }

  const user = requireUser(req);

  if (pathname === '/api/profile/questionnaire' && method === 'GET') {
    return sendJson(res, 200, profile.publicQuestionnaire());
  }

  if (pathname === '/api/profile') {
    if (method === 'GET') return sendJson(res, 200, await profiles.get(user));
    if (method === 'PUT') {
      const body = await readJson(req);
      let answers;
      try {
        answers = profile.validate(body.answers);
      } catch (err) {
        if (err instanceof profile.ProfileError) throw new HttpError(400, err.message);
        throw err;
      }
      const saved = await profiles.save(user, { answers, result: profile.buildProfile(answers), updatedAt: Date.now() });
      return sendJson(res, 200, saved);
    }
  }

  if (pathname === '/api/portfolio' && method === 'GET') {
    return sendJson(res, 200, getPortfolio(user));
  }

  const stockMatch = pathname.match(/^\/api\/stocks\/([^/]+)$/);
  if (stockMatch && method === 'GET') {
    let raw;
    try {
      raw = decodeURIComponent(stockMatch[1]);
    } catch {
      raw = '';
    }
    const symbol = normalizeSymbol(raw);
    if (!symbol) throw new HttpError(400, 'Symbole invalide');
    let stock;
    try {
      stock = await stocks.lookup(symbol);
    } catch (err) {
      console.error(`stock lookup error (${symbol}):`, err.message);
      throw new HttpError(502, 'Source de données indisponible, réessayez plus tard');
    }
    if (!stock) throw new HttpError(404, `Aucune donnée pour ${symbol}`);
    return sendJson(res, 200, stock);
  }

  if (pathname === '/api/chats') {
    if (method === 'GET') return sendJson(res, 200, await chats.list(user));
    if (method === 'POST') return sendJson(res, 201, await chats.create(user, DEFAULT_TITLE));
  }

  const match = pathname.match(/^\/api\/chats\/([0-9a-f-]{36})(\/messages)?$/);
  if (match) {
    const id = match[1];

    if (!match[2]) {
      if (method === 'GET') {
        const chat = await chats.get(user, id);
        if (!chat) throw chatNotFound();
        return sendJson(res, 200, chat);
      }
      if (method === 'PATCH') {
        const { title } = await readJson(req);
        const summary = await chats.rename(user, id, cleanText(title, MAX_TITLE_CHARS, 'Titre'));
        if (!summary) throw chatNotFound();
        return sendJson(res, 200, summary);
      }
      if (method === 'DELETE') {
        if (!(await chats.remove(user, id))) throw chatNotFound();
        return sendJson(res, 200, { ok: true });
      }
    } else if (method === 'POST') {
      const chat = await chats.get(user, id);
      if (!chat) throw chatNotFound();
      const { content } = await readJson(req);
      const text = cleanText(content, MAX_MESSAGE_CHARS, 'Message');

      const userMsg = { role: 'user', content: text, at: Date.now() };
      const title = chat.title === DEFAULT_TITLE
        ? (text.length > 40 ? `${text.slice(0, 40)}…` : text)
        : undefined;

      // Si la base est indisponible, l'agent répond quand même, sans le profil.
      const investorProfile = await profiles.get(user).then((p) => p?.result || null, (err) => {
        console.error('profile load error:', err.message);
        return null;
      });

      let answer;
      try {
        answer = await reply({
          messages: [...chat.messages, userMsg].map(({ role, content }) => ({ role, content })),
          username: user,
          chatId: chat.id,
          profile: investorProfile,
          portfolio: getPortfolio(user),
        });
      } catch (err) {
        console.error('bot error:', err);
        answer = "Désolé, l'agent a rencontré une erreur.";
      }

      const botMsg = { role: 'assistant', content: String(answer), at: Date.now() };
      // Question and answer are saved together, once the answer is known.
      const summary = await chats.append(user, chat.id, [userMsg, botMsg], { title });
      if (!summary) throw chatNotFound(); // deleted while the agent was answering
      return sendJson(res, 200, { messages: [userMsg, botMsg], chat: summary });
    }
  }

  throw new HttpError(404, 'Route inconnue');
}

// ---------------------------------------------------------------------------
// Static files (fixed allowlist, no path traversal)
// ---------------------------------------------------------------------------

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/dashboard.js': ['dashboard.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/profile-ui.js': ['profile-ui.js', 'text/javascript; charset=utf-8'],
  '/stock-search.js': ['stock-search.js', 'text/javascript; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
};

function handleStatic(req, res, pathname) {
  const entry = STATIC[pathname];
  if (!entry || (req.method !== 'GET' && req.method !== 'HEAD')) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  }
  const [file, type] = entry;
  fs.readFile(path.join(PUBLIC_DIR, file), (err, data) => {
    if (err) {
      res.writeHead(500);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (pathname.startsWith('/api/')) await handleApi(req, res, pathname);
    else handleStatic(req, res, pathname);
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    if (!res.headersSent) {
      sendJson(res, err.status || 500, { error: err instanceof HttpError ? err.message : 'Erreur serveur' });
    }
  }
});

Promise.all([profiles.init(), chats.init()]).then(
  () => server.listen(PORT, () => console.log(
    `chatbot listening on :${PORT} (profils : ${profiles.kind}, conversations : ${chats.kind})`)),
  (err) => {
    console.error('Impossible d\'initialiser le stockage (profils / conversations) :', err.message || err.code || err);
    process.exit(1);
  },
);
