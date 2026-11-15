'use strict';
// Reports page: the scheduled reports (set up with the assistant), the
// reports written so far, and a report on demand for any period.
//
// A scheduled report the user has not seen yet shows a "Nouveau" badge on the
// tab and a notice in the assistant panel, with a link (#rapport/<id>) that
// opens it. "Seen" is remembered per user in localStorage.

(() => {
  const $ = (id) => document.getElementById(id);
  const dateTime = new Intl.DateTimeFormat('fr-CA', { dateStyle: 'long', timeStyle: 'short' });
  const REFRESH_MS = 15 * 60 * 1000;
  const LINK_RE = /^#rapport\/([0-9a-f-]{36})$/;

  let user = null;
  let reports = [];
  let schedule = null;
  let loaded = false;
  let generating = false;
  let pendingOpen = null; // report id to show once the list is there
  let timer = null;

  function el(tag, attrs = {}, text) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
    return data;
  }

  // --- New scheduled reports -----------------------------------------------------

  const seenKey = () => `reportsSeen:${user}`;
  const seenAt = () => Number(localStorage.getItem(seenKey())) || 0;
  const unseen = () => reports.filter((r) => r.scheduled && r.createdAt > seenAt());
  const isTabOpen = () => document.getElementById('app-view').dataset.tab === 'reports';

  function markSeen() {
    const latest = Math.max(seenAt(), ...reports.map((r) => r.createdAt));
    if (user && latest) localStorage.setItem(seenKey(), String(latest));
    showUnseen();
  }

  function showUnseen() {
    const fresh = unseen();
    for (const b of document.querySelectorAll('[data-reports-badge]')) b.hidden = !fresh.length;
    $('report-notice').hidden = !fresh.length;
    if (!fresh.length) return;
    $('report-notice-text').textContent = fresh.length === 1
      ? `Votre ${fresh[0].title.toLowerCase()} est prêt.`
      : `${fresh.length} nouveaux rapports sont prêts.`;
    $('report-notice-open').href = `#rapport/${fresh[0].id}`;
    $('report-notice-open').textContent = fresh.length === 1 ? 'Voir le rapport' : 'Voir le plus récent';
  }

  // --- Report cards ----------------------------------------------------------------

  function reportText(content) {
    // Same safe Markdown renderer as the assistant's answers (markdown.js).
    const body = el('div', { class: 'md report-md' });
    body.append(window.renderMarkdown(content));
    return body;
  }

  // Key figures computed by the server (reports.highlights), above the text.
  function tiles(highlights) {
    const row = el('div', { class: 'report-tiles' });
    for (const t of highlights || []) {
      const tile = el('div', { class: 'report-tile' });
      tile.append(
        el('span', { class: 'label' }, t.label),
        el('span', { class: `report-tile-value delta ${t.tone}` }, t.value),
        el('span', { class: 'muted small' }, t.detail),
      );
      row.append(tile);
    }
    return row;
  }

  // Folded by default: a click on the title shows the report.
  function setOpen(section, open) {
    section.querySelector('.report-toggle').setAttribute('aria-expanded', String(open));
    section.querySelector('.report-body').hidden = !open;
  }

  function card(report, { open = false } = {}) {
    const section = el('section', { class: `card report report-${report.period}`, 'data-id': report.id, id: `rapport-${report.id}`, tabindex: '-1' });
    const head = el('div', { class: 'card-head' });
    const titles = el('div');
    const h2 = el('h2');
    const toggle = el('button', { type: 'button', class: 'report-toggle', 'aria-controls': `rapport-body-${report.id}` }, report.title);
    toggle.onclick = () => setOpen(section, toggle.getAttribute('aria-expanded') !== 'true');
    h2.append(toggle);
    if (report.scheduled) h2.append(' ', el('span', { class: 'tag scheduled' }, 'Programmé'));
    if (report.scheduled && report.createdAt > seenAt()) h2.append(' ', el('span', { class: 'badge new' }, 'Nouveau'));
    titles.append(
      h2,
      el('p', { class: 'muted small' }, `Généré le ${dateTime.format(new Date(report.createdAt))}`),
    );
    const del = el('button', { type: 'button', class: 'report-delete', 'aria-label': `Supprimer ${report.title}` }, 'Supprimer');
    del.onclick = async () => {
      if (!confirm(`Supprimer ce ${report.title.toLowerCase()} ?`)) return;
      try {
        await api('DELETE', `/api/reports/${report.id}`);
        reports = reports.filter((r) => r.id !== report.id);
        section.remove();
        showEmpty();
        showUnseen();
      } catch (err) {
        $('reports-error').textContent = err.message;
      }
    };
    head.append(titles, del);
    const body = el('div', { class: 'report-body', id: `rapport-body-${report.id}` });
    if (report.highlights?.length) body.append(tiles(report.highlights));
    body.append(reportText(report.content));
    section.append(head, body);
    setOpen(section, open);
    return section;
  }

  function renderList() {
    $('reports-list').replaceChildren(...reports.map(card));
    if (!generating) showEmpty();
  }

  function showEmpty() {
    $('reports-status').textContent = $('reports-list').children.length
      ? '' : 'Aucun rapport pour l’instant. Programmez-en avec l’assistant, ou choisissez une période pour en générer un.';
  }

  async function fetchReports() {
    const list = await api('GET', '/api/reports');
    const changed = list.length !== reports.length || list.some((r, i) => r.id !== reports[i]?.id);
    reports = list;
    loaded = true;
    if (changed) renderList();
    if (isTabOpen() && !pendingOpen) markSeen();
    else showUnseen();
  }

  // --- Schedule ------------------------------------------------------------------

  function renderSchedule() {
    const list = $('report-schedule-list');
    const items = schedule?.schedules || [];
    list.replaceChildren(...items.map((s) => el('li', {}, s.label)));
    $('report-schedule-empty').textContent = !schedule?.configured
      ? 'Aucun rapport programmé pour l’instant. L’assistant vous demande lesquels vous voulez et quand.'
      : items.length ? 'Heure de l’Est. Chaque rapport arrive ici, et l’application vous le signale.'
        : 'Vous avez choisi de ne pas recevoir de rapport programmé.';
    $('report-schedule-edit').textContent = items.length ? 'Modifier avec l’assistant' : 'Programmer avec l’assistant';
    $('report-schedule-stop').hidden = !items.length;
  }

  async function refreshSchedule() {
    try {
      schedule = await api('GET', '/api/report-schedule');
    } catch (err) {
      console.error('report schedule:', err.message);
      return schedule;
    }
    renderSchedule();
    window.dispatchEvent(new CustomEvent('reports:schedule', { detail: schedule }));
    return schedule;
  }

  // --- Opening a report ------------------------------------------------------------

  function reveal(id) {
    const node = $(`rapport-${id}`);
    if (!node) {
      $('reports-error').textContent = 'Ce rapport n’existe plus.';
      return;
    }
    setOpen(node, true);
    node.scrollIntoView({ behavior: 'smooth', block: 'start' });
    node.focus({ preventScroll: true });
    node.classList.add('highlight');
    setTimeout(() => node.classList.remove('highlight'), 2500);
  }

  function open(id) {
    pendingOpen = id;
    if (!isTabOpen()) document.querySelector('button[data-tab="reports"]').click(); // calls load()
    else load();
  }

  function openFromHash() {
    const m = location.hash.match(LINK_RE);
    if (!m) return;
    history.replaceState(null, '', location.pathname + location.search);
    open(m[1]);
  }

  // --- Entry points ---------------------------------------------------------------

  // After login: list, schedule and new reports, even if the tab is not open.
  async function init(username) {
    user = username;
    reports = [];
    loaded = false;
    $('reports-list').replaceChildren();
    await Promise.all([fetchReports().catch((err) => console.error('reports:', err.message)), refreshSchedule()]);
    clearInterval(timer);
    timer = setInterval(() => { if (!document.hidden) fetchReports().catch(() => {}); }, REFRESH_MS);
  }

  // The Reports tab was opened.
  async function load() {
    $('reports-error').textContent = '';
    if (!loaded) {
      try {
        await fetchReports();
      } catch (err) {
        $('reports-error').textContent = err.message;
        return;
      }
    }
    if (pendingOpen) {
      reveal(pendingOpen);
      pendingOpen = null;
    }
    // Leave the "Nouveau" tags on the cards for this visit; badge and notice go.
    markSeen();
  }

  async function generate(period, button) {
    if (generating) return;
    generating = true;
    const buttons = document.querySelectorAll('#report-periods button');
    for (const b of buttons) b.disabled = true;
    $('reports-error').textContent = '';
    $('reports-status').textContent = `L’assistant rédige votre rapport ${button.textContent.toLowerCase()}…`;
    try {
      const report = await api('POST', '/api/reports', { period });
      reports = [report, ...reports];
      $('reports-list').prepend(card(report, { open: true }));
      $('reports-status').textContent = '';
    } catch (err) {
      $('reports-error').textContent = err.message;
      showEmpty();
    } finally {
      generating = false;
      for (const b of buttons) b.disabled = false;
    }
  }

  for (const b of document.querySelectorAll('#report-periods button')) {
    b.addEventListener('click', () => generate(b.dataset.period, b));
  }

  $('report-schedule-edit').addEventListener('click', () => window.Assistant.ask('Configurer les notifications'));
  $('report-schedule-stop').addEventListener('click', async () => {
    if (!confirm('Arrêter tous les rapports programmés ?')) return;
    try {
      schedule = await api('DELETE', '/api/report-schedule');
      renderSchedule();
      window.dispatchEvent(new CustomEvent('reports:schedule', { detail: schedule }));
    } catch (err) {
      $('reports-error').textContent = err.message;
    }
  });

  $('report-notice-close').addEventListener('click', markSeen);
  window.addEventListener('hashchange', openFromHash);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && user) fetchReports().catch(() => {});
  });

  // Another user may log in on the same page: start over next time.
  $('logout').addEventListener('click', () => {
    user = null;
    reports = [];
    schedule = null;
    loaded = false;
    clearInterval(timer);
    $('reports-list').replaceChildren();
    $('report-notice').hidden = true;
    for (const b of document.querySelectorAll('[data-reports-badge]')) b.hidden = true;
  });

  window.Reports = { init, load, open, openFromHash, refreshSchedule, schedule: () => schedule };
})();
