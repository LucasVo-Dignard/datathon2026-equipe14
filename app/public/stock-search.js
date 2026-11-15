'use strict';
// Stock search bar (top bar) and its quick-view modal.

(() => {
  const $ = (id) => document.getElementById(id);
  const modal = $('stock-modal');
  const pct = new Intl.NumberFormat('fr-CA', { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: 'exceptZero' });
  const fullDate = new Intl.DateTimeFormat('fr-CA', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const SOURCES = { yahoo: 'Yahoo Finance', finnhub: 'Finnhub' };
  // Yahoo sector names (company profiles and fund weights) in French.
  const SECTORS = {
    Technology: 'Technologie', 'Communication Services': 'Communications', 'Financial Services': 'Services financiers',
    Healthcare: 'Santé', Energy: 'Énergie', Industrials: 'Industrie', 'Consumer Cyclical': 'Consommation discrétionnaire',
    'Consumer Defensive': 'Consommation de base', 'Basic Materials': 'Matériaux', 'Real Estate': 'Immobilier', Utilities: 'Services publics',
  };
  const share = new Intl.NumberFormat('fr-CA', { style: 'percent', maximumFractionDigits: 1 });

  function el(tag, attrs = {}, text) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // ETF: main sectors and top holdings, as small weight lists.
  function fundDetails(fund) {
    const box = $('stock-fund');
    box.replaceChildren();
    box.hidden = !fund;
    if (!fund) return;
    const list = (title, rows) => {
      if (!rows.length) return;
      const ul = el('ul', { class: 'weights' });
      for (const [label, w] of rows) {
        const li = el('li');
        li.append(el('span', {}, label), el('span', { class: 'bar' }), el('b', {}, share.format(w)));
        li.querySelector('.bar').style.setProperty('--w', `${Math.round(w * 100)}%`);
        ul.append(li);
      }
      box.append(el('h3', {}, title), ul);
    };
    list('Principaux secteurs', Object.entries(fund.sectorWeights).sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([s, w]) => [SECTORS[s] || s, w]));
    list('Principaux titres détenus', fund.topHoldings.slice(0, 5).map((h) => [h.name || h.symbol, h.weight]));
    box.append(el('p', { class: 'muted small' }, 'Composition publiée par le fonds (Yahoo Finance).'));
  }

  const money = (n, currency) => (currency
    ? new Intl.NumberFormat('fr-CA', { style: 'currency', currency }).format(n)
    : new Intl.NumberFormat('fr-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n));

  function render(stock) {
    $('stock-symbol').textContent = stock.symbol;
    $('stock-name').textContent = stock.name;
    $('stock-price').textContent = money(stock.price, stock.currency);

    const delta = $('stock-delta');
    if (stock.change == null) {
      delta.textContent = '';
    } else {
      const dir = stock.change > 0 ? 'up' : stock.change < 0 ? 'down' : 'flat';
      delta.className = `delta ${dir}`;
      delta.textContent = `${stock.change > 0 ? '+' : ''}${money(stock.change, stock.currency)} (${pct.format(stock.changePct)}) aujourd’hui`;
    }

    const rows = [
      ['Type', stock.fund ? 'FNB (fonds négocié en bourse)' : null],
      ['Gestionnaire', stock.fund?.family],
      ['Bourse', stock.exchange],
      ['Devise', stock.currency],
      ['Au', stock.asOf && fullDate.format(new Date(stock.asOf))],
      ['Source', SOURCES[stock.source] || stock.source],
    ].filter(([, v]) => v);
    $('stock-meta').replaceChildren(...rows.flatMap(([k, v]) => {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      return [dt, dd];
    }));
    fundDetails(stock.fund);
  }

  async function open(query) {
    $('stock-error').textContent = '';
    $('stock-body').hidden = true;
    $('stock-symbol').textContent = query.toUpperCase();
    $('stock-name').textContent = 'Chargement…';
    if (!modal.open) modal.showModal();

    try {
      const res = await fetch(`/api/stocks/${encodeURIComponent(query)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
      render(data);
      $('stock-body').hidden = false;
    } catch (err) {
      $('stock-name').textContent = '';
      $('stock-error').textContent = err.message;
    }
  }

  $('stock-search').addEventListener('submit', (e) => {
    e.preventDefault();
    const query = $('stock-query').value.trim();
    if (!query) return;
    $('stock-query').blur();
    open(query);
  });

  window.StockModal = { open };

  $('stock-close').addEventListener('click', () => modal.close());
  // Click on the backdrop closes the modal.
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.close();
  });
})();
