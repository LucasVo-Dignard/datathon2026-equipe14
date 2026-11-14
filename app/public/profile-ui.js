'use strict';
// Questionnaire guidé du profil investisseur + affichage du résultat.
// Exposé à app.js via window.Profile.

(() => {
  const view = document.getElementById('profile-view');
  const body = document.getElementById('profile-body');

  const st = { questions: [], personas: [], profile: null, answers: {}, step: 0, persona: null };

  // Petit constructeur DOM : h('div', { class: 'x', onclick }, 'texte', enfant…)
  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    el.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
    return el;
  }

  async function api(method, url, payload) {
    const res = await fetch(url, {
      method,
      headers: payload ? { 'Content-Type': 'application/json' } : {},
      body: payload ? JSON.stringify(payload) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || `Erreur ${res.status}`);
    return data;
  }

  function render(...nodes) {
    body.replaceChildren(...nodes.flat().filter(Boolean));
    view.scrollTop = 0;
  }

  function updateBadge() {
    for (const badge of document.querySelectorAll('[data-profile-badge]')) {
      badge.textContent = st.profile ? st.profile.result.level.label : 'À compléter';
      badge.className = `badge ${st.profile ? `lvl-${st.profile.result.level.id}` : 'todo'}`;
    }
  }

  // ---------------------------------------------------------------------------
  // Accueil : questionnaire vierge ou prérempli à partir d'un persona du cas
  // ---------------------------------------------------------------------------

  function renderIntro() {
    render(
      h('h1', {}, 'Votre profil investisseur'),
      h('p', { class: 'lead' }, `Quelques questions (${st.questions.length}, environ 5 minutes) pour comprendre vos objectifs, `
        + 'vos préférences et votre rapport au risque. Les agents s’appuieront sur ce profil pour adapter et expliquer leurs analyses.'),
      h('button', { class: 'primary', onclick: () => start({}, null) }, 'Commencer le questionnaire'),
      h('h2', {}, 'Ou partez d’un persona du cas'),
      h('p', { class: 'muted' }, 'Les réponses sont préremplies : vous pourrez les vérifier et les ajuster une à une.'),
      h('div', { class: 'personas' }, st.personas.map((p) => h('button', { class: 'persona', onclick: () => start(p.answers, p) },
        h('strong', {}, p.name), h('span', { class: 'muted' }, `${p.age} ans · ${p.job}`),
        h('span', {}, `Risque : ${p.risk} · Horizon : ${p.horizon}`),
        h('span', { class: 'small' }, p.summary)))),
      disclaimer(),
    );
  }

  function start(answers, persona) {
    st.answers = structuredClone(answers);
    st.persona = persona;
    st.step = 0;
    renderStep();
  }

  // ---------------------------------------------------------------------------
  // Une question par écran
  // ---------------------------------------------------------------------------

  function renderStep() {
    const q = st.questions[st.step];
    const total = st.questions.length;
    const value = st.answers[q.id];
    const error = h('p', { class: 'error', role: 'alert' });
    const isLast = st.step === total - 1;

    const next = () => {
      const v = st.answers[q.id];
      const empty = v === undefined || v === '' || (Array.isArray(v) && !v.length);
      if (empty && !q.optional) return void (error.textContent = 'Veuillez choisir une réponse.');
      if (isLast) submit(error);
      else { st.step += 1; renderStep(); }
    };

    let input;
    if (q.type === 'single') {
      input = h('div', { class: 'options', role: 'radiogroup' }, q.options.map((o) => h('button', {
        class: `option${value === o.value ? ' selected' : ''}`, role: 'radio', 'aria-checked': String(value === o.value),
        onclick: () => { st.answers[q.id] = o.value; next(); },
      }, o.text)));
    } else if (q.type === 'multi') {
      const chosen = new Set(value || []);
      input = h('div', { class: 'options' }, q.options.map((o) => h('label', { class: `option check${chosen.has(o.value) ? ' selected' : ''}` },
        h('input', { type: 'checkbox', checked: chosen.has(o.value), onchange: (e) => {
          if (e.target.checked) chosen.add(o.value); else chosen.delete(o.value);
          e.target.parentElement.classList.toggle('selected', e.target.checked);
          st.answers[q.id] = [...chosen];
        } }), o.text)));
    } else {
      input = h('input', { class: 'amount', type: 'number', min: q.min, max: q.max, step: 1000, value: value ?? '',
        placeholder: 'Ex. 50 000', oninput: (e) => { st.answers[q.id] = e.target.value; },
        onkeydown: (e) => { if (e.key === 'Enter') next(); } });
    }

    render(
      h('div', { class: 'progress', 'aria-label': `Question ${st.step + 1} sur ${total}` },
        h('div', { style: `width:${((st.step + 1) / total) * 100}%` })),
      h('p', { class: 'muted small' }, `${q.section} · Question ${st.step + 1} / ${total}`),
      st.persona ? h('p', { class: 'note' }, `Prérempli d’après le persona ${st.persona.name} : vérifiez ou modifiez la réponse.`) : null,
      h('h2', { class: 'question' }, q.text),
      q.help ? h('p', { class: 'muted' }, q.help) : null,
      input,
      error,
      h('div', { class: 'p-nav' },
        h('button', { class: 'secondary', onclick: () => {
          if (st.step === 0) return st.profile ? renderResult() : renderIntro();
          st.step -= 1; renderStep();
        } }, '← Retour'),
        q.type !== 'single' || value !== undefined || isLast
          ? h('button', { class: 'primary', onclick: next }, isLast ? 'Voir mon profil' : 'Suivant →')
          : null),
    );
    input.querySelector?.('.selected, input')?.focus();
    if (input.tagName === 'INPUT') input.focus();
  }

  async function submit(error) {
    try {
      st.profile = await api('PUT', '/api/profile', { answers: st.answers });
      st.persona = null;
      updateBadge();
      renderResult();
    } catch (err) {
      error.textContent = err.message;
    }
  }

  // ---------------------------------------------------------------------------
  // Résultat expliqué
  // ---------------------------------------------------------------------------

  function factorList(part) {
    return h('ul', { class: 'factors' }, part.factors.map((f) => h('li', {},
      h('span', {}, f.question, h('br'), h('em', {}, f.answer)),
      h('b', {}, `${f.points}/100${f.weight > 1 ? ` ×${f.weight}` : ''}`))));
  }

  function renderResult() {
    const r = st.profile.result;
    const g = r.guardrails;
    const p = r.preferences;
    const persona = st.personas.find((x) => x.id === r.closestPersona.id);
    const fmt = (n) => new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 }).format(n);
    const chips = (items) => (items.length ? h('div', { class: 'chips' }, items.map((t) => h('span', { class: 'chip' }, t))) : h('span', { class: 'muted' }, 'Aucun'));

    render(
      h('h1', {}, 'Votre profil investisseur'),
      h('div', { class: 'p-card p-hero' },
        h('span', { class: 'muted' }, 'Niveau de risque retenu'),
        h('div', { class: `level lvl-${r.level.id}` }, r.level.label),
        h('div', { class: 'gauge' }, ['Faible', 'Faible à modéré', 'Modéré', 'Modéré à élevé', 'Élevé'].map((t) => h('span', {}, t)),
          h('i', { style: `left:${r.score}%`, title: `Score ${r.score}/100` })),
        h('p', {}, `${r.objective.label} · horizon ${r.horizon.label.toLowerCase()}`
          + (r.capital ? ` · capital fictif ${fmt(r.capital)}` : ''))),

      h('h2', {}, 'Comment ce niveau est calculé'),
      h('div', { class: 'grid3' },
        h('div', { class: 'p-card' }, h('span', { class: 'muted' }, 'Tolérance au risque'), h('div', { class: 'big' }, `${r.tolerance.score}/100`),
          h('span', { class: 'small' }, 'Ce que vous êtes prêt à supporter')),
        h('div', { class: 'p-card' }, h('span', { class: 'muted' }, 'Capacité à prendre du risque'), h('div', { class: 'big' }, `${r.capacity.score}/100`),
          h('span', { class: 'small' }, 'Ce que votre situation permet')),
        h('div', { class: 'p-card' }, h('span', { class: 'muted' }, 'Score retenu'), h('div', { class: 'big' }, `${r.score}/100`),
          h('span', { class: 'small' }, 'Le plus bas des deux, plafonné par l’objectif'))),
      h('details', {}, h('summary', {}, 'Détail des réponses prises en compte'),
        h('h3', {}, 'Tolérance'), factorList(r.tolerance), h('h3', {}, 'Capacité'), factorList(r.capacity)),

      r.tensions.length ? h('h2', {}, 'Points d’attention') : null,
      r.tensions.map((t) => h('div', { class: `tension ${t.severity}` }, h('strong', {}, t.title), h('p', {}, t.detail))),

      h('h2', {}, 'Vos préférences'),
      h('dl', { class: 'prefs' },
        h('dt', {}, 'Secteurs'), h('dd', {}, chips(p.sectors)),
        h('dt', {}, 'Entreprises'), h('dd', {}, p.style),
        h('dt', {}, 'Diversification'), h('dd', {}, p.diversification),
        h('dt', {}, 'Cryptoactifs'), h('dd', {}, p.crypto),
        h('dt', {}, 'ESG'), h('dd', {}, p.esg),
        h('dt', {}, 'Exclusions'), h('dd', {}, chips(p.exclusions))),

      h('h2', {}, 'Garde-fous transmis aux agents'),
      h('ul', { class: 'guardrails' },
        h('li', {}, `Volatilité annuelle visée : au plus ${g.maxAnnualVolatility} %`),
        h('li', {}, `Cryptoactifs : au plus ${g.maxCryptoShare} % du portefeuille simulé`),
        h('li', {}, `Un même secteur : au plus ${g.maxSingleSectorShare} %`),
        h('li', {}, `Au moins ${g.minDiversifiedAssets} actifs différents`)),

      h('h2', {}, 'Persona le plus proche'),
      h('div', { class: 'p-card' },
        h('strong', {}, `${persona.name}, ${persona.age} ans · ${persona.job}`),
        h('p', {}, persona.summary),
        h('p', { class: 'small muted' }, `Ce que ce persona teste : ${persona.tests}`),
        r.personaMatch.map((m) => h('div', { class: 'match' }, h('span', {}, m.name),
          h('div', { class: 'bar' }, h('div', { style: `width:${m.similarity}%` })), h('b', {}, `${m.similarity} %`)))),

      h('div', { class: 'p-nav' },
        h('button', { class: 'secondary', onclick: () => start(st.profile.answers, null) }, 'Modifier mes réponses'),
        h('button', { class: 'secondary', onclick: renderIntro }, 'Recommencer'),
        h('button', { class: 'primary', onclick: () => window.dispatchEvent(new Event('profile:done')) }, 'Discuter avec l’assistant →')),
      disclaimer(),
    );
  }

  function disclaimer() {
    return h('p', { class: 'disclaimer' }, 'Simulation éducative : ce profil ne constitue pas un conseil financier personnalisé '
      + 'et aucune transaction réelle n’est effectuée. Les seuils (score, garde-fous) sont des hypothèses du prototype. '
      + 'Les rendements passés ne garantissent pas les rendements futurs.');
  }

  // ---------------------------------------------------------------------------
  // API pour app.js
  // ---------------------------------------------------------------------------

  window.Profile = {
    // Charge le questionnaire et le profil de l'utilisateur. Retourne true si un profil existe.
    async init() {
      const [q, profile] = await Promise.all([api('GET', '/api/profile/questionnaire'), api('GET', '/api/profile')]);
      st.questions = q.questions;
      st.personas = q.personas;
      st.profile = profile;
      updateBadge();
      this.render();
      return Boolean(profile);
    },
    // Premier rendu ; ensuite l'écran courant est conservé quand on change d'onglet.
    render() {
      if (st.profile) renderResult(); else renderIntro();
    },
  };
})();
