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
  const savedTab = sessionStorage.getItem('tab');
  if (savedTab) $('app-view').dataset.tab = savedTab; // avoid flashing the default tab while loading
  window.Dashboard.load();
  const [chats, hasProfile] = await Promise.all([api('GET', '/api/chats'), window.Profile.init()]);
  // Refresh: stay on the same tab. First visit: guide the user through the investor-profile questionnaire.
  setTab(savedTab || (hasProfile ? 'portfolio' : 'profile'));
  state.chats = chats;
  if (state.chats.length) await openChat(state.chats[0].id);
  else newChat();
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
  else if (tab === 'macro') window.Macro.load();
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

function messageEl(role, content, pending = false) {
  const row = document.createElement('div');
  row.className = `msg ${role}` + (pending ? ' pending' : '');
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = content;
  row.append(bubble);
  return row;
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

function appendMessage(node) {
  emptyEl.hidden = true;
  $('messages').append(node);
  scrollMessages();
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

  const pendingEl = messageEl('assistant', 'L’agent réfléchit…', true);
  appendMessage(messageEl('user', content));
  appendMessage(pendingEl);

  try {
    if (!state.currentId) {
      const chat = await api('POST', '/api/chats');
      state.currentId = chat.id;
    }
    const { messages, chat } = await api('POST', `/api/chats/${state.currentId}/messages`, { content });
    pendingEl.replaceWith(messageEl('assistant', messages[1].content));
    setTitle(chat.title);
    upsertSummary(chat);
  } catch (err) {
    pendingEl.replaceWith(messageEl('assistant', `⚠ ${err.message}`, true));
  } finally {
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
