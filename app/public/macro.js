'use strict';
// Macro page: one table per World Bank indicator (countries x years).

(() => {
  const $ = (id) => document.getElementById(id);
  const POLL_MS = 15_000;

  // French labels for the default indicators and countries; anything else
  // keeps the World Bank's English name.
  const INDICATOR_NAMES = {
    'NY.GDP.MKTP.KD.ZG': 'Croissance du PIB (% annuel)',
    'FP.CPI.TOTL.ZG': 'Inflation, prix à la consommation (% annuel)',
    'SL.UEM.TOTL.ZS': 'Chômage (% de la population active)',
    'FR.INR.RINR': 'Taux d’intérêt réel (%)',
    'BN.CAB.XOKA.GD.ZS': 'Solde du compte courant (% du PIB)',
    'NY.GDP.MKTP.CD': 'PIB ($ US courants)',
  };
  const COUNTRY_NAMES = {
    CAN: 'Canada', USA: 'États-Unis', MEX: 'Mexique', GBR: 'Royaume-Uni', EMU: 'Zone euro',
    JPN: 'Japon', CHN: 'Chine', IND: 'Inde', WLD: 'Monde',
  };

  const percent = new Intl.NumberFormat('fr-CA', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const usd = new Intl.NumberFormat('fr-CA', {
    style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1,
  });
  const plain = new Intl.NumberFormat('fr-CA', { maximumFractionDigits: 2 });
  const dateTime = new Intl.DateTimeFormat('fr-CA', { dateStyle: 'long', timeStyle: 'short' });
  const dateOnly = new Intl.DateTimeFormat('fr-CA', { dateStyle: 'long', timeZone: 'UTC' });
  const PROVIDERS = { worldbank: 'Banque mondiale' };

  // "IMF (organisation) · World Development Indicators, Banque mondiale · mis à jour le ..."
  function describeSource(s) {
    const via = [s.dataset, PROVIDERS[s.provider] || s.provider].filter(Boolean).join(', ');
    const parts = [s.organization ? `${s.organization} (via ${via})` : via];
    if (s.updatedOn) parts.push(`source mise à jour le ${dateOnly.format(new Date(`${s.updatedOn}T00:00:00Z`))}`);
    return parts.join(' · ');
  }

  // Values are as published: the unit is in the World Bank's indicator name.
  function formatter(indicator) {
    if (/US\$/.test(indicator.name)) return (v) => usd.format(v);
    if (/%/.test(indicator.name)) return (v) => `${percent.format(v)} %`;
    return (v) => plain.format(v);
  }

  function el(tag, attrs = {}, text) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function card(indicator) {
    const format = formatter(indicator);
    const sources = Object.fromEntries(indicator.sources.map((s) => [s.id, s]));
    const section = el('section', { class: 'card' });
    const head = el('div', { class: 'card-head' });
    const titles = el('div');
    titles.append(
      el('h2', {}, INDICATOR_NAMES[indicator.code] || indicator.name),
      el('p', { class: 'muted small' },
        `${indicator.code} · mis à jour le ${dateTime.format(new Date(indicator.fetchedAt))}`),
    );
    head.append(titles);

    const table = el('table', { class: 'table' });
    const headRow = el('tr');
    headRow.append(el('th', { scope: 'col' }, 'Pays'));
    for (const year of indicator.years) headRow.append(el('th', { class: 'num', scope: 'col' }, String(year)));
    table.append(el('thead'));
    table.tHead.append(headRow);

    const body = el('tbody');
    for (const country of indicator.countries) {
      const tr = el('tr');
      const name = el('td', { title: country.name });
      const label = COUNTRY_NAMES[country.code] || country.name;
      if (country.url) {
        const link = el('a', { href: country.url, target: '_blank', rel: 'noopener',
          title: 'Voir la série à la source' }, label);
        name.append(link);
      } else {
        name.textContent = label;
      }
      tr.append(name);
      for (const year of indicator.years) {
        const cell = country.values[year];
        tr.append(cell == null
          ? el('td', { class: 'num missing', 'aria-label': 'Non disponible' }, '—')
          : el('td', { class: 'num', title: `Source : ${describeSource(sources[cell.source])}` }, format(cell.value)));
      }
      body.append(tr);
    }
    table.append(body);

    const wrap = el('div', { class: 'table-wrap' });
    wrap.append(table);
    const footer = el('div', { class: 'macro-sources small muted' });
    for (const s of indicator.sources) footer.append(el('p', {}, `Source : ${describeSource(s)}`));
    section.append(head, wrap, footer);
    return section;
  }

  let timer = null;

  async function load() {
    clearTimeout(timer);
    $('macro-error').textContent = '';
    try {
      const res = await fetch('/api/macro');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);

      $('macro-list').replaceChildren(...data.indicators.map(card));
      $('macro-status').textContent = data.loading
        ? 'Chargement depuis la Banque mondiale en cours (peut prendre quelques minutes)…'
        : data.indicators.length ? '' : 'Aucune donnée pour l’instant.';
      // Keep refreshing while the server is still downloading, if the page is shown.
      if (data.loading) {
        timer = setTimeout(() => {
          if (document.querySelector('.app')?.dataset.tab === 'macro') load();
        }, POLL_MS);
      }
    } catch (err) {
      $('macro-error').textContent = err.message;
    }
  }

  window.Macro = { load };
})();
