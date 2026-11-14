'use strict';

const $ = (id) => document.getElementById(id);
const DEFAULT_TITLE = 'Nouvelle conversation';
const emptyEl = $('empty'); // kept as a reference: renderMessages detaches it

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
  state.chats = await api('GET', '/api/chats');
  if (state.chats.length) await openChat(state.chats[0].id);
  else newChat();
}

// ---------------------------------------------------------------------------
// Sidebar (a slide-in drawer on phones)
// ---------------------------------------------------------------------------

const mobileQuery = window.matchMedia('(max-width: 768px)');

function setSidebar(open) {
  $('app-view').classList.toggle('sidebar-open', open);
  $('menu').setAttribute('aria-expanded', String(open));
}

// Don't pop the on-screen keyboard open on phones when switching chats.
function focusInput() {
  if (!mobileQuery.matches) $('input').focus();
}

function renderChatList() {
  const list = $('chat-list');
  list.replaceChildren();
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
    rename.onclick = () => renameChat(chat);

    const del = document.createElement('button');
    del.className = 'icon';
    del.textContent = '🗑';
    del.title = 'Supprimer';
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
  document.title = `${title} – Chatbot`;
}

function newChat() {
  state.currentId = null;
  setTitle(DEFAULT_TITLE);
  renderMessages([]);
  renderChatList();
  setSidebar(false);
  focusInput();
}

async function openChat(id) {
  const chat = await api('GET', `/api/chats/${id}`);
  state.currentId = chat.id;
  setTitle(chat.title);
  renderMessages(chat.messages);
  renderChatList();
  setSidebar(false);
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
    if (state.chats.length) await openChat(state.chats[0].id);
    else newChat();
  } else {
    renderChatList();
  }
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

function renderMessages(messages) {
  const box = $('messages');
  emptyEl.hidden = messages.length > 0;
  box.replaceChildren(emptyEl);
  for (const m of messages) box.append(messageEl(m.role, m.content));
  box.scrollTop = box.scrollHeight;
}

function appendMessage(el) {
  emptyEl.hidden = true;
  const box = $('messages');
  box.append(el);
  box.scrollTop = box.scrollHeight;
}

async function send() {
  const input = $('input');
  const content = input.value.trim();
  if (!content || state.sending) return;

  state.sending = true;
  $('send').disabled = true;
  input.value = '';
  autosize();

  const userEl = messageEl('user', content);
  const pendingEl = messageEl('assistant', 'L’agent réfléchit…', true);
  appendMessage(userEl);
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
  setSidebar(false);
  showLogin();
});

$('new-chat').addEventListener('click', newChat);
$('new-chat-mobile').addEventListener('click', newChat);
$('menu').addEventListener('click', () => setSidebar(true));
$('backdrop').addEventListener('click', () => setSidebar(false));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') setSidebar(false);
});
mobileQuery.addEventListener('change', () => setSidebar(false));

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
