'use strict';
// Login, phone tabs, and the assistant panel (conversations + messages).

const $ = (id) => document.getElementById(id);
const DEFAULT_TITLE = 'Nouvelle conversation';
const emptyEl = $('empty'); // kept as a reference: renderMessages detaches it
const mobileQuery = window.matchMedia('(max-width: 900px)');

const state = {
  chats: [],          // [{ id, title, updatedAt }]
  currentId: null,    // null = new conversation, created on first message
  sending: false,
};

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== '/api/me') showLogin();
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function showLogin() {
  $('app-view').hidden = true;
  $('login-view').hidden = false;
  $('login-username').focus();
}

async function showApp(username) {
  $('login-view').hidden = true;
  $('app-view').hidden = false;
  $('account-name').textContent = username;
  // Ignore a tab that no longer exists (e.g. the removed Macro tab).
  const savedTab = [...document.querySelectorAll('button[data-tab]')].some((b) => b.dataset.tab === sessionStorage.getItem('tab'))
    ? sessionStorage.getItem('tab') : null;
  if (savedTab) $('app-view').dataset.tab = savedTab; // avoid flashing the default tab while loading
  window.Dashboard.load();
  const [chats, hasProfile] = await Promise.all([
    api('GET', '/api/chats'), window.Profile.init(), window.Reports.init(username),
  ]);
  // Refresh: stay on the same tab. First visit: guide the user through the investor-profile questionnaire.
  setTab(savedTab || (hasProfile ? 'portfolio' : 'profile'));
  state.chats = chats;
  if (state.chats.length) await openChat(state.chats[0].id);
  else newChat();
  window.Reports.openFromHash(); // link to a report (#rapport/<id>)
}

// Tabs: portfolio | profile | assistant. On desktop the left pane shows the
// dashboard or the profile and the assistant is always visible on the right;
// phones show one pane at a time.
function setTab(tab) {
  $('app-view').dataset.tab = tab;
  sessionStorage.setItem('tab', tab); // restored on refresh
  for (const b of document.querySelectorAll('button[data-tab]')) {
    b.setAttribute('aria-pressed', String(b.dataset.tab === tab));
  }
  if (tab === 'portfolio') window.Dashboard.redraw();
  else if (tab === 'reports') window.Reports.load();
  else scrollMessages();
}

// Don't pop the on-screen keyboard open on phones.
function focusInput() {
  if (!mobileQuery.matches) $('input').focus();
}

// ---------------------------------------------------------------------------
// Conversation history (inside the assistant panel)
// ---------------------------------------------------------------------------

function setHistory(open) {
  $('history').hidden = !open;
  $('history-toggle').setAttribute('aria-expanded', String(open));
}

function renderChatList() {
  const list = $('chat-list');
  list.replaceChildren();
  if (!state.chats.length) {
    const p = document.createElement('p');
    p.className = 'muted small history-empty';
    p.textContent = 'Aucune conversation pour l’instant.';
    list.append(p);
  }
  for (const chat of state.chats) {
    const item = document.createElement('div');
    item.className = 'chat-item' + (chat.id === state.currentId ? ' active' : '');

    const title = document.createElement('button');
    title.className = 'title';
    title.textContent = chat.title;
    title.title = chat.title;
    title.onclick = () => openChat(chat.id);

    const rename = document.createElement('button');
    rename.className = 'icon';
    rename.textContent = '✎';
    rename.title = 'Renommer';
    rename.setAttribute('aria-label', `Renommer « ${chat.title} »`);
    rename.onclick = () => renameChat(chat);

    const del = document.createElement('button');
    del.className = 'icon';
    del.textContent = '🗑';
    del.title = 'Supprimer';
    del.setAttribute('aria-label', `Supprimer « ${chat.title} »`);
    del.onclick = () => deleteChat(chat);

    item.append(title, rename, del);
    list.append(item);
  }
}

function upsertSummary(summary) {
  state.chats = [summary, ...state.chats.filter((c) => c.id !== summary.id)];
  renderChatList();
}

function setTitle(title) {
  $('chat-title').textContent = title;
}

function newChat() {
  state.currentId = null;
  setTitle(DEFAULT_TITLE);
  renderMessages([]);
  renderChatList();
  setHistory(false);
  focusInput();
}

async function openChat(id) {
  const chat = await api('GET', `/api/chats/${id}`);
  state.currentId = chat.id;
  setTitle(chat.title);
  renderMessages(chat.messages);
  renderChatList();
  setHistory(false);
  focusInput();
}

async function renameChat(chat) {
  const title = prompt('Nouveau titre :', chat.title);
  if (!title || !title.trim()) return;
  const summary = await api('PATCH', `/api/chats/${chat.id}`, { title });
  Object.assign(chat, summary);
  if (chat.id === state.currentId) setTitle(chat.title);
  renderChatList();
}

async function deleteChat(chat) {
  if (!confirm(`Supprimer « ${chat.title} » ?`)) return;
  await api('DELETE', `/api/chats/${chat.id}`);
  state.chats = state.chats.filter((c) => c.id !== chat.id);
  if (chat.id === state.currentId) {
    state.currentId = null;
    setTitle(DEFAULT_TITLE);
    renderMessages([]);
  }
  renderChatList();
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function messageEl(role, content, pending = false, animate = false) {
  const row = document.createElement('div');
  row.className = `msg ${role}` + (pending ? ' pending' : '');
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (role === 'assistant' && !pending && window.renderMarkdown) {
    // Assistant answers are Markdown, rendered as DOM nodes (never as HTML).
    bubble.classList.add('md');
    bubble.append(window.renderMarkdown(content));
    if (animate) typeOut(bubble);
  } else {
    bubble.textContent = content;
  }
  row.append(bubble);
  return row;
}

// ---------------------------------------------------------------------------
// Typewriter effect for a new answer: the Markdown is rendered once, then its
// text is revealed a few characters per frame, in reading order. Tables, code
// blocks, images, rules and source chips appear at once when reached.
// A click on the answer shows it entirely.
// ---------------------------------------------------------------------------

const TYPE_MAX_MS = 4000;     // whole answer shown within ~4 s
const TYPE_MIN_CHARS = 2;     // per frame, for short answers
const FRAME_MS = 16;
const ATOMIC = 'table, .md-table, pre, img, hr, .cite';

function typeOut(container) {
  // No animation if the user asked for less motion or the tab is in the background.
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.hidden) return;

  // Reading-order units: a text node (typed) or an atomic element (shown whole).
  const units = [];
  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (child.textContent) units.push({ text: child, full: child.textContent });
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        if (child.matches(ATOMIC)) units.push({ el: child });
        else walk(child);
      }
    }
  };
  walk(container);
  const total = units.reduce((n, u) => n + (u.full ? u.full.length : 0), 0);
  if (!units.length || total < 40) return;

  // Hide everything: elements show up when their first content is revealed.
  const hidden = container.querySelectorAll('*');
  hidden.forEach((el) => el.classList.add('tw-hidden'));
  units.forEach((u) => { if (u.text) u.text.textContent = ''; });
  container.classList.add('typing');

  const reveal = (node) => {
    for (let el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
      el && el !== container; el = el.parentElement) el.classList.remove('tw-hidden');
    if (node.nodeType === Node.ELEMENT_NODE) node.querySelectorAll('.tw-hidden').forEach((el) => el.classList.remove('tw-hidden'));
  };

  const box = $('messages');
  const follow = () => {
    // Follow the text only if the reader is at the bottom.
    if (box.scrollHeight - box.scrollTop - box.clientHeight < 120) box.scrollTop = box.scrollHeight;
  };

  const perFrame = Math.max(TYPE_MIN_CHARS, Math.ceil(total / (TYPE_MAX_MS / FRAME_MS)));
  let i = 0;
  let pos = 0;
  let done = false;

  const finish = () => {
    if (done) return;
    done = true;
    units.forEach((u) => { if (u.text) u.text.textContent = u.full; });
    hidden.forEach((el) => el.classList.remove('tw-hidden'));
    container.classList.remove('typing');
    container.removeEventListener('click', finish);
    follow();
  };
  container.addEventListener('click', finish);

  const step = () => {
    if (done) return;
    let budget = perFrame;
    while (budget > 0 && i < units.length) {
      const u = units[i];
      if (u.el) {
        reveal(u.el);
        i++;
        budget -= 20; // a block shown at once costs a little typing time
        continue;
      }
      if (pos === 0) reveal(u.text);
      const take = Math.min(budget, u.full.length - pos);
      pos += take;
      budget -= take;
      u.text.textContent = u.full.slice(0, pos);
      if (pos >= u.full.length) { i++; pos = 0; }
    }
    follow();
    // A timer rather than requestAnimationFrame: it keeps running (slowed down)
    // in a background tab, where animation frames stop.
    if (i < units.length) setTimeout(step, FRAME_MS);
    else finish();
  };
  // Leaving the tab mid-answer: show it entirely.
  document.addEventListener('visibilitychange', () => { if (document.hidden) finish(); }, { once: true });
  setTimeout(step, FRAME_MS);
}

function scrollMessages() {
  const box = $('messages');
  box.scrollTop = box.scrollHeight;
}

function renderMessages(messages) {
  emptyEl.hidden = messages.length > 0;
  $('messages').replaceChildren(emptyEl, ...messages.map((m) => messageEl(m.role, m.content)));
  scrollMessages();
}

// Prompt suggestions under "Posez une question" (new conversation only).
const SETUP_PROMPT = 'Configurer les notifications';

function renderSuggestions(schedule = window.Reports.schedule()) {
  const box = $('suggestions');
  const prompts = schedule && !schedule.configured ? [SETUP_PROMPT] : [];
  box.replaceChildren(...prompts.map((text) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.onclick = () => ask(text);
    return b;
  }));
  box.hidden = !prompts.length;
}

// Sends `text` in a new conversation (used by suggestions and the Reports tab).
function ask(text) {
  if (state.sending) return;
  if (state.currentId) newChat();
  if (mobileQuery.matches) setTab('assistant');
  $('input').value = text;
  send();
}
window.Assistant = { ask };

function appendMessage(node) {
  emptyEl.hidden = true;
  $('messages').append(node);
  scrollMessages();
}

// ---------------------------------------------------------------------------
// Live progress of the agents while an answer is being prepared
// ---------------------------------------------------------------------------

function progressEl() {
  const row = document.createElement('div');
  row.className = 'msg assistant pending agent-progress';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  const list = document.createElement('ol');
  list.className = 'steps';
  list.setAttribute('aria-live', 'polite');
  const elapsed = document.createElement('div');
  elapsed.className = 'elapsed';
  bubble.append(list, elapsed);
  row.append(bubble);

  const started = Date.now();
  const tick = () => { elapsed.textContent = `${Math.round((Date.now() - started) / 1000)} s`; };
  tick();
  row.timer = setInterval(tick, 1000);
  row.stop = () => clearInterval(row.timer);
  updateProgress(row, { id: 'send', label: 'Envoi de la question', status: 'active' });
  return row;
}

// step: { id, label, status: 'active' | 'done' | 'error', detail }
function updateProgress(row, step) {
  const list = row.querySelector('.steps');
  // The first real step replaces the placeholder.
  if (step.id !== 'send') list.querySelector('[data-id="send"]')?.remove();
  let item = [...list.children].find((li) => li.dataset.id === step.id);
  if (!item) {
    item = document.createElement('li');
    item.dataset.id = step.id;
    const label = document.createElement('span');
    label.className = 'step-label';
    const detail = document.createElement('span');
    detail.className = 'step-detail';
    item.append(label, detail);
    list.append(item);
  }
  item.className = `step ${step.status || 'active'}`;
  item.querySelector('.step-label').textContent = step.label;
  item.querySelector('.step-detail').textContent = step.detail || '';
  scrollMessages();
}

// POST a message and read the answer as a stream of JSON lines (progress
// events, then the final "done" event). Falls back to a plain JSON response.
async function postMessage(url, content, onProgress) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
    body: JSON.stringify({ content }),
  });
  if (res.status === 401) showLogin();
  const type = res.headers.get('Content-Type') || '';
  if (!res.ok || !type.includes('ndjson') || !res.body) {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
    return data;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result = null;
  const handle = (line) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === 'progress') onProgress(event);
    else if (event.type === 'done') result = event;
    else if (event.type === 'error') throw new Error(event.error);
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    lines.forEach(handle);
  }
  handle(buffer + decoder.decode());
  if (!result) throw new Error('Réponse interrompue');
  return result;
}

async function send() {
  const input = $('input');
  const content = input.value.trim();
  if (!content || state.sending) return;

  state.sending = true;
  $('send').disabled = true;
  input.value = '';
  autosize();
  setHistory(false);

  const pendingEl = progressEl();
  appendMessage(messageEl('user', content));
  appendMessage(pendingEl);

  try {
    if (!state.currentId) {
      const chat = await api('POST', '/api/chats');
      state.currentId = chat.id;
    }
    const { messages, chat } = await postMessage(
      `/api/chats/${state.currentId}/messages`, content, (step) => updateProgress(pendingEl, step),
    );
    pendingEl.replaceWith(messageEl('assistant', messages[1].content, false, true));
    setTitle(chat.title);
    upsertSummary(chat);
    window.Reports.refreshSchedule(); // the assistant may have just set up the reports
  } catch (err) {
    pendingEl.replaceWith(messageEl('assistant', `⚠ ${err.message}`, true));
  } finally {
    pendingEl.stop();
    state.sending = false;
    $('send').disabled = false;
    scrollMessages();
    focusInput();
  }
}

function autosize() {
  const input = $('input');
  input.style.height = 'auto';
  input.style.height = `${input.scrollHeight}px`;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').textContent = '';
  try {
    const { username } = await api('POST', '/api/login', { username: $('login-username').value });
    $('login-username').value = '';
    await showApp(username);
  } catch (err) {
    $('login-error').textContent = err.message;
  }
});

$('logout').addEventListener('click', async () => {
  await api('POST', '/api/logout').catch(() => {});
  state.chats = [];
  state.currentId = null;
  sessionStorage.removeItem('tab');
  setHistory(false);
  showLogin();
});

$('new-chat').addEventListener('click', newChat);
$('history-toggle').addEventListener('click', () => setHistory($('history').hidden));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('history').hidden) setHistory(false);
});

for (const b of document.querySelectorAll('button[data-tab]')) {
  b.addEventListener('click', () => setTab(b.dataset.tab));
}

// "Discuter avec l'assistant" on the profile result page.
window.addEventListener('profile:done', () => {
  setTab(mobileQuery.matches ? 'assistant' : 'portfolio');
  focusInput();
});

window.addEventListener('reports:schedule', (e) => renderSuggestions(e.detail));

$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  send();
});

$('input').addEventListener('keydown', (e) => {
  // On phones, Enter inserts a new line; the send button sends.
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !mobileQuery.matches) {
    e.preventDefault();
    send();
  }
});

$('input').addEventListener('input', autosize);

api('GET', '/api/me')
  .then(({ username }) => showApp(username))
  .catch(() => showLogin());

// ---------------------------------------------------------------------------
// Resizable assistant panel (desktop): drag the handle, arrows when focused,
// double-click to reset. The width is remembered in localStorage.
// ---------------------------------------------------------------------------

(() => {
  const handle = $('chat-resizer');
  const workspace = handle?.parentElement;
  if (!handle || !workspace) return;
  const KEY = 'chatWidth';
  const DEFAULT = 400;
  const MIN_CHAT = 300;
  const MIN_MAIN = 420;

  // While the app view is still hidden (e.g. right after a refresh, before
  // /api/me resolves) the workspace has no width, so only enforce the minimum.
  const clamp = (w) => {
    const available = workspace.clientWidth;
    const max = available ? available - MIN_MAIN - handle.offsetWidth : Infinity;
    return Math.round(Math.max(MIN_CHAT, Math.min(w, max)));
  };
  const current = () => $('assistant').getBoundingClientRect().width;

  function apply(width, save = true) {
    const w = clamp(width);
    workspace.style.setProperty('--chat-width', `${w}px`);
    handle.setAttribute('aria-valuenow', String(w));
    if (save) localStorage.setItem(KEY, String(w));
  }

  handle.setAttribute('aria-valuemin', String(MIN_CHAT));
  const saved = Number(localStorage.getItem(KEY));
  if (saved) apply(saved, false);

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    document.body.classList.add('resizing');
    const right = workspace.getBoundingClientRect().right;
    const move = (ev) => apply(right - ev.clientX - handle.offsetWidth / 2, false);
    const stop = () => {
      handle.classList.remove('dragging');
      document.body.classList.remove('resizing');
      handle.removeEventListener('pointermove', move);
      localStorage.setItem(KEY, String(Math.round(current())));
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop, { once: true });
    handle.addEventListener('pointercancel', stop, { once: true });
  });

  handle.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 80 : 24;
    if (e.key === 'ArrowLeft') apply(current() + step);
    else if (e.key === 'ArrowRight') apply(current() - step);
    else return;
    e.preventDefault();
  });

  handle.addEventListener('dblclick', () => {
    localStorage.removeItem(KEY);
    apply(DEFAULT, false);
  });

  // Keep the width valid when the workspace gets smaller (or first becomes visible).
  new ResizeObserver(() => {
    if (!workspace.clientWidth || !workspace.style.getPropertyValue('--chat-width')) return;
    apply(Number(localStorage.getItem(KEY)) || current(), false);
  }).observe(workspace);
})();
