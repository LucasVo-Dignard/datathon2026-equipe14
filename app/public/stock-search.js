'use strict';
// Stock search bar (top bar) and its quick-view modal.

(() => {
  const $ = (id) => document.getElementById(id);
  const modal = $('stock-modal');
  const pct = new Intl.NumberFormat('fr-CA', { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: 'exceptZero' });
  const fullDate = new Intl.DateTimeFormat('fr-CA', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const SOURCES = { yahoo: 'Yahoo Finance', finnhub: 'Finnhub' };

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
