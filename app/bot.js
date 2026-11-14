'use strict';
// ---------------------------------------------------------------------------
// Agent de base : Claude via Amazon Bedrock, sans outils ni recherche.
// Il répond au message de l'utilisateur à partir de l'historique de la
// conversation uniquement.
//
// reply() reçoit :
//   - messages : l'historique complet [{ role: 'user' | 'assistant', content }],
//                le dernier élément est le message que l'utilisateur vient d'envoyer
//   - username : l'utilisateur connecté
//   - chatId   : l'identifiant de la conversation
//   - portfolio: le portefeuille du client (voir portfolio.js), pas encore utilisé
// et retourne le texte de la réponse.
//
// Identifiants AWS : en local, ceux de .env-aws (chargés par `npm run dev`) ;
// sur l'EC2, le rôle IAM de l'instance (il lui faut bedrock-mantle:CreateInference).
// ---------------------------------------------------------------------------

const { AnthropicBedrockMantle } = require('@anthropic-ai/bedrock-sdk');
const { betaRefusalFallbackMiddleware, BetaFallbackState } = require('@anthropic-ai/sdk');

const MODEL = process.env.AGENT_MODEL || 'anthropic.claude-opus-5-5';
// Claude Opus 5.5 defaults to medium; low keeps chat replies fast.
const EFFORT = process.env.AGENT_EFFORT || 'low';
// Only the most recent messages are sent, to bound cost on long chats.
const MAX_HISTORY = 40;

const SYSTEM = `Tu es l'assistant de « Mon portefeuille », une application qui aide un client à suivre ses placements en actions.
Réponds dans la langue de l'utilisateur (le français par défaut), de façon claire et concise.
Tu n'as accès ni à Internet, ni aux données de marché en temps réel, ni au portefeuille du client : si une question en dépend, dis-le simplement et réponds avec ce que tu sais de façon générale.
Tu ne donnes pas de conseil financier personnalisé : tu expliques les notions, les options et les risques pour que le client décide lui-même.
L'interface affiche du texte brut : n'utilise pas de Markdown (pas de **gras**, de titres # ni de tableaux) ; des listes simples avec des tirets sont acceptées.`;

let client = null;
function getClient() {
  // Created on first use so the server starts even without AWS credentials.
  if (!client) {
    client = new AnthropicBedrockMantle({
      // Refusal fallback: Bedrock has no server-side `fallbacks` parameter,
      // so the SDK middleware retries a declined request on Claude Opus 4.8.
      middleware: [betaRefusalFallbackMiddleware([{ model: 'anthropic.claude-opus-4-8' }])],
    });
  }
  return client;
}

// One fallback state per conversation keeps a chat on the model that accepted.
const fallbackStates = new Map();

async function reply({ messages, chatId }) {
  if (!fallbackStates.has(chatId)) fallbackStates.set(chatId, new BetaFallbackState());

  // The history must start with a user turn: drop leading assistant messages
  // left over after trimming.
  const history = messages.slice(-MAX_HISTORY).map(({ role, content }) => ({ role, content }));
  while (history.length && history[0].role !== 'user') history.shift();

  const response = await getClient().beta.messages.create(
    {
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      output_config: { effort: EFFORT },
      messages: history,
    },
    { fallbackState: fallbackStates.get(chatId) },
  );

  if (response.stop_reason === 'refusal') {
    return 'Désolé, je ne peux pas répondre à cette demande.';
  }
  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
  if (response.stop_reason === 'max_tokens') {
    return `${text}\n\n(Réponse tronquée : elle dépassait la longueur maximale.)`;
  }
  return text || 'Désolé, je n’ai pas de réponse à proposer.';
}

module.exports = { reply };
