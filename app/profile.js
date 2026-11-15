'use strict';
// ---------------------------------------------------------------------------
// Profil investisseur : questionnaire guidé, calcul du niveau de risque,
// rapprochement avec les personas du cas (Amira, Mateo, Robert) et détection
// des tensions entre les demandes et le profil.
//
// Méthode (inspirée des questionnaires « connaissance client ») :
//   - tolérance = ce que la personne est prête à supporter émotionnellement
//   - capacité  = ce que sa situation (âge, horizon, épargne...) lui permet
//   - niveau retenu = min(tolérance, capacité), plafonné par l'objectif
// Les seuils sont des hypothèses de simulation, pas un conseil financier.
// ---------------------------------------------------------------------------

const LEVELS = [
  { id: 'faible', label: 'Faible', min: 0, maxVol: 6, maxCrypto: 0 },
  { id: 'faible-modere', label: 'Faible à modéré', min: 20, maxVol: 9, maxCrypto: 0 },
  { id: 'modere', label: 'Modéré', min: 40, maxVol: 12, maxCrypto: 2 },
  { id: 'modere-eleve', label: 'Modéré à élevé', min: 60, maxVol: 16, maxCrypto: 5 },
  { id: 'eleve', label: 'Élevé', min: 80, maxVol: 22, maxCrypto: 10 },
];

// kind: 'tol' (tolérance) | 'cap' (capacité) | 'pref' (préférence, pas de score)
//       | 'number' (montant libre) | 'multi' (choix multiples, sans score).
// L'objectif est 'pref', mais ses points servent de plafond au niveau de risque.
// points : 0 à 100. weight : poids dans la moyenne (1 par défaut).
const QUESTIONS = [
  // --- Situation -----------------------------------------------------------
  { id: 'age', section: 'Votre situation', kind: 'cap', text: 'Quel âge avez-vous ?',
    options: [['lt30', 'Moins de 30 ans', 100], ['30-44', '30 à 44 ans', 75],
      ['45-59', '45 à 59 ans', 50], ['60p', '60 ans et plus', 25]] },
  { id: 'dependents', section: 'Votre situation', kind: 'cap',
    text: 'Combien de personnes dépendent financièrement de vous ?',
    help: 'Enfants à charge, conjoint sans revenu… Des enfants adultes autonomes ne comptent pas.',
    options: [['0', 'Aucune', 100], ['1-2', '1 ou 2', 50], ['3p', '3 ou plus', 25]] },
  { id: 'savingsShare', section: 'Votre situation', kind: 'cap',
    text: 'Quelle part de votre épargne totale ce placement représente-t-il ?',
    help: 'Plus la part est grande, moins une perte serait facile à absorber.',
    options: [['lt25', 'Moins de 25 %', 100], ['25-50', '25 à 50 %', 70],
      ['50-75', '50 à 75 %', 30], ['gt75', 'Plus de 75 %', 0]] },
  { id: 'experience', section: 'Votre situation', kind: 'cap',
    text: 'Quelle est votre expérience en placement ?',
    options: [['none', 'Aucune', 0], ['beginner', 'Débutant (quelques placements simples)', 35],
      ['intermediate', 'Intermédiaire (actions, FNB, je suis mes placements)', 70],
      ['advanced', 'Avancée (je gère activement un portefeuille)', 100]] },
  { id: 'capital', section: 'Votre situation', kind: 'number', optional: true,
    text: 'Quel montant fictif souhaitez-vous simuler ? (CAD)',
    help: 'Simulation uniquement : aucun argent réel n’est investi.', min: 0, max: 10000000 },

  // --- Objectifs -----------------------------------------------------------
  { id: 'objective', section: 'Vos objectifs', kind: 'pref', text: 'Quel est votre objectif principal ?',
    options: [['preserve', 'Préserver mon capital, avec un peu de croissance', 40],
      ['purchase', 'Financer un projet proche (achat, études…)', 20],
      ['income', 'Obtenir un revenu régulier', 60],
      ['balanced', 'Faire croître mon capital de façon équilibrée', 100],
      ['growth', 'Faire croître mon capital à long terme', 100]] },
  { id: 'horizon', section: 'Vos objectifs', kind: 'cap', weight: 2,
    text: 'Dans combien de temps pensez-vous avoir besoin de cet argent ?',
    options: [['lt3', 'Moins de 3 ans', 0], ['3-5', '3 à 5 ans', 25], ['6-8', '6 à 8 ans', 50],
      ['9-12', '9 à 12 ans', 75], ['gt12', 'Plus de 12 ans', 100]] },

  // --- Rapport au risque ---------------------------------------------------
  { id: 'drawdown', section: 'Votre rapport au risque', kind: 'tol',
    text: 'Votre portefeuille perd 20 % en quelques mois. Que faites-vous ?',
    options: [['sellAll', 'Je vends tout pour arrêter les pertes', 0],
      ['sellPart', 'Je vends une partie', 30], ['hold', 'J’attends sans rien changer', 70],
      ['buy', 'J’en profite pour investir davantage', 100]] },
  { id: 'maxLoss', section: 'Votre rapport au risque', kind: 'tol',
    text: 'Quelle baisse sur un an pourriez-vous supporter sans changer de stratégie ?',
    options: [['5', 'Environ 5 %', 0], ['10', 'Environ 10 %', 30], ['20', 'Environ 20 %', 50],
      ['35', '35 % ou plus', 100]] },
  { id: 'tradeoff', section: 'Votre rapport au risque', kind: 'tol',
    text: 'Entre stabilité et potentiel de croissance, que préférez-vous ?',
    options: [['stability', 'La stabilité avant tout', 0], ['mostlyStable', 'Surtout la stabilité', 30],
      ['balance', 'Un équilibre entre les deux', 50], ['mostlyGrowth', 'Surtout la croissance', 80],
      ['growth', 'La croissance maximale, même avec de fortes variations', 100]] },
  { id: 'hype', section: 'Votre rapport au risque', kind: 'pref',
    text: 'Vous arrive-t-il d’être tenté par une entreprise très médiatisée, même plus risquée que d’habitude ?',
    options: [['never', 'Rarement ou jamais'], ['sometimes', 'Parfois'], ['often', 'Souvent']] },

  // --- Préférences ---------------------------------------------------------
  { id: 'sectors', section: 'Vos préférences', kind: 'multi', optional: true, avoidable: 'avoidSectors',
    text: 'Quels secteurs vous intéressent particulièrement ?',
    help: 'Un clic : secteur qui vous intéresse. Deux clics : secteur à éviter. Laissez vide si vous n’avez pas de préférence.',
    options: [['tech', 'Intelligence artificielle et technologies'], ['health', 'Santé'],
      ['energy', 'Énergie'], ['finance', 'Banques et assurances'], ['consumer', 'Consommation'],
      ['industry', 'Industrie et transport'], ['realEstate', 'Immobilier'],
      ['gold', 'Or et matières premières']] },
  { id: 'regions', section: 'Vos préférences', kind: 'multi', optional: true,
    text: 'Dans quelles régions souhaitez-vous investir ?',
    help: 'Plusieurs choix possibles. Laissez vide si vous n’avez pas de préférence.',
    options: [['canada', 'Canada'], ['usa', 'États-Unis'], ['europe', 'Europe'],
      ['asiaPacific', 'Asie-Pacifique développée (Japon, Australie…)'], ['emerging', 'Marchés émergents (Chine, Inde, Brésil…)']] },
  { id: 'style', section: 'Vos préférences', kind: 'pref', text: 'Quel type d’entreprises préférez-vous ?',
    options: [['established', 'Des entreprises établies dont je comprends le modèle'],
      ['mix', 'Un mélange des deux'], ['growth', 'Des entreprises en forte croissance et innovantes']] },
  { id: 'diversification', section: 'Vos préférences', kind: 'pref',
    text: 'Comment voyez-vous la diversification ?',
    options: [['broad', 'Bien répartir entre plusieurs classes d’actifs'],
      ['convictions', 'Diversifier, avec quelques convictions fortes'],
      ['concentrated', 'Concentrer sur quelques idées']] },
  { id: 'crypto', section: 'Vos préférences', kind: 'pref',
    text: 'Quel est votre intérêt pour les cryptoactifs (Bitcoin, Ether) ?',
    options: [['none', 'Aucun intérêt'], ['small', 'Curieux, pour une petite part'],
      ['strong', 'Fort intérêt']] },
  { id: 'esg', section: 'Vos préférences', kind: 'pref',
    text: 'Quelle importance accordez-vous aux critères environnementaux, sociaux et de gouvernance (ESG) ?',
    options: [['low', 'Peu importants'], ['medium', 'Un critère parmi d’autres'], ['high', 'Très importants']] },
  { id: 'exclusions', section: 'Vos préférences', kind: 'multi', optional: true,
    text: 'Y a-t-il des activités que vous voulez exclure ?',
    options: [['fossil', 'Combustibles fossiles'], ['weapons', 'Armement'], ['tobacco', 'Tabac'],
      ['controversies', 'Entreprises impliquées dans de graves controverses environnementales ou sociales']] },
];

// Personas officiels du cas Datathon 2026 (fictifs). `answers` permet de
// préremplir le questionnaire pour la démo ; l'utilisateur peut tout modifier.
const PERSONAS = [
  { id: 'amira', name: 'Amira', age: 26, job: 'Ingénieure logiciel', risk: 'Élevé', horizon: '15 ans et plus',
    summary: 'Croissance à long terme, passionnée d’IA, ouverte à la volatilité et aux cryptos, mais veut rester diversifiée.',
    tests: 'Un profil agressif ne veut pas dire « tout est permis » : la diversification reste respectée.',
    answers: { age: 'lt30', dependents: '0', savingsShare: '25-50', experience: 'intermediate', capital: 25000,
      objective: 'growth', horizon: 'gt12', drawdown: 'buy', maxLoss: '35', tradeoff: 'mostlyGrowth',
      hype: 'sometimes', sectors: ['tech', 'health', 'finance'], regions: ['usa', 'canada', 'asiaPacific', 'emerging'], style: 'growth', diversification: 'convictions',
      crypto: 'strong', esg: 'medium', exclusions: [] } },
  { id: 'mateo', name: 'Mateo', age: 41, job: 'Gestionnaire des opérations', risk: 'Modéré', horizon: '8 à 12 ans',
    summary: 'Croissance équilibrée, forte importance de l’ESG, évite les controverses et la spéculation.',
    tests: 'Le système doit intégrer les préférences personnelles, pas seulement le rendement et le risque.',
    answers: { age: '30-44', dependents: '1-2', savingsShare: '25-50', experience: 'intermediate', capital: 60000,
      objective: 'balanced', horizon: '9-12', drawdown: 'hold', maxLoss: '20', tradeoff: 'balance',
      hype: 'never', sectors: ['tech', 'health', 'consumer'], regions: ['canada', 'usa', 'europe'], style: 'mix', diversification: 'broad',
      crypto: 'none', esg: 'high', exclusions: ['fossil', 'weapons', 'controversies'] } },
  { id: 'robert', name: 'Robert', age: 59, job: 'Professionnel de la santé', risk: 'Faible à modéré', horizon: '3 à 5 ans',
    summary: 'Proche de la retraite : préserver le capital, entreprises établies, mais parfois tenté par un titre médiatisé.',
    tests: 'Le système doit relever les demandes en conflit avec le profil plutôt que simplement acquiescer.',
    answers: { age: '45-59', dependents: '0', savingsShare: '50-75', experience: 'advanced', capital: 400000,
      objective: 'preserve', horizon: '3-5', drawdown: 'sellPart', maxLoss: '10', tradeoff: 'mostlyStable',
      hype: 'often', sectors: ['health', 'finance', 'consumer'], regions: ['canada', 'usa'], style: 'established', diversification: 'broad',
      crypto: 'none', esg: 'medium', exclusions: [] } },
];

const byId = Object.fromEntries(QUESTIONS.map((q) => [q.id, q]));
const option = (qid, value) => byId[qid].options.find((o) => o[0] === value);
const label = (qid, value) => option(qid, value)?.[1] ?? value;
const levelFor = (score) => [...LEVELS].reverse().find((l) => score >= l.min);

class ProfileError extends Error {}

// Vérifie et normalise les réponses. Lance ProfileError si invalide.
function validate(raw) {
  if (!raw || typeof raw !== 'object') throw new ProfileError('Réponses manquantes');
  const answers = {};
  for (const q of QUESTIONS) {
    const v = raw[q.id];
    const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
    if (empty) {
      if (!q.optional) throw new ProfileError(`Réponse manquante : « ${q.text} »`);
      if (q.kind === 'multi') answers[q.id] = [];
      continue;
    }
    if (q.kind === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n) || n < q.min || n > q.max) throw new ProfileError(`Montant invalide (${q.min} à ${q.max})`);
      answers[q.id] = Math.round(n);
    } else if (q.kind === 'multi') {
      if (!Array.isArray(v) || v.some((x) => !option(q.id, x))) throw new ProfileError(`Choix invalide : « ${q.text} »`);
      answers[q.id] = [...new Set(v)];
    } else {
      if (!option(q.id, v)) throw new ProfileError(`Choix invalide : « ${q.text} »`);
      answers[q.id] = v;
    }
  }
  // Second state of a multi question (e.g. sectors to avoid): same options,
  // never both wanted and avoided.
  for (const q of QUESTIONS.filter((x) => x.avoidable)) {
    const v = raw[q.avoidable] ?? [];
    if (!Array.isArray(v) || v.some((x) => !option(q.id, x))) throw new ProfileError(`Choix invalide : « ${q.text} »`);
    answers[q.avoidable] = [...new Set(v)].filter((x) => !answers[q.id].includes(x));
  }
  return answers;
}

function weightedScore(answers, kind) {
  let sum = 0;
  let weights = 0;
  const factors = [];
  for (const q of QUESTIONS.filter((x) => x.kind === kind)) {
    const [, text, points] = option(q.id, answers[q.id]);
    const w = q.weight || 1;
    sum += points * w;
    weights += w;
    factors.push({ question: q.text, answer: text, points, weight: w });
  }
  return { score: Math.round(sum / weights), factors };
}

// Distance simple entre le profil et chaque persona, sur 5 dimensions normalisées.
function personaMatch(score, answers) {
  const idx = (qid, v) => byId[qid].options.findIndex((o) => o[0] === v) / (byId[qid].options.length - 1);
  const vec = (s, a) => [s / 100, idx('horizon', a.horizon), idx('esg', a.esg), idx('crypto', a.crypto), idx('style', a.style)];
  const me = vec(score, answers);
  return PERSONAS.map((p) => {
    const ref = vec(computeScores(p.answers).score, p.answers);
    const dist = Math.sqrt(me.reduce((acc, x, i) => acc + (x - ref[i]) ** 2, 0) / me.length);
    return { id: p.id, name: p.name, similarity: Math.round((1 - dist) * 100) };
  }).sort((a, b) => b.similarity - a.similarity);
}

function computeScores(answers) {
  const tolerance = weightedScore(answers, 'tol');
  const capacity = weightedScore(answers, 'cap');
  const objectiveCap = option('objective', answers.objective)[2];
  const score = Math.min(tolerance.score, capacity.score, objectiveCap);
  return { score, tolerance, capacity, objectiveCap };
}

// Tensions entre les réponses : c'est la partie « gouvernance » du profil.
// severity : 'warning' (conflit à expliquer) | 'info' (point d'attention).
function findTensions(a, s) {
  const out = [];
  const add = (severity, title, detail) => out.push({ severity, title, detail });
  const level = levelFor(s.score);

  if (s.tolerance.score - s.capacity.score >= 20) {
    add('warning', 'Votre tolérance dépasse votre capacité à prendre du risque',
      `Vous êtes prêt à supporter des variations importantes (tolérance ${s.tolerance.score}/100), mais votre situation `
      + `(horizon, âge, part de l’épargne) limite le risque raisonnable (capacité ${s.capacity.score}/100). Le niveau retenu suit la capacité.`);
  } else if (s.capacity.score - s.tolerance.score >= 20) {
    add('info', 'Votre situation permettrait davantage de risque',
      `Votre capacité (${s.capacity.score}/100) est supérieure à votre tolérance (${s.tolerance.score}/100). `
      + 'Nous respectons votre niveau de confort : un profil qui vous ferait vendre en pleine baisse serait contre-productif.');
  }
  if (s.objectiveCap < Math.min(s.tolerance.score, s.capacity.score)) {
    add('info', 'Niveau plafonné par votre objectif',
      `L’objectif « ${label('objective', a.objective)} » limite le niveau de risque à ${levelFor(s.objectiveCap).label.toLowerCase()}.`);
  }
  if (a.horizon === 'lt3' && ['growth', 'balanced'].includes(a.objective)) {
    add('warning', 'Horizon court pour un objectif de croissance',
      'Sur moins de 3 ans, une baisse de marché a peu de temps pour se résorber. La croissance visée est difficilement compatible avec cet horizon.');
  }
  if (a.crypto !== 'none' && level.maxCrypto === 0) {
    add('warning', 'Intérêt pour les cryptoactifs incompatible avec votre niveau de risque',
      `Les cryptoactifs ont connu des baisses de plus de 60 % sur la période 2021-2022. Avec un profil ${level.label.toLowerCase()}, `
      + 'ils sont exclus de la simulation. Vous pourrez quand même les étudier à titre informatif.');
  } else if (a.crypto === 'strong') {
    add('info', 'Cryptoactifs : une part limitée',
      `Même avec un intérêt fort, la part des cryptoactifs est plafonnée à ${level.maxCrypto} % dans la simulation pour préserver la diversification.`);
  }
  if (a.hype !== 'never' && s.score < 60) {
    add('warning', 'Attention aux titres très médiatisés',
      'Vous indiquez être parfois tenté par des entreprises très médiatisées. Avec votre profil, l’assistant signalera '
      + 'systématiquement quand une demande dépasse votre niveau de risque, plutôt que de simplement l’accepter.');
  }
  if (a.style === 'growth' && s.score < 40) {
    add('warning', 'Préférence pour la croissance avec un profil prudent',
      'Les entreprises en forte croissance sont souvent plus volatiles. Elles occuperont une place limitée dans les analyses.');
  }
  if (a.diversification === 'concentrated') {
    add('warning', 'Portefeuille concentré',
      'Concentrer sur quelques idées augmente fortement le risque spécifique. L’assistant gardera une diversification minimale, quel que soit le niveau de risque.');
  }
  if (a.sectors.length === 1 && s.score >= 60) {
    add('info', `Intérêt pour un seul secteur : ${label('sectors', a.sectors[0])}`,
      'Un profil élevé ne signifie pas « tout dans un secteur » : ce secteur sera mis en avant sans dépasser une part raisonnable.');
  }
  if (a.regions.length === 1) {
    add('info', `Une seule région : ${label('regions', a.regions[0])}`,
      'Investir dans une seule région concentre le risque économique et monétaire. Les analyses privilégieront cette région '
      + 'tout en signalant l’intérêt d’une exposition internationale.');
  }
  if (a.experience === 'none' && s.tolerance.score >= 60) {
    add('info', 'Peu d’expérience pour un profil audacieux',
      'Les explications de l’assistant seront plus détaillées sur la volatilité et les pertes possibles.');
  }
  if (a.esg === 'high' && !a.exclusions.length) {
    add('info', 'ESG important, sans exclusion choisie',
      'Vous pouvez préciser les activités à exclure pour que les analyses respectent vos valeurs.');
  }
  if (a.exclusions.includes('fossil') && a.sectors.includes('energy')) {
    add('info', 'Énergie et exclusion des fossiles',
      'Vous vous intéressez à l’énergie tout en excluant les combustibles fossiles : seules les énergies renouvelables seront considérées.');
  }
  return out;
}

// Construit le profil complet à partir de réponses validées.
function buildProfile(answers) {
  const s = computeScores(answers);
  const level = levelFor(s.score);
  const match = personaMatch(s.score, answers);
  return {
    score: s.score,
    level: { id: level.id, label: level.label },
    tolerance: s.tolerance,
    capacity: s.capacity,
    objective: { id: answers.objective, label: label('objective', answers.objective) },
    horizon: { id: answers.horizon, label: label('horizon', answers.horizon) },
    preferences: {
      sectors: answers.sectors.map((v) => label('sectors', v)),
      avoidSectors: (answers.avoidSectors || []).map((v) => label('sectors', v)),
      regions: answers.regions.map((v) => label('regions', v)),
      style: label('style', answers.style),
      diversification: label('diversification', answers.diversification),
      crypto: label('crypto', answers.crypto),
      esg: label('esg', answers.esg),
      exclusions: answers.exclusions.map((v) => label('exclusions', v)),
    },
    capital: answers.capital ?? null,
    // Contraintes transmises aux agents (hypothèses de simulation).
    guardrails: {
      maxAnnualVolatility: level.maxVol,
      maxCryptoShare: answers.crypto === 'none' ? 0 : level.maxCrypto,
      maxSingleSectorShare: s.score >= 60 ? 35 : 25,
      minDiversifiedAssets: 5,
      excludedActivities: answers.exclusions,
      avoidedSectors: answers.avoidSectors || [],
      regions: answers.regions,
    },
    tensions: findTensions(answers, s),
    closestPersona: match[0],
    personaMatch: match,
  };
}

// Résumé texte du profil, à donner aux agents dans leur contexte.
function profileSummary(p) {
  if (!p) return 'Profil investisseur non renseigné.';
  const g = p.guardrails;
  return [
    `Niveau de risque : ${p.level.label} (score ${p.score}/100, tolérance ${p.tolerance.score}, capacité ${p.capacity.score}).`,
    `Objectif : ${p.objective.label}. Horizon : ${p.horizon.label}.`,
    `Secteurs d’intérêt : ${p.preferences.sectors.join(', ') || 'aucune préférence'}. Style : ${p.preferences.style}.`,
    `Secteurs à éviter : ${p.preferences.avoidSectors?.join(', ') || 'aucun'}.`,
    `Régions visées : ${p.preferences.regions?.join(', ') || 'aucune préférence'}.`,
    `Diversification : ${p.preferences.diversification}. Cryptoactifs : ${p.preferences.crypto}. ESG : ${p.preferences.esg}.`,
    `Exclusions : ${p.preferences.exclusions.join(', ') || 'aucune'}.`,
    `Garde-fous : volatilité annuelle ≤ ${g.maxAnnualVolatility} %, cryptoactifs ≤ ${g.maxCryptoShare} %, `
      + `un secteur ≤ ${g.maxSingleSectorShare} %, au moins ${g.minDiversifiedAssets} actifs.`,
    `Persona le plus proche : ${p.closestPersona.name} (${p.closestPersona.similarity} %).`,
    ...p.tensions.filter((t) => t.severity === 'warning').map((t) => `Tension : ${t.title}.`),
  ].join('\n');
}

// Version publique du questionnaire (pour l'interface).
function publicQuestionnaire() {
  return {
    questions: QUESTIONS.map(({ id, section, kind, text, help, optional, min, max, options, avoidable }) => ({
      id, section, type: ['multi', 'number'].includes(kind) ? kind : 'single', text, help, optional, min, max, avoidable,
      options: options?.map(([value, text]) => ({ value, text })),
    })),
    personas: PERSONAS,
  };
}

module.exports = { validate, buildProfile, profileSummary, publicQuestionnaire, ProfileError, PERSONAS, LEVELS };
