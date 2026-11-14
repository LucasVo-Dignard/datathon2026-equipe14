'use strict';
// Prototype chatbot server: no dependencies, data in one JSON file.
// Login is username-only (no password) on purpose: this is a prototype.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { reply } = require('./bot');
const profile = require('./profile');
const { createProfileStore } = require('./profile-store');
const { getPortfolio } = require('./portfolio');

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

function ownChat(user, id) {
  const chat = Object.hasOwn(db.chats, id) ? db.chats[id] : null;
  if (!chat || chat.owner !== user) throw new HttpError(404, 'Conversation introuvable');
  return chat;
}

function chatSummary(chat) {
  return { id: chat.id, title: chat.title, updatedAt: chat.updatedAt };
}

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

  if (pathname === '/api/chats') {
    if (method === 'GET') {
      const chats = Object.values(db.chats)
        .filter((c) => c.owner === user)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(chatSummary);
      return sendJson(res, 200, chats);
    }
    if (method === 'POST') {
      const now = Date.now();
      const chat = {
        id: crypto.randomUUID(),
        owner: user,
        title: DEFAULT_TITLE,
        createdAt: now,
        updatedAt: now,
        messages: [],
      };
      db.chats[chat.id] = chat;
      saveDb();
      return sendJson(res, 201, chat);
    }
  }

  const match = pathname.match(/^\/api\/chats\/([0-9a-f-]{36})(\/messages)?$/);
  if (match) {
    const chat = ownChat(user, match[1]);

    if (!match[2]) {
      if (method === 'GET') return sendJson(res, 200, chat);
      if (method === 'PATCH') {
        const { title } = await readJson(req);
        chat.title = cleanText(title, MAX_TITLE_CHARS, 'Titre');
        saveDb();
        return sendJson(res, 200, chatSummary(chat));
      }
      if (method === 'DELETE') {
        delete db.chats[chat.id];
        saveDb();
        return sendJson(res, 200, { ok: true });
      }
    } else if (method === 'POST') {
      const { content } = await readJson(req);
      const text = cleanText(content, MAX_MESSAGE_CHARS, 'Message');

      const userMsg = { role: 'user', content: text, at: Date.now() };
      chat.messages.push(userMsg);
      if (chat.title === DEFAULT_TITLE) {
        chat.title = text.length > 40 ? `${text.slice(0, 40)}…` : text;
      }

      // Si la base est indisponible, l'agent répond quand même, sans le profil.
      const investorProfile = await profiles.get(user).then((p) => p?.result || null, (err) => {
        console.error('profile load error:', err.message);
        return null;
      });

      let answer;
      try {
        answer = await reply({
          messages: chat.messages.map(({ role, content }) => ({ role, content })),
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
      chat.messages.push(botMsg);
      chat.updatedAt = botMsg.at;
      saveDb();
      return sendJson(res, 200, { messages: [userMsg, botMsg], chat: chatSummary(chat) });
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

profiles.init().then(
  () => server.listen(PORT, () => console.log(`chatbot listening on :${PORT} (profils : ${profiles.kind})`)),
  (err) => {
    console.error(`Impossible d'initialiser le stockage des profils (${profiles.kind}) :`, err.message || err.code || err);
    process.exit(1);
  },
);
