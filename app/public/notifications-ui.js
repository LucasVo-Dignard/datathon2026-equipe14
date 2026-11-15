'use strict';
// Carte « Alertes de prix par courriel » de la page profil (voir app/notifications.js).
// Exposé à profile-ui.js via window.Notifications.card().

(() => {
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

  // Retourne la carte tout de suite ; son contenu se remplit quand l'état arrive.
  function card() {
    const root = h('div', { class: 'p-card notif' }, h('p', { class: 'muted' }, 'Chargement…'));
    const msg = h('p', { class: 'notif-msg', role: 'status' });

    const run = async (button, fn, okText) => {
      button.disabled = true;
      msg.className = 'notif-msg';
      msg.textContent = '';
      try {
        const state = await fn();
        if (state) render(state);
        if (okText) { msg.textContent = okText; msg.classList.add('ok'); }
      } catch (err) {
        msg.textContent = err.message;
        msg.classList.add('error');
      } finally {
        button.disabled = false;
      }
    };

    function render(s) {
      const intro = h('p', {}, `Recevez un courriel quand un titre de votre portefeuille varie de `,
        h('strong', {}, `${s.thresholdPct} % ou plus`), ' en une journée de bourse. ',
        'Le seuil suit votre niveau de risque : plus le profil est prudent, plus l’alerte arrive tôt.');

      if (!s.enabled) {
        root.replaceChildren(intro, h('p', { class: 'muted small' },
          'Les alertes ne sont pas disponibles dans cet environnement (base de données ou SES non configurés).'));
        return;
      }

      if (s.status === 'none') {
        const input = h('input', { type: 'email', class: 'amount', placeholder: 'vous@exemple.com', autocomplete: 'email', maxlength: 254 });
        const btn = h('button', { class: 'primary' }, 'M’abonner');
        const subscribe = () => run(btn, () => api('PUT', '/api/notifications', { email: input.value }), null);
        btn.onclick = subscribe;
        input.onkeydown = (e) => { if (e.key === 'Enter') subscribe(); };
        root.replaceChildren(intro, h('div', { class: 'notif-form' }, input, btn), msg,
          h('p', { class: 'muted small' }, 'Envoi par Amazon SES. Chaque courriel contient un lien pour vous désabonner en un clic.'));
        return;
      }

      const unsub = h('button', { class: 'secondary' }, 'Me désabonner');
      unsub.onclick = () => run(unsub, () => api('DELETE', '/api/notifications'), 'Abonnement supprimé.');

      if (s.status === 'pending') {
        // Bac à sable SES : l'adresse doit être vérifiée une fois.
        const check = h('button', { class: 'primary' }, 'J’ai cliqué sur le lien');
        check.onclick = () => run(check, async () => {
          const st = await api('GET', '/api/notifications');
          if (st.status === 'pending') {
            throw new Error('Adresse pas encore vérifiée : cliquez sur le lien du courriel « Amazon Web Services – Email Address Verification Request » (vérifiez les indésirables).');
          }
          return st;
        }, 'Adresse vérifiée : les alertes sont actives.');
        root.replaceChildren(intro,
          h('p', { class: 'notif-status pending' }, `Vérification de ${s.email} en attente. Pendant la phase de test, `
            + 'AWS doit vérifier l’adresse une seule fois : cliquez sur le lien du courriel « Email Address Verification Request » '
            + 'envoyé par Amazon Web Services.'),
          h('div', { class: 'notif-form' }, check, unsub), msg);
        return;
      }

      const test = h('button', { class: 'primary' }, 'Envoyer une notification test');
      test.onclick = () => run(test, async () => { await api('POST', '/api/notifications/test'); return null; },
        `Notification test envoyée à ${s.email}. Elle arrive en général en moins d’une minute.`);
      root.replaceChildren(intro,
        h('p', { class: 'notif-status ok' }, `Alertes actives pour ${s.email}.`),
        h('p', { class: 'small' }, `Titres suivis : ${s.symbols.join(', ') || 'aucun'}. `
          + 'Vérification chaque soir de semaine, après la mise à jour des cours.'),
        h('div', { class: 'notif-form' }, test, unsub), msg);
    }

    api('GET', '/api/notifications').then(render, (err) => {
      root.replaceChildren(h('p', { class: 'error' }, `Alertes : ${err.message}`));
    });
    return root;
  }

  window.Notifications = { card };
})();
