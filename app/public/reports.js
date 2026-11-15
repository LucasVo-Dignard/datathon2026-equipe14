'use strict';
// Reports page: generate a simulated daily / weekly / monthly / yearly report
// with the agent, and list the previous ones.

(() => {
  const $ = (id) => document.getElementById(id);
  const dateTime = new Intl.DateTimeFormat('fr-CA', { dateStyle: 'long', timeStyle: 'short' });

  let loaded = false;
  let generating = false;

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

  function reportText(content) {
    // Same safe Markdown renderer as the assistant's answers (markdown.js).
    const body = el('div', { class: 'md report-md' });
    body.append(window.renderMarkdown(content));
    return body;
  }

  function card(report) {
    const section = el('section', { class: 'card', 'data-id': report.id });
    const head = el('div', { class: 'card-head' });
    const titles = el('div');
    titles.append(
      el('h2', {}, report.title),
      el('p', { class: 'muted small' }, `Généré le ${dateTime.format(new Date(report.createdAt))}`),
    );
    const del = el('button', { type: 'button', class: 'report-delete', 'aria-label': `Supprimer ${report.title}` }, 'Supprimer');
    del.onclick = async () => {
      if (!confirm(`Supprimer ce ${report.title.toLowerCase()} ?`)) return;
      try {
        await api('DELETE', `/api/reports/${report.id}`);
        section.remove();
        showEmpty();
      } catch (err) {
        $('reports-error').textContent = err.message;
      }
    };
    head.append(titles, del);
    section.append(head, reportText(report.content));
    return section;
  }

  function showEmpty() {
    $('reports-status').textContent = $('reports-list').children.length
      ? '' : 'Aucun rapport pour l’instant. Choisissez une période pour en générer un.';
  }

  async function load() {
    if (loaded) return;
    $('reports-error').textContent = '';
    try {
      const reports = await api('GET', '/api/reports');
      $('reports-list').replaceChildren(...reports.map(card));
      loaded = true;
      if (!generating) showEmpty();
    } catch (err) {
      $('reports-error').textContent = err.message;
    }
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
      $('reports-list').prepend(card(report));
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

  // Another user may log in on the same page: reload the list next time.
  $('logout').addEventListener('click', () => {
    loaded = false;
    $('reports-list').replaceChildren();
  });

  window.Reports = { load };
})();
