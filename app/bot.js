'use strict';
// ---------------------------------------------------------------------------
// Point de branchement des agents.
//
// Remplacez le corps de reply() par l'appel à vos agents. La fonction reçoit :
//   - messages : l'historique complet [{ role: 'user' | 'assistant', content }],
//                le dernier élément est le message que l'utilisateur vient d'envoyer
//   - username : l'utilisateur connecté
//   - chatId   : l'identifiant de la conversation
// et doit retourner (ou résoudre) le texte de la réponse.
// ---------------------------------------------------------------------------

async function reply({ messages }) {
  const last = messages[messages.length - 1].content;
  return `Agent pas encore branché (prototype). Vous avez écrit : « ${last} »`;
}

module.exports = { reply };
