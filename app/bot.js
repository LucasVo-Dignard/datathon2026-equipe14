'use strict';
// ---------------------------------------------------------------------------
// Agent : Claude via Amazon Bedrock, qui met en forme les réponses (Markdown).
//
// Quand une question porte sur une entreprise (résultats, chiffres, actualités),
// Claude appelle l'outil research_company : il déclenche l'agent de recherche
// AgentCore (voir research.js), qui cherche d'abord dans la base de
// connaissances des rapports de résultats, puis sur le web si l'entreprise n'y
// est pas. Claude reçoit son rapport et rédige la réponse pour l'utilisateur.
//
// reply() reçoit :
//   - messages : l'historique complet [{ role: 'user' | 'assistant', content }],
//                le dernier élément est le message que l'utilisateur vient d'envoyer
//   - username : l'utilisateur connecté
//   - chatId   : l'identifiant de la conversation
//   - profile  : le profil investisseur calculé (voir profile.js, buildProfile),
//                ou null si l'utilisateur n'a pas rempli le questionnaire.
//                Son résumé (profileSummary) est ajouté au prompt système ;
//                profile.guardrails et profile.tensions servent aux contrôles.
//   - portfolio: le portefeuille du client (voir portfolio.js : summary, holdings, history),
//                ou null s'il n'a pas encore choisi comment le créer. Enrichi avec
//                la base (secteur, industrie, pays) par portfolio-context.js : un
//                résumé est ajouté au prompt système, le détail est donné par
//                l'outil get_portfolio_details.
// et retourne le texte de la réponse, en Markdown.
//
// report() rédige un rapport (quotidien, hebdomadaire, mensuel ou annuel), en
// Markdown, à partir de la fiche de données préparée par reports.js.
//
// Identifiants AWS : en local, ceux de .env-aws (chargés par `npm run dev`) ;
// sur l'EC2, le rôle IAM de l'instance (bedrock-mantle:CreateInference, et
// bedrock-agentcore:InvokeHarness pour la recherche).
// ---------------------------------------------------------------------------

const { AnthropicBedrockMantle } = require('@anthropic-ai/bedrock-sdk');
const { betaRefusalFallbackMiddleware, BetaFallbackState } = require('@anthropic-ai/sdk');
const { profileSummary } = require('./profile');
const research = require('./research');
const peers = require('./peers');
const portfolioContext = require('./portfolio-context');

const MODEL = process.env.AGENT_MODEL || 'anthropic.claude-opus-5-5';
// Claude Opus 5.5 defaults to medium; low keeps chat replies fast.
const EFFORT = process.env.AGENT_EFFORT || 'low';
// Only the most recent messages are sent, to bound cost on long chats.
const MAX_HISTORY = 40;
// Model turns per reply: research calls plus the final answer.
const MAX_STEPS = 4;

const SYSTEM = `Tu es l'assistant de « Mon portefeuille », une application qui aide un client à suivre ses placements en actions.
Réponds dans la langue de l'utilisateur (le français par défaut), de façon claire et concise.
Tu connais le profil investisseur du client (ci-dessous) : adapte tes explications à son niveau de risque, son horizon et ses préférences, et signale quand une idée va contre ses garde-fous.
Tu ne donnes pas de conseil financier personnalisé : tu expliques les notions, les options et les risques pour que le client décide lui-même.

Recherche : quand la question porte sur une entreprise précise (résultats trimestriels, chiffres, actualités récentes, perspectives), appelle l'outil research_company avant de répondre, une fois par entreprise. Ne l'appelle pas pour une question générale (une notion, une définition) ni quand la conversation contient déjà l'information. Base les chiffres de ta réponse sur le rapport de recherche, sans en inventer ; si le rapport ne trouve pas une information, dis-le. Si l'outil n'est pas disponible ou échoue, dis que tu n'as pas pu vérifier les données récentes et réponds avec ce que tu sais de façon générale.
Contexte sectoriel : quand la question porte aussi sur le secteur de l'entreprise (performance du secteur, risques du secteur, comparaison avec le marché, taux, contexte économique), mets needs_market_context à true ; présente alors l'entreprise, puis son secteur et le marché.

Portefeuille du client : son résumé (positions, poids, secteurs, garde-fous) figure ci-dessous et il est à jour.
- Utilise-le dès que la question touche à ce que le client détient (« mon portefeuille », « mes actions », diversification, exposition, performance). Pour l'industrie, le pays, la devise ou le gain de chaque position, ou le détail des garde-fous, appelle get_portfolio_details.
- Signale de toi-même un garde-fou dépassé quand c'est pertinent (par exemple un secteur au-dessus de sa limite), avec les chiffres.
- Pour une proposition d'achat, de vente ou de remplacement, indique l'effet sur le portefeuille (poids des positions et du secteur concerné, nombre de positions).
- Pour des entreprises similaires, précise celles que le client détient déjà.
- Les valeurs du portefeuille sont en CAD ; l'historique de performance est fictif (prototype) : ne le présente pas comme réel. Ne cite pas de bouton de source pour les données du portefeuille.

Entreprises similaires : quand le client demande des entreprises similaires, des alternatives, des concurrents ou des comparables à une entreprise (même secteur, même industrie, même pays…) :
1. appelle d'abord find_similar_companies (filtre de pays si le client le précise) ; ne propose que des entreprises qu'il renvoie, jamais de mémoire ;
2. choisis 2 ou 3 candidates au plus parmi les plus proches (même industrie d'abord, puis même pays si c'est pertinent) ;
3. appelle research_company pour ces candidates dans le même tour (en parallèle), avec le champ ticker de la base, une question courte et request_type « factual » ;
4. présente chaque entreprise en une ou deux lignes : pourquoi elle est comparable (industrie, pays, taille) et ses derniers chiffres clés avec leurs sources. Précise que la liste vient de la base de données de l'application ; les capitalisations sont dans la devise de cotation (ne compare pas des montants en devises différentes).

Type de demande (champ request_type de l'outil) :
- « factual » : le client veut une information objective et vérifiable (résultats trimestriels, chiffre d'affaires, dividende, actualités, prévisions de l'entreprise).
- « judgment » : le client demande un avis ou une évaluation sur une proposition ou une décision (acheter, vendre, remplacer un titre par un autre, est-ce une bonne idée, est-ce trop risqué, quel choix entre deux options). Dans ce cas, fais les recherches de toutes les entreprises concernées dans le même tour (appels en parallèle) et renseigne proposal.
En cas de doute, utilise « factual ».

Revue critique : pour une demande « judgment », un agent relecteur évalue le choix des données trouvées (qualité et fraîcheur des sources, équilibre des arguments pour et contre, données manquantes) et ajoute sa revue, avec son verdict, après le dernier rapport. Tiens-en compte :
- ne présente pas comme solide une conclusion que la revue juge fragile ; signale les données manquantes ;
- ajoute une courte section « Points de vigilance » qui reprend les principales remarques et contre-arguments de la revue, avec leurs boutons de source (sources R1, R2… de la revue) ;
- indique en une phrase la fiabilité des données selon la revue : solide (SOLID), partielle (PARTIAL) ou faible (WEAK).
Pour une demande « factual », il n'y a pas de revue : n'ajoute pas cette section.

Mise en forme : l'interface affiche du Markdown. Utilise-le avec mesure pour rendre la réponse facile à lire :
- un titre court (###) seulement pour une réponse détaillée ;
- des listes à puces pour les chiffres clés, avec la période et les montants en **gras** ;
- un tableau simple si tu compares plusieurs valeurs (les boutons de source peuvent aller dans une colonne « Source ») ;
- les longues listes de sources en fin de réponse sont inutiles : cite chaque source directement à côté de l'information.

Citations : quand une information vient du rapport de recherche, cite sa source juste après elle, dans la même phrase ou la même puce, avec le format exact [@Nom court](url), par exemple « Le chiffre d'affaires atteint **114,5 G$** [@SEC](https://www.sec.gov/...) ». L'interface l'affiche sous forme de petit bouton cliquable avec le logo du site.
- Le rapport numérote ses sources (S1, S2…) et indique pour chaque fait de quelle source il vient : reprends exactement ces correspondances et les URL de la liste « Sources » du rapport, sans en inventer. Fais de même avec les sources R1, R2… de la revue critique.
- Nom court : l'éditeur en un à trois mots (SEC, Apple, RBC, Reuters, Bigdata.com, Yahoo Finance…).
- Une information appuyée par deux sources reçoit deux boutons côte à côte. Si une source n'a pas d'URL, écris [@Nom court](#).
- N'ajoute pas de bouton aux phrases qui ne viennent pas du rapport (tes explications générales).
- Termine, sur une ligne à part et en italique, en indiquant d'où viennent les données : communiqué officiel ou recherche déjà enregistrée (base de connaissances), Bigdata.com ou web.`;

const REPORT_SYSTEM = `Tu es l'assistant de « Mon portefeuille », une application qui aide des clients de Banque Nationale Courtage Direct, souvent pressés ou peu experts, à suivre leurs placements.
Tu rédiges en français un rapport périodique sur le portefeuille du client, à partir uniquement de la fiche de données fournie (performance, positions, expositions sectorielle, régionale et par devise, actualités, profil investisseur). N'invente aucun chiffre ni aucune nouvelle ; si une donnée manque, dis-le.

Chiffres : exprime tout en pourcentages et en dates, jamais en montants. N'écris aucune valeur en dollars ni dans aucune autre devise, aucun cours et aucune quantité d'actions. Les dates s'écrivent en toutes lettres, sans l'année si elle est évidente (par exemple « 14 novembre »).

Horizon : un rapport hebdomadaire, mensuel ou annuel porte sur toute la période. N'y parle jamais de la dernière séance, de la variation d'un jour ni de ce qui s'est passé « aujourd'hui » : explique l'évolution sur la période (rendement, plus haut et plus bas, titres qui ont le plus monté ou baissé sur la période et leur contribution). Seul le rapport quotidien parle de la dernière séance.

Mise en forme : l'interface affiche du Markdown, et les chiffres clés (rendement de la période, meilleur et plus faible titre, région principale) sont déjà affichés en tuiles au-dessus du rapport. Sois concis et visuel :
- Pas de titre général au début (le titre du rapport est déjà affiché) : commence directement par la première section.
- Une section par thème, avec un titre de niveau 2 (## Titre), dans cet ordre : ## En bref, ## Performance, ## Titres à surveiller, ## Exposition régionale, ## Exposition sectorielle, ## Respect de vos préférences, ## Actualités, ## Cohérence avec votre profil, ## Points d'attention. Omets une section sans contenu.
- En bref : trois puces au plus, chacune commence par le chiffre ou le fait clé en **gras**, une phrase chacune.
- Performance : un tableau à deux colonnes (Indicateur | Valeur) avec le rendement de la période, le plus haut et le plus bas (avec leur date) et l'écart avec le plus haut, puis une phrase qui résume l'allure de la période.
- Titres à surveiller : un tableau (Titre | Variation sur la période | Poids | Contribution) avec les trois plus fortes hausses et les trois plus fortes baisses, puis au plus trois puces de commentaire.
- Expositions : un tableau par répartition (Région | Poids, puis Devise | Poids ; Secteur | Poids), suivi d'au plus trois puces d'analyse.
- Actualités : une puce par nouvelle, la date en **gras** au début, une phrase.
- Points d'attention : une liste numérotée de trois ou quatre questions à se poser.
- Pas de paragraphe de plus de deux phrases, aucune répétition d'un même chiffre d'une section à l'autre, les pourcentages clés en **gras**.
- Longueur : quotidien très court (En bref, Titres à surveiller, Points d'attention suffisent), annuel plus complet avec un bilan de l'année.

Exposition régionale : décris la répartition par pays et région de l'émetteur, et par devise ; signale une forte concentration dans un seul pays ou une seule devise, ainsi que le biais domestique (part du Canada) ou son absence, et rappelle simplement ce que cela implique (risque de change, dépendance à une économie). Compare-la aux régions visées dans le profil (« Régions visées ») : signale une région visée absente du portefeuille, ou une forte exposition à une région non visée.
Compare la composition du portefeuille aux garde-fous du profil (concentration sectorielle, diversification, liquidités) et signale les écarts.

FNB : un FNB est un panier de titres. L'exposition sectorielle de la fiche décompose déjà les FNB selon leur composition publiée : un FNB peut donc exposer le client à un secteur qu'il ne détient pas directement. Pour chaque FNB, tu peux citer ses principaux secteurs et titres (section « COMPOSITION DES FNB »). Leur répartition géographique n'est pas publiée : dis-le plutôt que de la deviner.
Respect de vos préférences : la section « CONFLITS AVEC LES PRÉFÉRENCES DU PROFIL » liste les titres et FNB fortement exposés à un secteur que le client veut éviter ou à une activité qu'il exclut. S'il y en a, consacre-leur la section ## Respect de vos préférences avec un tableau (Titre | Motif | Part du FNB | Part du portefeuille), explique en une phrase pourquoi un FNB peut contenir ce secteur sans que le client l'ait choisi, et mentionne-les aussi dans En bref. N'en invente aucun ; s'il n'y en a pas et que le profil a des préférences, dis en une phrase que le portefeuille les respecte.
Tu ne donnes pas de conseil financier personnalisé ni de recommandation d'achat ou de vente : tu expliques, tu signales et tu proposes des questions à se poser.
Termine par une ligne en italique rappelant que le rapport est simulé à titre informatif et ne constitue pas un conseil financier.`;

const RESEARCH_TOOL = {
  name: 'research_company',
  description:
    'Research a public company with the AgentCore research agent. It first searches the earnings releases ' +
    'knowledge base (official quarterly results and earlier research), then Bigdata.com (premium financial data), ' +
    'then the web when the previous sources have nothing. ' +
    'Returns a factual report with sources. Takes 20 to 60 seconds: call it once per company. ' +
    'For a judgment request, call it for every company involved in the same turn (parallel calls): the reports ' +
    'are then peer-reviewed by a reviewer agent and the review is appended to the last result.',
  input_schema: {
    type: 'object',
    properties: {
      company: { type: 'string', description: 'Company name, e.g. "Microsoft".' },
      ticker: { type: 'string', description: 'Primary stock ticker in uppercase if known, e.g. "MSFT", "RY", "ENB".' },
      question: { type: 'string', description: 'What to find out, in English, e.g. "key results of the latest quarter".' },
      request_type: {
        type: 'string',
        enum: ['factual', 'judgment'],
        description:
          '"factual": the user wants objective, verifiable information (earnings, revenue, dividend, latest news, ' +
          'guidance). "judgment": the user asks for an opinion or an assessment of a proposal or decision ' +
          '(should I buy/sell/switch, is it a good idea, is it too risky, compare two options to choose). ' +
          'When in doubt, use "factual".',
      },
      proposal: {
        type: 'string',
        description: 'For "judgment" only: the user\'s proposal or question, restated in one sentence in English.',
      },
      needs_market_context: {
        type: 'boolean',
        description:
          'true when the answer needs sector, market or economic context: how the company\'s sector or industry is ' +
          'doing, sector risks, comparison with the market, interest rates, macro environment. Adds a daily snapshot ' +
          'of US sector performance, indexes, commodities, currencies and yields to the research. Always added for ' +
          '"judgment" requests.',
      },
    },
    required: ['company', 'question', 'request_type'],
    additionalProperties: false,
  },
};

const SIMILAR_TOOL = {
  name: 'find_similar_companies',
  description:
    'Find companies similar to a reference company in the app\'s market database (about 1,000 listed companies ' +
    'with their sector, industry, country and market cap). Candidates share the reference\'s industry first, then ' +
    'its sector; same country ranks higher, then the closest market cap. Fast (under a second), no research. ' +
    'Call it FIRST whenever the user asks for similar companies, alternatives, competitors or peers, before any ' +
    'research_company call, and only propose companies it returns.',
  input_schema: {
    type: 'object',
    properties: {
      company: { type: 'string', description: 'Reference company name in English, e.g. "Canadian National Railway".' },
      ticker: { type: 'string', description: 'Reference ticker if known, e.g. "CNR", "SHOP".' },
      same_country_only: { type: 'boolean', description: 'Only companies from the reference\'s country (e.g. the user wants Canadian alternatives).' },
      country: { type: 'string', description: 'Only companies from this country, in English as in the database, e.g. "Canada", "United States".' },
      limit: { type: 'integer', description: 'Number of candidates, 1 to 15 (default 8).' },
    },
    required: ['company'],
    additionalProperties: false,
  },
};

const PORTFOLIO_TOOL = {
  name: 'get_portfolio_details',
  description:
    'Full view of the logged-in client\'s portfolio: every position with quantity, value and gain in CAD, weight, ' +
    'sector, industry and country (from the market database); breakdowns by sector, industry, country and listing ' +
    'currency; the check of the investor profile\'s guardrails (largest sector, number of assets, crypto share, ' +
    'excluded activities); fictional performance history. Fast, no parameters. Call it for questions about the ' +
    'client\'s own portfolio that the summary in the system prompt does not answer (diversification, concentration, ' +
    'exposure, gains per position, guardrails).',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
};

let client = null;
function getClient() {
  // Created on first use so the server starts even without AWS credentials.
  if (!client) {
    client = new AnthropicBedrockMantle({
      // The app container on the EC2 gets no AWS_REGION: default to the project's.
      awsRegion: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1',
      // Refusal fallback: Bedrock has no server-side `fallbacks` parameter,
      // so the SDK middleware retries a declined request on Claude Opus 4.8.
      middleware: [betaRefusalFallbackMiddleware([{ model: 'anthropic.claude-opus-4-8' }])],
    });
  }
  return client;
}

// One fallback state per conversation keeps a chat on the model that accepted.
const fallbackStates = new Map();

function validResearchInput(input) {
  if (!input || typeof input !== 'object') return null;
  const { company, ticker, question, proposal } = input;
  if (typeof company !== 'string' || !company.trim() || company.length > 200) return null;
  if (typeof question !== 'string' || !question.trim() || question.length > 1000) return null;
  if (ticker !== undefined && (typeof ticker !== 'string' || !/^[A-Z0-9.\-]{1,12}$/.test(ticker.trim().toUpperCase()))) return null;
  if (proposal !== undefined && (typeof proposal !== 'string' || proposal.length > 1000)) return null;
  // Anything but an explicit "judgment" is treated as a factual request (no review).
  const kind = input.request_type === 'judgment' ? 'judgment' : 'factual';
  return {
    company: company.trim(), ticker: ticker?.trim().toUpperCase(), question: question.trim(),
    kind, proposal: proposal?.trim() || question.trim(), marketContext: input.needs_market_context === true,
  };
}

// Progress steps sent to the interface: { id, label, status, detail }.
const SOURCE_LABELS = [
  ['earnings-kb___', 'base de connaissances'],
  ['bigdata___', 'Bigdata.com'],
  ['web-search___', 'web'],
];
const sourceLabel = (tool) => SOURCE_LABELS.find(([prefix]) => tool.startsWith(prefix))?.[1];
const VERDICTS = { SOLID: 'solide', PARTIAL: 'partielle', WEAK: 'faible' };

// Calls onProgress safely: the progress display must never break an answer.
function makeProgress(onProgress) {
  return (id, label, status, detail = '') => {
    if (!onProgress) return;
    try { onProgress({ id, label, status, detail }); } catch (err) { console.error('onProgress:', err.message); }
  };
}

// Tracks the sources an agent visits, for the step's detail line.
function sourceTrail(update) {
  const seen = [];
  return (tool) => {
    const label = sourceLabel(tool);
    if (label && !seen.includes(label)) {
      seen.push(label);
      update(seen.join(' → '));
    }
  };
}

// Returns { result, research } where result is the tool_result block and
// research the successful report (null on error).
async function runTool(block, progress, ctx) {
  const fail = (content) => ({ result: { type: 'tool_result', tool_use_id: block.id, is_error: true, content }, research: null });
  if (block.name === 'find_similar_companies') return runSimilar(block, progress, fail);
  if (block.name === 'get_portfolio_details') {
    progress(`portfolio-${block.id}`, 'Lecture de votre portefeuille', 'done',
      ctx.portfolioView ? `${ctx.portfolioView.summary.positions} position(s)` : 'pas encore créé');
    const content = ctx.portfolioView
      ? JSON.stringify(ctx.portfolioView)
      : 'The client has not created a portfolio yet: invite them to create it in the Portefeuille tab.';
    return { result: { type: 'tool_result', tool_use_id: block.id, content }, research: null };
  }
  if (block.name !== 'research_company') return fail(`Unknown tool ${block.name}`);
  const input = validResearchInput(block.input);
  if (!input) return fail('Invalid input: company, question and request_type are required.');
  const id = `research-${block.id}`;
  const label = `Recherche : ${input.ticker ? `${input.company} (${input.ticker})` : input.company}`;
  progress(id, label, 'active');
  const onTool = sourceTrail((trail) => progress(id, label, 'active', trail));
  try {
    const { report, tools, bigdataBudget, saved, market } = await research.researchCompany({ ...input, onTool });
    const trail = [...new Set(tools.map(sourceLabel).filter(Boolean))].join(' → ');
    progress(id, label, 'done', trail ? `${trail} · rapport reçu` : 'rapport reçu');
    console.log(`research ${input.ticker || input.company} (${input.kind}): tools=${tools.join(',')} `
      + `bigdata=${bigdataBudget.calls}/${bigdataBudget.budget} market=${market || 'no'} saved=${saved}`);
    return {
      result: { type: 'tool_result', tool_use_id: block.id, content: report },
      research: { ...input, subject: input.ticker ? `${input.company} (${input.ticker})` : input.company, report },
    };
  } catch (err) {
    console.error('research error:', err.message);
    progress(id, label, 'error', 'échec de la recherche');
    return fail(`Research failed: ${err.message}`);
  }
}

// Similar companies from the database (no research, under a second).
async function runSimilar(block, progress, fail) {
  const input = block.input || {};
  if (typeof input.company !== 'string' || !input.company.trim() || input.company.length > 200) {
    return fail('Invalid input: company is required.');
  }
  const id = `similar-${block.id}`;
  const label = `Entreprises similaires à ${input.company.trim()} (base de données)`;
  progress(id, label, 'active');
  try {
    const result = await peers.findSimilarCompanies({
      company: input.company,
      ticker: typeof input.ticker === 'string' ? input.ticker : undefined,
      country: typeof input.country === 'string' ? input.country : undefined,
      sameCountryOnly: input.same_country_only === true,
      limit: input.limit,
    });
    if (!result.reference) {
      progress(id, label, 'done', 'entreprise introuvable dans la base');
      return { result: { type: 'tool_result', tool_use_id: block.id, content: 'Reference company not found in the database: do not guess similar companies; say so to the user.' }, research: null };
    }
    const r = result.reference;
    progress(id, label, 'done', `${result.candidates.length} candidates · ${r.industry} (${r.sector})`);
    console.log(`similar ${r.symbol}: ${result.candidates.map((c) => c.symbol).join(',')}`);
    return { result: { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) }, research: null };
  } catch (err) {
    console.error('similar error:', err.message);
    progress(id, label, 'error', 'base de données indisponible');
    return fail(`Database lookup failed: ${err.message}`);
  }
}

// Peer review of the reports gathered for a judgment request. The review is
// appended to the last tool result of the batch.
async function addPeerReview(results, judgments, progress, portfolioText) {
  const proposal = judgments[0].proposal;
  const label = 'Revue critique des données';
  progress('review', label, 'active', `${judgments.length} rapport(s)`);
  const onTool = sourceTrail((trail) => progress('review', label, 'active', `vérification : ${trail}`));
  try {
    const { review, tools } = await research.reviewResearch({ proposal, reports: judgments, portfolio: portfolioText, onTool });
    console.log(`review (${judgments.length} report(s)): ${review.split('\n')[0]} tools=${tools.join(',')}`);
    const verdict = review.match(/VERDICT:\s*(SOLID|PARTIAL|WEAK)/i)?.[1]?.toUpperCase();
    progress('review', label, 'done', verdict ? `fiabilité des données : ${VERDICTS[verdict]}` : 'terminée');
    const last = results[results.length - 1];
    last.content = `${last.content}\n\n=== PEER REVIEW of the selected data (reviewer agent) ===\n${review}`;
  } catch (err) {
    console.error('review error:', err.message);
    progress('review', label, 'error', 'revue indisponible');
  }
}

async function reply({ messages, chatId, profile, portfolio, onProgress }) {
  const progress = makeProgress(onProgress);
  // The logged-in client's portfolio, enriched with the database (sector,
  // industry, country, guardrail checks). Loaded once per answer.
  const portfolioView = await portfolioContext.details({ portfolio, profile }).catch((err) => {
    console.error('portfolio context error:', err.message);
    return undefined;
  });
  const portfolioText = portfolioView === undefined
    ? 'Portefeuille du client : indisponible pour le moment (erreur de chargement).'
    : portfolioContext.summary(portfolioView);
  const ctx = { portfolioView: portfolioView || null };
  if (!fallbackStates.has(chatId)) fallbackStates.set(chatId, new BetaFallbackState());

  // The history must start with a user turn: drop leading assistant messages
  // left over after trimming.
  const history = messages.slice(-MAX_HISTORY).map(({ role, content }) => ({ role, content }));
  while (history.length && history[0].role !== 'user') history.shift();

  const tools = [
    PORTFOLIO_TOOL,
    ...(peers.isEnabled() ? [SIMILAR_TOOL] : []),
    ...(research.isEnabled() ? [RESEARCH_TOOL] : []),
  ];
  const system = [
    // Stable instructions first, then the per-user profile.
    { type: 'text', text: SYSTEM },
    { type: 'text', text: `Profil investisseur du client :\n${profileSummary(profile)}` },
    { type: 'text', text: portfolioText },
  ];
  if (!research.isEnabled()) {
    system.push({ type: 'text', text: "L'outil research_company n'est pas disponible dans cet environnement." });
  }
  if (!peers.isEnabled()) {
    system.push({ type: 'text', text: "L'outil find_similar_companies n'est pas disponible dans cet environnement : ne propose pas d'entreprises similaires de mémoire, dis que la base de données n'est pas accessible." });
  }

  let reviewed = false;
  progress('analyse', 'Analyse de la question', 'active');
  for (let step = 0; step < MAX_STEPS; step++) {
    if (step > 0) progress('write', 'Analyse des résultats et rédaction de la réponse', 'active');
    const lastStep = step === MAX_STEPS - 1;
    const response = await getClient().beta.messages.create(
      {
        model: MODEL,
        max_tokens: 16000,
        system,
        output_config: { effort: EFFORT },
        // On the last step, tools stay declared (the history has tool calls)
        // but cannot be called: Claude must write the answer.
        ...(tools.length ? { tools } : {}),
        ...(tools.length && lastStep ? { tool_choice: { type: 'none' } } : {}),
        messages: history,
      },
      { fallbackState: fallbackStates.get(chatId) },
    );

    if (response.stop_reason === 'refusal') {
      return 'Désolé, je ne peux pas répondre à cette demande.';
    }

    const toolUses = response.content.filter((block) => block.type === 'tool_use');
    if (response.stop_reason === 'tool_use' && toolUses.length) {
      // Keep the assistant turn unchanged (thinking blocks included), then
      // return every tool result in a single user message.
      progress('analyse', 'Analyse de la question', 'done');
      history.push({ role: 'assistant', content: response.content });
      const outcomes = await Promise.all(toolUses.map((block) => runTool(block, progress, ctx)));
      const results = outcomes.map((o) => o.result);
      // Judgment requests only, and one review per answer.
      const judgments = outcomes.map((o) => o.research).filter((r) => r?.kind === 'judgment');
      if (judgments.length && !reviewed && research.isReviewEnabled()) {
        reviewed = true;
        await addPeerReview(results, judgments, progress, portfolioText);
      }
      history.push({ role: 'user', content: results });
      continue;
    }

    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();
    if (response.stop_reason === 'max_tokens') {
      return `${text}\n\n*(Réponse tronquée : elle dépassait la longueur maximale.)*`;
    }
    return text || 'Désolé, je n’ai pas de réponse à proposer.';
  }
  return 'Désolé, je n’ai pas pu terminer la recherche.';
}

// `brief` is the data sheet built by reports.js (percentages and dates only).
async function report({ label, brief }) {
  const response = await getClient().beta.messages.create(
    {
      model: MODEL,
      max_tokens: 16000,
      system: REPORT_SYSTEM,
      output_config: { effort: EFFORT },
      messages: [{ role: 'user', content: `Rédige mon rapport ${label}.\n\n${brief}` }],
    },
    { fallbackState: new BetaFallbackState() },
  );
  if (response.stop_reason === 'refusal') return 'Désolé, je ne peux pas rédiger ce rapport.';
  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
  if (response.stop_reason === 'max_tokens') {
    return `${text}\n\n*(Rapport tronqué : il dépassait la longueur maximale.)*`;
  }
  return text || 'Désolé, je n’ai pas pu rédiger ce rapport.';
}

module.exports = { reply, report };
