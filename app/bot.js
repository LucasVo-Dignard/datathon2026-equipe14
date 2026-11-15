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
//   - portfolio: le portefeuille du client (voir portfolio.js), pas encore utilisé
// et retourne le texte de la réponse, en Markdown.
//
// Identifiants AWS : en local, ceux de .env-aws (chargés par `npm run dev`) ;
// sur l'EC2, le rôle IAM de l'instance (bedrock-mantle:CreateInference, et
// bedrock-agentcore:InvokeHarness pour la recherche).
// ---------------------------------------------------------------------------

const { AnthropicBedrockMantle } = require('@anthropic-ai/bedrock-sdk');
const { betaRefusalFallbackMiddleware, BetaFallbackState } = require('@anthropic-ai/sdk');
const { profileSummary } = require('./profile');
const research = require('./research');

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

Mise en forme : l'interface affiche du Markdown. Utilise-le avec mesure pour rendre la réponse facile à lire :
- un titre court (###) seulement pour une réponse détaillée ;
- des listes à puces pour les chiffres clés, avec la période et les montants en **gras** ;
- un tableau simple si tu compares plusieurs valeurs (les boutons de source peuvent aller dans une colonne « Source ») ;
- les longues listes de sources en fin de réponse sont inutiles : cite chaque source directement à côté de l'information.

Citations : quand une information vient du rapport de recherche, cite sa source juste après elle, dans la même phrase ou la même puce, avec le format exact [@Nom court](url), par exemple « Le chiffre d'affaires atteint **114,5 G$** [@SEC](https://www.sec.gov/...) ». L'interface l'affiche sous forme de petit bouton cliquable avec le logo du site.
- Le rapport numérote ses sources (S1, S2…) et indique pour chaque fait de quelle source il vient : reprends exactement ces correspondances et les URL de la liste « Sources » du rapport, sans en inventer.
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
- Une section par thème, avec un titre de niveau 2 (## Titre), dans cet ordre : ## En bref, ## Performance, ## Titres à surveiller, ## Exposition régionale, ## Exposition sectorielle, ## Actualités, ## Cohérence avec votre profil, ## Points d'attention. Omets une section sans contenu.
- En bref : trois puces au plus, chacune commence par le chiffre ou le fait clé en **gras**, une phrase chacune.
- Performance : un tableau à deux colonnes (Indicateur | Valeur) avec le rendement de la période, le plus haut et le plus bas (avec leur date) et l'écart avec le plus haut, puis une phrase qui résume l'allure de la période.
- Titres à surveiller : un tableau (Titre | Variation sur la période | Poids | Contribution) avec les trois plus fortes hausses et les trois plus fortes baisses, puis au plus trois puces de commentaire.
- Expositions : un tableau par répartition (Région | Poids, puis Devise | Poids ; Secteur | Poids), suivi d'au plus trois puces d'analyse.
- Actualités : une puce par nouvelle, la date en **gras** au début, une phrase.
- Points d'attention : une liste numérotée de trois ou quatre questions à se poser.
- Pas de paragraphe de plus de deux phrases, aucune répétition d'un même chiffre d'une section à l'autre, les pourcentages clés en **gras**.
- Longueur : quotidien très court (En bref, Titres à surveiller, Points d'attention suffisent), annuel plus complet avec un bilan de l'année.

Exposition régionale : décris la répartition par pays et région de l'émetteur, et par devise ; signale une forte concentration dans un seul pays ou une seule devise, ainsi que le biais domestique (part du Canada) ou son absence, et rappelle simplement ce que cela implique (risque de change, dépendance à une économie).
Compare la composition du portefeuille aux garde-fous du profil (concentration sectorielle, diversification, liquidités) et signale les écarts.
Tu ne donnes pas de conseil financier personnalisé ni de recommandation d'achat ou de vente : tu expliques, tu signales et tu proposes des questions à se poser.
Termine par une ligne en italique rappelant que le rapport est simulé à titre informatif et ne constitue pas un conseil financier.`;

const RESEARCH_TOOL = {
  name: 'research_company',
  description:
    'Research a public company with the AgentCore research agent. It first searches the earnings releases ' +
    'knowledge base (official quarterly results and earlier research), then Bigdata.com (premium financial data), ' +
    'then the web when the previous sources have nothing. ' +
    'Returns a factual report with sources. Takes 20 to 60 seconds: call it once per company.',
  input_schema: {
    type: 'object',
    properties: {
      company: { type: 'string', description: 'Company name, e.g. "Microsoft".' },
      ticker: { type: 'string', description: 'Primary stock ticker in uppercase if known, e.g. "MSFT", "RY", "ENB".' },
      question: { type: 'string', description: 'What to find out, in English, e.g. "key results of the latest quarter".' },
    },
    required: ['company', 'question'],
    additionalProperties: false,
  },
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
  const { company, ticker, question } = input;
  if (typeof company !== 'string' || !company.trim() || company.length > 200) return null;
  if (typeof question !== 'string' || !question.trim() || question.length > 1000) return null;
  if (ticker !== undefined && (typeof ticker !== 'string' || !/^[A-Z0-9.\-]{1,12}$/.test(ticker.trim().toUpperCase()))) return null;
  return { company: company.trim(), ticker: ticker?.trim().toUpperCase(), question: question.trim() };
}

async function runTool(block) {
  if (block.name !== 'research_company') {
    return { type: 'tool_result', tool_use_id: block.id, is_error: true, content: `Unknown tool ${block.name}` };
  }
  const input = validResearchInput(block.input);
  if (!input) {
    return { type: 'tool_result', tool_use_id: block.id, is_error: true, content: 'Invalid input: company and question are required.' };
  }
  try {
    const { report, tools, bigdataBudget, saved } = await research.researchCompany(input);
    console.log(`research ${input.ticker || input.company}: tools=${tools.join(',')} `
      + `bigdata=${bigdataBudget.calls}/${bigdataBudget.budget} saved=${saved}`);
    return { type: 'tool_result', tool_use_id: block.id, content: report };
  } catch (err) {
    console.error('research error:', err.message);
    return { type: 'tool_result', tool_use_id: block.id, is_error: true, content: `Research failed: ${err.message}` };
  }
}

async function reply({ messages, chatId, profile }) {
  if (!fallbackStates.has(chatId)) fallbackStates.set(chatId, new BetaFallbackState());

  // The history must start with a user turn: drop leading assistant messages
  // left over after trimming.
  const history = messages.slice(-MAX_HISTORY).map(({ role, content }) => ({ role, content }));
  while (history.length && history[0].role !== 'user') history.shift();

  const tools = research.isEnabled() ? [RESEARCH_TOOL] : [];
  const system = [
    // Stable instructions first, then the per-user profile.
    { type: 'text', text: SYSTEM },
    { type: 'text', text: `Profil investisseur du client :\n${profileSummary(profile)}` },
  ];
  if (!tools.length) {
    system.push({ type: 'text', text: "L'outil research_company n'est pas disponible dans cet environnement." });
  }

  for (let step = 0; step < MAX_STEPS; step++) {
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
      history.push({ role: 'assistant', content: response.content });
      history.push({ role: 'user', content: await Promise.all(toolUses.map(runTool)) });
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
