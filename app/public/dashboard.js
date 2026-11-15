'use strict';
// Portfolio dashboard: summary tiles, performance chart, holdings table.

(() => {
  const $ = (id) => document.getElementById(id);
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const PERIOD_DAYS = { '1M': 31, '3M': 92, '6M': 183, '1A': 366 };

  const money = new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD' });
  const moneyCompact = new Intl.NumberFormat('fr-CA', {
    style: 'currency', currency: 'CAD', notation: 'compact', maximumFractionDigits: 1,
  });
  const pct = new Intl.NumberFormat('fr-CA', { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pctShort = new Intl.NumberFormat('fr-CA', { style: 'percent', maximumFractionDigits: 1 });
  const num = new Intl.NumberFormat('fr-CA');
  const dayMonth = new Intl.DateTimeFormat('fr-CA', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const monthOnly = new Intl.DateTimeFormat('fr-CA', { month: 'short', timeZone: 'UTC' });
  const fullDate = new Intl.DateTimeFormat('fr-CA', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

  const parseDate = (iso) => new Date(`${iso}T00:00:00Z`);
  const signedMoney = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + money.format(Math.abs(n));
  const signedPct = (p) => (p > 0 ? '+' : p < 0 ? '−' : '') + pct.format(Math.abs(p));

  // Direction is shown by an arrow + sign, never by color alone.
  function setDelta(el, change, ratio, suffix = '') {
    const dir = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
    el.className = `delta ${dir}`;
    const arrow = { up: '▲', down: '▼', flat: '•' }[dir];
    el.textContent = `${arrow} ${ratio === undefined ? signedMoney(change) : signedPct(ratio)}${suffix}`;
  }

  function el(tag, attrs = {}, text) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function svg(tag, attrs = {}) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  }

  // -------------------------------------------------------------------------
  // Summary + holdings
  // -------------------------------------------------------------------------

  function renderSummary({ summary: s }) {
    $('total-value').textContent = money.format(s.totalValue);
    setDelta($('total-delta'), s.dayChange, s.dayChangePct, " aujourd'hui");
    $('day-value').textContent = signedMoney(s.dayChange);
    setDelta($('day-delta'), s.dayChange, s.dayChangePct);
    $('gain-value').textContent = signedMoney(s.gain);
    setDelta($('gain-delta'), s.gain, s.gainPct, ' depuis l’achat');
    $('cash-value').textContent = money.format(s.cash);
    $('cash-share').textContent = s.totalValue ? `${pctShort.format(s.cash / s.totalValue)} du portefeuille` : '';
  }

  function holdingRow(h) {
    const tr = el('tr');
    const name = el('td');
    const symbol = el('button', { type: 'button', class: 'symbol', title: `Voir ${h.symbol}` }, h.symbol);
    symbol.addEventListener('click', () => window.StockModal.open(h.symbol));
    name.append(symbol, el('span', { class: 'name', title: h.name }, h.available ? h.name : 'Cours indisponible'));
    const edit = el('button', { type: 'button', class: 'icon-btn row-edit', title: 'Modifier la quantité',
      'aria-label': `Modifier la quantité de ${h.symbol}` }, '✎');
    edit.addEventListener('click', () => { holdings.editing = h.symbol; renderHoldings(); });
    const actions = el('td', { class: 'row-actions' });
    actions.append(edit);

    if (!h.available) {
      tr.append(name, el('td', { class: 'num opt' }, num.format(h.quantity)),
        el('td', { class: 'num opt' }, '—'), el('td', { class: 'num opt-sm' }, '—'), el('td', { class: 'num' }, '—'),
        el('td', { class: 'num' }, '—'), el('td', { class: 'num opt' }, '—'), actions);
      return tr;
    }
    const day = el('td', { class: 'num opt-sm' });
    const dayDelta = el('span');
    setDelta(dayDelta, h.dayChange, h.dayChangePct);
    day.append(dayDelta);
    const gain = el('td', { class: 'num' });
    const gainPct = el('span');
    setDelta(gainPct, h.gain, h.gainPct);
    gain.append(el('span', { class: 'block' }, signedMoney(h.gain)), gainPct);
    tr.append(
      name,
      el('td', { class: 'num opt' }, num.format(h.quantity)),
      el('td', { class: 'num opt' }, money.format(h.price)),
      day,
      el('td', { class: 'num' }, money.format(h.marketValue)),
      gain,
      el('td', { class: 'num opt' }, pctShort.format(h.weight)),
      actions,
    );
    return tr;
  }

  // Edit mode spans the whole row, so it also works on phones where the quantity column is hidden.
  function editRow(h) {
    const tr = el('tr', { class: 'editing' });
    const td = el('td', { colspan: '8' });
    const form = el('form', { class: 'holding-form' });
    const id = `qty-${h.symbol.replace(/[^A-Za-z0-9]/g, '_')}`;
    const label = el('label', { for: id }, `Quantité de ${h.symbol}`);
    const input = el('input', { id, type: 'number', min: '0.0001', step: 'any', inputmode: 'decimal', required: '' });
    input.value = String(h.quantity);
    const save = el('button', { type: 'submit', class: 'primary' }, 'Enregistrer');
    const cancel = el('button', { type: 'button', class: 'secondary' }, 'Annuler');
    const remove = el('button', { type: 'button', class: 'secondary danger' }, 'Retirer');
    const stop = () => { holdings.editing = null; renderHoldings(); };
    cancel.addEventListener('click', stop);
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') stop(); });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      mutate('PUT', h.symbol, { quantity: Number(input.value) });
    });
    remove.addEventListener('click', () => {
      if (confirm(`Retirer ${h.symbol} du portefeuille ?`)) mutate('DELETE', h.symbol);
    });
    form.append(label, input, save, cancel, remove);
    td.append(form);
    tr.append(td);
    queueMicrotask(() => { input.focus(); input.select(); });
    return tr;
  }

  const holdings = { items: [], editing: null };

  function renderHoldings() {
    const rows = holdings.items.map((h) => (h.symbol === holdings.editing ? editRow(h) : holdingRow(h)));
    if (!rows.length) {
      const tr = el('tr');
      tr.append(el('td', { colspan: '8', class: 'muted' }, 'Aucune action pour l’instant. Ajoutez un titre ci-dessous.'));
      rows.push(tr);
    }
    $('holdings').tBodies[0].replaceChildren(...rows);
  }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || `Erreur ${res.status}`);
    return data;
  }

  async function mutate(method, symbol, body) {
    $('holdings-error').textContent = '';
    try {
      const data = await api(method, `/api/portfolio/holdings/${encodeURIComponent(symbol)}`, body);
      holdings.editing = null;
      render(data);
      return true;
    } catch (err) {
      $('holdings-error').textContent = err.message;
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // News (filterable by sector)
  // -------------------------------------------------------------------------

  const relTime = new Intl.RelativeTimeFormat('fr-CA', { numeric: 'auto' });
  const news = { items: [], names: {}, sector: null };

  function ago(iso) {
    const h = Math.round((Date.now() - Date.parse(iso)) / 3600e3);
    return h < 24 ? relTime.format(-Math.max(h, 1), 'hour') : relTime.format(-Math.round(h / 24), 'day');
  }

  function renderNews() {
    const sectors = [...new Set(news.items.map((n) => n.sector))];
    const filter = $('news-filter');
    filter.replaceChildren(...[null, ...sectors].map((sec) => {
      const b = el('button', { 'aria-pressed': String(sec === news.sector) }, sec ?? 'Tout');
      b.onclick = () => { news.sector = sec; renderNews(); };
      return b;
    }));

    const items = news.items.filter((n) => !news.sector || n.sector === news.sector);
    $('news').replaceChildren(...items.map((n) => {
      const li = el('li', { class: 'news-item' });
      const tags = el('div', { class: 'tags' });
      tags.append(el('span', { class: 'tag sector' }, n.sector));
      for (const sym of n.symbols) tags.append(el('span', { class: 'tag', title: news.names[sym] || sym }, sym));
      li.append(
        tags,
        el('h3', {}, n.title),
        el('p', {}, n.summary),
        el('span', { class: 'meta' }, `${n.source} · ${ago(n.publishedAt)}`),
      );
      return li;
    }));
  }

  // -------------------------------------------------------------------------
  // Performance chart (single series: no legend, the card title names it)
  // -------------------------------------------------------------------------

  const chart = { history: [], period: '1A', points: [], hover: null, layout: null };

  function niceStep(rough) {
    const pow = 10 ** Math.floor(Math.log10(rough));
    const f = rough / pow;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * pow;
  }

  function periodPoints() {
    const end = parseDate(chart.history.at(-1).date);
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - PERIOD_DAYS[chart.period]);
    return chart.history.filter((p) => parseDate(p.date) >= start);
  }

  function renderChart() {
    const box = $('chart');
    if (chart.history.length < 2) {
      chart.points = [];
      chart.layout = null;
      $('perf-summary').replaceChildren();
      box.setAttribute('aria-label', 'Aucune donnée de performance');
      box.replaceChildren(el('p', { class: 'muted small' }, 'Ajoutez des titres pour voir la performance du portefeuille.'));
      $('history-table').tBodies[0].replaceChildren();
      return;
    }
    const pts = (chart.points = periodPoints());
    if (pts.length < 2) return;

    const first = pts[0].value;
    const last = pts.at(-1).value;
    const change = last - first;
    const label = { '1M': '1 mois', '3M': '3 mois', '6M': '6 mois', '1A': '1 an' }[chart.period];

    const summary = $('perf-summary');
    summary.replaceChildren();
    const delta = el('span');
    setDelta(delta, change, change / first);
    summary.append(delta, ` (${signedMoney(change)}) sur ${label}`);
    box.setAttribute('aria-label',
      `Valeur du portefeuille sur ${label} : de ${money.format(first)} à ${money.format(last)}, ` +
      `soit ${signedPct(change / first)}. Flèches gauche et droite pour parcourir les valeurs.`);

    const W = box.clientWidth || 600;
    const H = W < 480 ? 220 : 260;
    // Right margin reserves room for the end label beside the last point.
    const m = { top: 16, right: 92, bottom: 28, left: 64 };
    const iw = W - m.left - m.right;
    const ih = H - m.top - m.bottom;

    let lo = Math.min(...pts.map((p) => p.value));
    let hi = Math.max(...pts.map((p) => p.value));
    const step = niceStep((hi - lo || hi * 0.01) / 4);
    lo = Math.floor(lo / step) * step;
    hi = Math.ceil(hi / step) * step;

    const x = (i) => m.left + (i / (pts.length - 1)) * iw;
    const y = (v) => m.top + (1 - (v - lo) / (hi - lo)) * ih;
    chart.layout = { x, y, m, iw, ih, W, H };

    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, 'aria-hidden': 'true' });

    // Recessive hairline grid + y ticks.
    for (let v = lo; v <= hi + step / 2; v += step) {
      root.append(svg('line', { x1: m.left, x2: m.left + iw, y1: y(v), y2: y(v), class: v === lo ? 'axis' : 'grid' }));
      const t = svg('text', { x: m.left - 8, y: y(v), class: 'tick', 'text-anchor': 'end', 'dominant-baseline': 'middle' });
      t.textContent = moneyCompact.format(v);
      root.append(t);
    }

    // X ticks: ~5 evenly spaced dates.
    const nTicks = W < 480 ? 3 : 5;
    const fmt = chart.period === '1A' || chart.period === '6M' ? monthOnly : dayMonth;
    for (let k = 0; k < nTicks; k++) {
      const i = Math.round((k / (nTicks - 1)) * (pts.length - 1));
      const anchor = k === 0 ? 'start' : k === nTicks - 1 ? 'end' : 'middle';
      const t = svg('text', { x: x(i), y: H - 8, class: 'tick', 'text-anchor': anchor });
      t.textContent = fmt.format(parseDate(pts[i].date));
      root.append(t);
    }

    // The line.
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
    root.append(svg('path', { d, class: 'line' }));

    // End marker + direct label (the endpoint is the one value we label).
    const ex = x(pts.length - 1);
    const ey = y(last);
    root.append(svg('circle', { cx: ex, cy: ey, r: 4, class: 'dot' }));
    const endLabel = svg('text', { x: ex + 10, y: ey, class: 'end-label', 'dominant-baseline': 'middle' });
    endLabel.textContent = money.format(last);
    root.append(endLabel);
    chart.endLabel = endLabel;

    // Hover layer: crosshair + dot (hidden until hover/focus).
    const cross = svg('line', { y1: m.top, y2: m.top + ih, class: 'crosshair', visibility: 'hidden' });
    const hoverDot = svg('circle', { r: 4, class: 'dot', visibility: 'hidden' });
    root.append(cross, hoverDot);
    chart.cross = cross;
    chart.hoverDot = hoverDot;

    const tip = el('div', { class: 'tooltip', hidden: '' });
    chart.tip = tip;
    box.replaceChildren(root, tip);

    renderHistoryTable(pts);
    if (chart.hover !== null) showHover(Math.min(chart.hover, pts.length - 1));
  }

  function showHover(i) {
    const { x, y, W } = chart.layout;
    const pts = chart.points;
    const p = pts[i];
    chart.hover = i;
    const cx = x(i);
    const cy = y(p.value);
    chart.cross.setAttribute('x1', cx);
    chart.cross.setAttribute('x2', cx);
    chart.cross.setAttribute('visibility', 'visible');
    chart.hoverDot.setAttribute('cx', cx);
    chart.hoverDot.setAttribute('cy', cy);
    chart.hoverDot.setAttribute('visibility', 'visible');
    chart.endLabel.setAttribute('visibility', 'hidden');

    const change = p.value - pts[0].value;
    const tip = chart.tip;
    tip.replaceChildren(
      el('div', { class: 'tip-date' }, fullDate.format(parseDate(p.date))),
      el('div', { class: 'tip-value' }, money.format(p.value)),
    );
    const d = el('div');
    setDelta(d, change, change / pts[0].value, ' sur la période');
    tip.append(d);
    tip.hidden = false;
    // Keep the tooltip inside the chart: flip to the left of the crosshair near the right edge.
    const tw = tip.offsetWidth;
    tip.style.left = `${cx + 12 + tw > W ? cx - 12 - tw : cx + 12}px`;
    tip.style.top = `${Math.max(0, cy - tip.offsetHeight - 12)}px`;
  }

  function hideHover() {
    chart.hover = null;
    if (!chart.tip) return;
    chart.tip.hidden = true;
    chart.cross.setAttribute('visibility', 'hidden');
    chart.hoverDot.setAttribute('visibility', 'hidden');
    chart.endLabel.setAttribute('visibility', 'visible');
  }

  function indexAt(clientX) {
    const { m, iw } = chart.layout;
    const rect = $('chart').getBoundingClientRect();
    const t = (clientX - rect.left - m.left) / iw;
    return Math.max(0, Math.min(chart.points.length - 1, Math.round(t * (chart.points.length - 1))));
  }

  function renderHistoryTable(pts) {
    const rows = [...pts].reverse().map((p) => {
      const tr = el('tr');
      tr.append(el('td', {}, fullDate.format(parseDate(p.date))), el('td', { class: 'num' }, money.format(p.value)));
      return tr;
    });
    $('history-table').tBodies[0].replaceChildren(...rows);
  }

  function setupChart() {
    const box = $('chart');
    box.addEventListener('pointermove', (e) => chart.layout && showHover(indexAt(e.clientX)));
    box.addEventListener('pointerdown', (e) => chart.layout && showHover(indexAt(e.clientX)));
    box.addEventListener('pointerleave', (e) => e.pointerType === 'mouse' && hideHover());
    box.addEventListener('blur', hideHover);
    box.addEventListener('keydown', (e) => {
      if (!chart.layout) return;
      const last = chart.points.length - 1;
      const cur = chart.hover ?? last;
      const next = { ArrowLeft: cur - 1, ArrowRight: cur + 1, Home: 0, End: last }[e.key];
      if (next === undefined) {
        if (e.key === 'Escape') hideHover();
        return;
      }
      e.preventDefault();
      showHover(Math.max(0, Math.min(last, next)));
    });

    for (const btn of $('periods').querySelectorAll('button')) {
      btn.addEventListener('click', () => {
        chart.period = btn.dataset.period;
        for (const b of $('periods').querySelectorAll('button')) {
          b.setAttribute('aria-pressed', String(b === btn));
        }
        hideHover();
        renderChart();
      });
    }

    let lastWidth = 0;
    new ResizeObserver(() => {
      const w = box.clientWidth;
      if (w && w !== lastWidth && chart.history.length) {
        lastWidth = w;
        renderChart();
      }
    }).observe(box);
  }

  // -------------------------------------------------------------------------
  // First visit: random portfolio or build your own
  // -------------------------------------------------------------------------

  function showSetup(show) {
    $('portfolio-setup').hidden = !show;
    for (const section of document.querySelectorAll('#dashboard .dash-section')) section.hidden = show;
  }

  function setupPortfolio() {
    const buttons = $('portfolio-setup').querySelectorAll('button[data-mode]');
    for (const btn of buttons) {
      btn.addEventListener('click', async () => {
        $('setup-error').textContent = '';
        $('setup-status').textContent = btn.dataset.mode === 'random' ? 'Sélection des titres…' : '';
        for (const b of buttons) b.disabled = true;
        try {
          render(await api('POST', '/api/portfolio', { mode: btn.dataset.mode }));
          if (btn.dataset.mode === 'custom') $('add-symbol').focus();
        } catch (err) {
          $('setup-error').textContent = err.message;
        } finally {
          $('setup-status').textContent = '';
          for (const b of buttons) b.disabled = false;
        }
      });
    }

    $('add-holding').addEventListener('submit', async (e) => {
      e.preventDefault();
      const symbol = $('add-symbol').value.trim().toUpperCase();
      const quantity = Number($('add-quantity').value);
      if (!symbol) return;
      const submit = e.target.querySelector('button[type="submit"]');
      submit.disabled = true;
      if (await mutate('PUT', symbol, { quantity })) {
        $('add-symbol').value = '';
        $('add-quantity').value = '';
      }
      submit.disabled = false;
    });
  }

  // -------------------------------------------------------------------------

  function render(data) {
    showSetup(false);
    renderSummary(data);
    holdings.items = data.holdings;
    renderHoldings();
    news.items = data.news || [];
    news.names = Object.fromEntries(data.holdings.map((h) => [h.symbol, h.name]));
    renderNews();
    chart.history = data.history;
    hideHover();
    renderChart();
  }

  // Resolves to true if the user already has a portfolio, false if they still have to choose.
  async function load() {
    $('dash-error').textContent = '';
    try {
      const data = await api('GET', '/api/portfolio');
      if (!data) {
        showSetup(true);
        return false;
      }
      render(data);
    } catch (err) {
      $('dash-error').textContent = `Impossible de charger le portefeuille : ${err.message}`;
    }
    return true;
  }

  setupChart();
  setupPortfolio();
  window.Dashboard = { load, redraw: () => chart.history.length && renderChart() };
})();
