'use strict';
// ---------------------------------------------------------------------------
// Point de branchement des agents.
//
// Remplacez le corps de reply() par l'appel à vos agents. La fonction reçoit :
//   - messages : l'historique complet [{ role: 'user' | 'assistant', content }],
//                le dernier élément est le message que l'utilisateur vient d'envoyer
//   - username : l'utilisateur connecté
//   - chatId   : l'identifiant de la conversation
//   - profile  : le profil investisseur calculé (voir profile.js, buildProfile),
//                ou null si l'utilisateur n'a pas rempli le questionnaire.
//                profileSummary(profile) en donne un résumé texte pour le prompt ;
//                profile.guardrails et profile.tensions servent aux contrôles.
// et doit retourner (ou résoudre) le texte de la réponse.
// ---------------------------------------------------------------------------

const { profileSummary } = require('./profile');

async function reply({ messages, profile }) {
  const last = messages[messages.length - 1].content;
  return `Agent pas encore branché (prototype). Vous avez écrit : « ${last} »\n\n`
    + `Contexte transmis aux agents :\n${profileSummary(profile)}`;
}

module.exports = { reply };
