# COURTIAGE DIRECT : équipe 14 (Datathon 2026)

Outil d'information pour les clients de Banque Nationale Courtage Direct qui ont
peu de temps ou peu de connaissances en placement. Il comprend :
- un **profil investisseur** guidé ;
- un **portefeuille simulé** ;
- de **vraies actualités** liées aux titres détenus ;
- des **alertes de prix par courriel** ;
- des **rapports périodiques** ;
- un **assistant** agentique, Claude sur Amazon Bedrock avec AgentCore, qui cite ses sources.

> **Simulation éducative.** Aucune transaction réelle n'est effectuée, et l'outil ne
> fournit pas de conseil financier personnalisé. Les portefeuilles et les profils
> sont fictifs. Les seuils (score de risque, garde-fous, alertes) sont des hypothèses
> du prototype.

- [Fonctionnalités](#fonctionnalités)
- [Architecture et services AWS](#architecture-et-services-aws)
- [Agents](#agents)
- [Dépendances](#dépendances)
- [Sources de données](#sources-de-données)
- [Configuration](#configuration)
- [Démarrage et reproduction](#démarrage-et-reproduction)

## Fonctionnalités

| Onglet ou fonction | Ce qu'elle fait | Code |
| --- | --- | --- |
| **Mon profil** | 18 questions (dont 4 facultatives), ou un persona du cas (Amira, Mateo, Robert). Le niveau de risque est le plus prudent entre la tolérance et la capacité, plafonné par l'objectif. Le résultat est expliqué : facteurs, tensions entre les réponses, garde-fous pour l'agent, persona le plus proche | `app/profile.js` |
| **Portefeuille** | Portefeuille simulé, aléatoire ou composé par le client, avec graphique, news liées aux titres détenus et recherche de titres | `app/portfolio.js`, `app/news.js`, `app/stocks.js` |
| **Rapports** | Rapports quotidiens, hebdomadaires, mensuels et annuels, rédigés par l'agent à partir des données. Le client peut les programmer avec l'assistant : un job Batch horaire rédige ceux qui sont dus, signalés par un badge « Nouveau » | `app/reports.js`, `app/report-generator.js`, `app/report-schedule.js`, `app/report-schedule-store.js`, `app/jobs/scheduled-reports.js` |
| **Assistant** | Agent Claude (Bedrock) qui connaît le profil et le portefeuille. Il fait des recherches avec AgentCore (base de connaissances, Bigdata.com, recherche web) et fait relire ses jugements par un second agent | `app/bot.js`, `agents/` |
| **Alertes de prix** | Un courriel (Amazon SES) quand un titre détenu varie de 2 à 7 % ou plus dans la journée, selon le niveau de risque. Jamais deux fois la même alerte, et désabonnement en un clic | `app/notifications.js`, `src/marketdata/jobs/price-alerts.js` |

## Architecture et services AWS

<img width="732" height="784" alt="arch" src="https://github.com/user-attachments/assets/f76af079-d596-4469-b4f9-68b26d995b90" />

| Service | Rôle |
| --- | --- |
| **EC2**, **ECR** | Serveur web. L'app tourne dans un conteneur tiré d'un dépôt ECR privé |
| **RDS PostgreSQL 17** | Données de marché, compositions de FNB, utilisateurs et sessions, profils, portefeuilles, conversations, alertes, news, programmation des rapports. Base privée |
| **Secrets Manager** | Mot de passe de RDS, généré et renouvelé par RDS, et lu au démarrage par le serveur et par les jobs sans jamais être écrit sur disque. Clé API Bigdata.com de l'agent de recherche |
| **AWS Batch (Fargate)** + **EventBridge Scheduler** | Mise à jour des données et des alertes (jours de semaine à 18 h, heure de Toronto), des news toutes les 2 h, et rapports programmés toutes les heures |
| **Amazon Bedrock** + **Bedrock AgentCore** | Agent conversationnel (Claude), agent de recherche, relecture |
| **Amazon Bedrock Knowledge Bases** | Base de connaissances de l'agent de recherche : communiqués de résultats (SEC EDGAR) et rapports de recherche déjà produits, filtrables par titre. Les documents sources sont dans S3 |
| **Amazon Comprehend** | Ton des articles et sociétés nommées, pour rattacher les news aux titres |
| **Amazon SES** | Alertes de prix par courriel |
| **S3** | État Terraform, rapports, paquets de migration. Tous privés |

L'infrastructure est décrite en Terraform, dans quatre stacks à appliquer dans cet
ordre : `infra/` (réseau, EC2, ECR, SES, S3), `infra-db/` (RDS), `infra-batch/`
(jobs) et `infra-agents/` (agents AgentCore). Chaque stack garde son tfstate dans un
bucket S3 privé, avec un verrou.

## Agents

Trois agents sur Amazon Bedrock :

| Agent | Rôle |
| --- | --- |
| **Assistant** | Répond au client. Il connaît son profil et son portefeuille, et a quatre outils : `research_company` (lance l'agent de recherche), `find_similar_companies` (sociétés comparables, tirées de la base, donc avec une base seulement), `get_portfolio_details` et `set_report_schedule` (programme les rapports). Il rédige aussi les rapports. Un refus est relancé sur Claude Opus 4.8 |
| **Recherche** | Cherche les faits sur une société et renvoie un rapport sourcé |
| **Relecteur** | Pour les questions de jugement seulement (acheter, vendre, est-ce risqué…) : évalue la qualité, la fraîcheur et l'équilibre des sources, et rend un verdict (`SOLID`, `PARTIAL`, `WEAK`) avec des points de vigilance |

**Sources de l'agent de recherche**, derrière une AgentCore Gateway (authentification
IAM), dans l'ordre :
1. la base de connaissances Bedrock : communiqués de résultats (SEC EDGAR) et rapports
   déjà produits, filtrés par titre ;
2. **Bigdata.com** (données financières premium, en MCP), au plus 3 appels par
   recherche ;
3. la recherche web d'AgentCore, en dernier recours.

**Économie des crédits Bigdata.com** (chaque appel est payant) :
- La vue de marché Bigdata.com (secteurs, indices, taux) est récupérée une seule fois
  par jour, puis réutilisée par toutes les recherches.
- Chaque rapport qui a utilisé Bigdata.com est versé dans la base de connaissances,
  pour que la même question soit moins coûteuse la fois suivante.

**Dans Terraform** (`infra-agents/`, prod seulement pour l'instant) :
- un bucket S3 privé et une base de connaissances Bedrock, avec sa source de données ;
- la Gateway, avec trois cibles : la base de connaissances, la recherche web, et
  Bigdata.com, limitée à 6 requêtes par minute, avec une clé lue dans Secrets Manager
  par AgentCore Identity ;
- les deux harnesses, `research` et `reviewer`, dont les prompts sont dans
  `agents/prompts/` ;
- leurs rôles IAM.

**La clé Bigdata.com se met à la main.** Terraform crée le secret
`<préfixe>/bigdata-api-key`, mais jamais sa valeur, pour qu'elle ne soit ni dans Git
ni dans l'état Terraform. Dans un nouvel environnement, il faut la verser avant le
premier `apply` complet :

```bash
terraform -chdir=infra-agents apply -target=aws_secretsmanager_secret.bigdata
aws secretsmanager put-secret-value --secret-id <préfixe>/bigdata-api-key \
  --secret-string '{"api_key":"<clé Bigdata.com>"}'
terraform -chdir=infra-agents apply
```

La même commande `put-secret-value` sert à changer la clé.

L'app les trouve par les variables `RESEARCH_*`. Sur l'EC2, `scripts/deploy-app.sh`
retrouve ces ressources par leur nom et écrit les variables dans `/etc/chatbot.env` à
chaque déploiement. Sans elles, l'assistant répond sans recherche.

## Dépendances

| Outil | Version | Pour |
| --- | --- | --- |
| Node.js | 22 (image `node:22-alpine`) | App, jobs, tests |
| npm | celui de Node 22 | Dépendances (`package.json`, `package-lock.json`) |
| Docker + buildx | récent (sur Mac : Docker Desktop ou `colima start --vm-type vz --vz-rosetta`) | Images de l'app et des jobs (`linux/amd64`), Postgres et Flyway en local |
| Terraform | ≥ 1.10 | Infrastructure (`infra*/`) |
| AWS CLI | v2 | Déploiements, jobs Batch à la main |
| Python | ≥ 3.11 avec `boto3` | `db/migrate.py` (migrations Flyway sur RDS) |

L'interface (`app/public/`) n'utilise aucun framework ni aucune dépendance.

## Sources de données

Uniquement des données publiques, récupérées **à la demande** : l'app lit d'abord la
base, et n'appelle une source que si la donnée manque ou est périmée. Le jeu de
données de départ du cas n'est pas utilisé. Chaque valeur garde sa source et sa date.

| Source | Données | Accès | Où |
| --- | --- | --- | --- |
| **Yahoo Finance** (`yahoo-finance2`) | Cours quotidiens ajustés, profils, indicateurs, objectifs et notes d'analystes, compositions de FNB, taux de change (`USDCAD=X`), news par titre | Sans clé. Débit limité à 60 appels/min dans le job | `src/marketdata/providers/yahoo/` |
| **companiesmarketcap.com** | Classement mondial des capitalisations (≈ 1 000 sociétés suivies) | CSV public | `src/marketdata/providers/companiesmarketcap/` |
| **CBC Business, Radio-Canada Économie, The Globe and Mail, MarketWatch** | Titres, extraits de 400 caractères au plus, liens, dans leur langue d'origine | Flux RSS publics. On ne garde que le titre, l'extrait et le lien vers l'éditeur | `src/marketdata/news/feeds.js` |
| **SEC EDGAR** | Communiqués de résultats (8-K, pièce 99.1), versés dans la base de connaissances de l'agent | Public | `agents/knowledge-base/` |

Les sources de l'agent de recherche (Bigdata.com, recherche web) sont décrites dans
[Agents](#agents).

**Conditions des flux RSS.** Ils sont offerts pour l'usage personnel et pour les
agrégateurs qui affichent le titre et un court extrait, avec un lien vers l'article
et le nom de la source. C'est tout ce que l'outil garde et affiche, sans texte
intégral, et les articles de plus de 30 jours sont supprimés. Conditions :
[CBC](https://www.cbc.ca/rss/), [Radio-Canada](https://ici.radio-canada.ca/rss),
[The Globe and Mail](https://www.theglobeandmail.com/about/rss/),
[MarketWatch](https://www.marketwatch.com/site/rss).

**Traitements.**
- Les cours sont des clôtures ajustées (dividendes, fractionnements), convertis en
  CAD avec les taux Yahoo.
- Chaque nouvel article passe une fois par Amazon Comprehend, qui détecte le ton et
  les sociétés nommées. Celles-ci sont rattachées aux sociétés cotées en base, sans
  tenir compte des formes juridiques ni des accents, avec les sigles canadiens
  (RBC, TD, BMO…). Le rattachement est prudent : « Bank of Canada » n'est jamais
  confondue avec la Banque Royale.
- L'actualité générale n'est affichée que si elle nomme une société cotée ou
  traite d'un thème de marché.

**Limites.**
- Les cours passés ne présagent pas des cours futurs.
- Yahoo couvre mal les titres de la TSX en news, ce que les médias canadiens compensent.
- Le ton détecté par Comprehend est un indice, pas un avis.

## Configuration

**Identifiants : jamais dans Git.** Tous les fichiers `.env*` sont ignorés par Git,
sauf le modèle `.env-dev.example`. Dans les dossiers `infra*/`, `*.tfvars`,
`*.tfstate` et `*.pem` le sont aussi.

| Fichier | Contenu |
| --- | --- |
| `.env-aws` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_DEFAULT_REGION=us-east-1` (jeton temporaire, à renouveler) |
| `.env-dev` | `TF_WORKSPACE=<ton nom>`, qui choisit ton environnement pour Terraform, les migrations et les scripts (copie de `.env-dev.example`) |

```bash
set -a; source .env-aws; source .env-dev; set +a
```

**Environnements.** Chaque développeur a le sien (VPC, EC2, RDS, jobs), en plus de la
prod, dans le même compte AWS. `TF_WORKSPACE` le choisit pour Terraform,
`db/migrate.py` et les scripts. Sans elle, rien ne touche la prod : Terraform exige
`-var confirm_prod=true` et les scripts refusent de tourner.

**Variables de l'app et des jobs.** Sur AWS, la plupart sont posées
automatiquement : le script `chatbot-db-env` de l'EC2 construit `DATABASE_URL` depuis
RDS et Secrets Manager, Terraform et `scripts/deploy-app.sh` remplissent
`/etc/chatbot.env`, et Terraform la définition du job. `AGENT_*` gardent leurs valeurs par défaut et
`FINNHUB_API_KEY` n'est pas définie sur AWS. En local, elles sont toutes optionnelles.

| Variable | Défaut | Effet |
| --- | --- | --- |
| `PORT` | `3000` | Port HTTP de l'app |
| `DATABASE_URL` | non défini → fichier JSON | PostgreSQL. Sans elle, tout est stocké dans `app/data/db.json` |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_SECRET_ARN` | non définis | Jobs seulement, à la place de `DATABASE_URL` : le mot de passe est lu dans Secrets Manager (`src/marketdata/db/connection.js`) |
| `DATA_FILE` | `app/data/db.json` | Fichier JSON du mode sans base |
| `AWS_REGION` | `AWS_DEFAULT_REGION`, sinon `us-east-1` | Région de Bedrock, d'AgentCore et du stockage S3 des rapports |
| `AGENT_MODEL`, `AGENT_EFFORT` | `anthropic.claude-opus-5-5`, `low` | Modèle et effort de l'agent conversationnel et de la rédaction des rapports |
| `RESEARCH_HARNESS_ARN` | non défini → recherche désactivée | Agent de recherche AgentCore (voir [Agents](#agents)) |
| `RESEARCH_REVIEWER_ARN` | non défini → pas de relecture | Agent relecteur |
| `RESEARCH_KB_BUCKET`, `RESEARCH_KB_ID`, `RESEARCH_KB_DATA_SOURCE_ID` | non définis → rapports non versés | Où verser les rapports de recherche dans la base de connaissances |
| `RESEARCH_GATEWAY_URL` | non défini → pas de vue de marché partagée | Gateway de l'agent, pour récupérer la vue de marché une fois par jour |
| `REPORTS_BUCKET` | non défini → fichier JSON | Stockage des rapports sur S3 |
| `ALERTS_SENDER`, `SES_CONFIGURATION_SET` | non définis → alertes désactivées | Expéditeur SES vérifié. Seul `ALERTS_SENDER` active les alertes |
| `APP_URL` | non défini → liens relatifs | Adresse de l'app dans les courriels (sans elle, les liens ne marchent pas) |
| `REFRESH_ENABLED`, `NEWS_ENABLED` | activés (Terraform ne pose que `REFRESH_ENABLED`, désactivé en dev) | Désactive le job de mise à jour ou celui des news |

Les principales variables Terraform (par environnement, sinon des valeurs par défaut
adaptées à la prod ou au dev) sont :
- `allowed_cidrs`, par défaut `132.207.0.0/16` (Polytechnique) ;
- `alerts_enabled` et `alerts_sender_email` ;
- `refresh_enabled`, `schedule_enabled`, `reports_schedule_enabled` et `job_timeout_seconds` ;
- `confirm_prod`, obligatoire pour toucher à la prod.

Toutes les variables sont décrites dans le fichier `variables.tf` de chaque stack.

## Démarrage et reproduction

### 1. En local, sans AWS ni base (2 minutes)

```bash
npm install
npm start                      # http://localhost:3000, données dans app/data/db.json
```

Ce qui fonctionne : la connexion, le profil, un portefeuille aléatoire avec de
vrais cours Yahoo. Ce qui demande AWS ou une base : les vraies
news (sans base, ce sont des exemples), les alertes, l'assistant et la rédaction
des rapports (Bedrock). `npm run dev` charge `.env-aws` et `.env-dev` s'ils existent,
et redémarre l'app à chaque modification.

### 2. En local avec PostgreSQL (Docker)

```bash
cd db
docker compose up -d postgres                  # Postgres 17 sur 127.0.0.1:5432
docker compose run --rm flyway migrate         # applique toutes les migrations de db/migrations
cd ..
export DATABASE_URL=postgres://bncd_admin:localdev@127.0.0.1:5432/marketdata
node src/marketdata/jobs/daily-refresh.js --symbols RY.TO MSFT   # quelques cours
node src/marketdata/jobs/news-refresh.js       # vraies news (identifiants AWS requis pour Comprehend)
npm start
```

### 3. Tests

```bash
npm test                                       # les tests qui demandent une base sont sautés
TEST_DATABASE_URL=postgres://bncd_admin:localdev@127.0.0.1:5432/marketdata npm test
```

> Les tests sur base **suppriment et recréent des lignes de test**. Utilise une base
> jetable, jamais celle d'un environnement AWS.

### 4. Créer un environnement AWS complet (reproduction)

Prérequis : `.env-aws` et `.env-dev` chargés, Docker et Python avec `boto3`.
L'ordre est important : chaque stack lit les ressources de la précédente.

```bash
terraform -chdir=infra init && terraform -chdir=infra apply         # réseau, EC2, ECR, SES
terraform -chdir=infra-db init && terraform -chdir=infra-db apply   # RDS (5 à 10 min)
python db/migrate.py                                                # schéma (Flyway via SSM)
./scripts/deploy-app.sh                                             # image de l'app sur l'EC2
terraform -chdir=infra-batch init && terraform -chdir=infra-batch apply
bash scripts/deploy-batch.sh                                        # image des jobs
terraform -chdir=infra output url                                   # URL de l'app
```

Après le premier `apply` d'`infra`, SES envoie un lien de vérification à l'adresse
expéditrice de l'environnement (`datathon2026.equipe14+<env>@gmail.com`). Il faut
cliquer dessus une fois pour que les alertes partent.

Les agents (`infra-agents/`) se créent après, avec la clé Bigdata.com à verser dans
Secrets Manager (voir [Agents](#agents)), puis un nouveau `./scripts/deploy-app.sh`.

### 5. Mettre à jour un environnement

| Changement | Commande |
| --- | --- |
| Code de l'app (`app/`) | `./scripts/deploy-app.sh` (l'instance n'est pas recréée), et `bash scripts/deploy-batch.sh` si le changement touche les rapports programmés (l'image des jobs contient `app/`) |
| Code des jobs (`src/`) | `bash scripts/deploy-batch.sh` |
| Nouvelle migration | `python db/migrate.py info`, puis `python db/migrate.py` |
| Infrastructure | `terraform -chdir=<stack> plan`, puis `apply` |

Prod : `TF_WORKSPACE=default`, avec `-var confirm_prod=true` pour Terraform et
`--env prod` pour `migrate.py`. On n'y touche que sur demande, et toujours depuis `main`.
