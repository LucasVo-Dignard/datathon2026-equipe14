# COURTIAGE DIRECT : l'information financière qui s'explique

**Équipe 14 · Datathon Polyfinances 2026 · Défi AlphaForge AI (Banque Nationale × AWS)**

### Problématique
Les clients de Banque Nationale Courtage Direct ont accès à une masse d'informations :
cours, résultats, notes d'analystes, actualités, macroéconomie. Ceux qui ont **peu de
temps ou peu de connaissances** n'arrivent pas à trier, relier et interpréter ces
informations **selon leur propre situation**. Et un outil qui se contente d'approuver,
comme pour une personne tentée par un titre très médiatisé, peut leur nuire.

### Approche agentique
- **Un agent conversationnel** (Claude sur Amazon Bedrock) qui connaît le profil et
  le portefeuille du client, et qui choisit ses outils.
- **Un agent de recherche** (Bedrock AgentCore) qui consulte une base de
  connaissances de communiqués officiels, puis Bigdata.com, puis le web en dernier
  recours. Il rend un rapport sourcé.
- **Un agent relecteur** pour toute demande de jugement (acheter, vendre, est-ce
  risqué ?). Il évalue la qualité, la fraîcheur et l'équilibre des sources, puis rend
  un verdict (solide, partiel, faible) avec des points de vigilance.
- **Des contrôles déterministes** autour des agents : un profil de risque calculé par
  des règles, des garde-fous (volatilité, part en cryptoactifs, concentration,
  exclusions ESG), et des tensions détectées entre les demandes et le profil.
- **Des jobs autonomes** (AWS Batch) : mise à jour quotidienne des marchés, alertes
  de prix, et veille de l'actualité toutes les 2 h.

### Originalité
- **Un profil qui contredit au besoin**. Le risque retenu est le plus prudent entre
  la tolérance et la capacité, plafonné par l'objectif, ce qui couvre les trois
  personas : Amira (élevé, mais diversifié), Mateo (préférences ESG) et Robert
  (signalé quand sa demande dépasse son profil).
- **Une information proactive** : rapports périodiques, et alertes par courriel dont
  le seuil suit le niveau de risque (de 2 à 7 %).
- **Une veille d'actualité par portefeuille**. Amazon Comprehend rattache les
  articles des médias canadiens aux titres détenus, là où Yahoo ne couvre presque
  pas la TSX.
- **Une IA économe** : chaque recherche payante est versée dans la base de
  connaissances, et la même question devient gratuite ensuite.

### Sources de données
Uniquement des données publiques, récupérées à la demande et horodatées :
- **Marchés** : Yahoo Finance (cours ajustés, fondamentaux, analystes, FNB, change),
  Finnhub et companiesmarketcap.com (environ 1 000 sociétés suivies).
- **Macroéconomie** : Banque mondiale, avec la provenance de chaque valeur.
- **Documents officiels** : SEC EDGAR (communiqués de résultats) et Bigdata.com.
- **Actualité** : CBC, Radio-Canada, The Globe and Mail et MarketWatch (titres et
  liens seulement, conformément à leurs conditions).

### Capacité d'explication
- **Chaque conclusion est reliée à ses données.** Le score de risque est détaillé
  question par question, avec les tensions expliquées.
- **Chaque réponse de l'agent a une section « Sources »**, qui distingue le
  communiqué officiel du web, et des points de vigilance pour les jugements.
- **Les alertes et les actualités se justifient.** Elles indiquent les chiffres, la
  source, la raison du seuil, et ce qu'une variation d'un jour ne dit pas. Chaque
  actualité précise pourquoi elle est liée à vos titres.
- **Les faits, les hypothèses et la simulation sont toujours séparés** : pas de
  transaction réelle, et pas de conseil personnalisé.

### Bénéfices concrets pour l'utilisateur
- **Quelques minutes suffisent** : profil en un clic depuis un persona, et
  l'essentiel du portefeuille, de l'actualité et des risques sur une seule page.
- **On est prévenu sans surveiller** : un courriel quand un titre détenu bouge
  fortement, sans doublon, avec désabonnement en un clic.
- **Des réponses vérifiables, adaptées à sa situation**, et non une recommandation
  générique.
- **Une protection contre les décisions impulsives** : l'outil signale l'écart entre
  une envie du moment et ses propres objectifs.


