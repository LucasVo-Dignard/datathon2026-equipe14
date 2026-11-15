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
- [Dépendances](#dépendances)
- [Sources de données](#sources-de-données)
- [Configuration](#configuration)
- [Démarrage et reproduction](#démarrage-et-reproduction)

## Fonctionnalités

| Onglet ou fonction | Ce qu'elle fait | Code |
| --- | --- | --- |
| **Mon profil** | 17 questions, ou un persona du cas (Amira, Mateo, Robert). Le niveau de risque est le plus prudent entre la tolérance et la capacité, plafonné par l'objectif. Le résultat est expliqué : facteurs, tensions entre les réponses, garde-fous pour l'agent, persona le plus proche | `app/profile.js` |
| **Rapports** | Rapports quotidiens, hebdomadaires, mensuels et annuels, rédigés par l'agent à partir des données | `app/reports.js` |
| **Assistant** | Agent Claude (Bedrock) qui connaît le profil et le portefeuille. Il fait des recherches avec AgentCore (base de connaissances, Bigdata.com, recherche web) et fait relire ses jugements par un second agent | `app/bot.js`, `agents/` |
| **Alertes de prix** | Un courriel (Amazon SES) quand un titre détenu varie de 2 à 7 % ou plus dans la journée, selon le niveau de risque. Jamais deux fois la même alerte, et désabonnement en un clic | `app/notifications.js`, `src/marketdata/jobs/price-alerts.js` |

## Architecture et services AWS

```
                       Navigateur (réseau Polytechnique uniquement)
                                         │ HTTP :80
                     ┌───────────────────▼────────────────────┐
                     │ EC2 t3.micro, conteneur Docker (ECR)   │──── Bedrock (Claude) + AgentCore
                     │ app/ (Node.js, sans framework)         │──── SES (alertes, courriels de test)
                     └───────┬──────────────────────┬─────────┘──── S3 privé (rapports)
                             │ TLS vérifié          │ SSM (déploiements, migrations : pas de SSH)
                     ┌───────▼────────┐    ┌────────┴──────────────────────────────────────┐
                     │ RDS PostgreSQL │◄───│ AWS Batch Fargate (src/marketdata/jobs/)      │
                     │ (privé)        │    │  - daily-refresh : cours, données, alertes    │
                     └────────────────┘    │    (en semaine à 18 h, EventBridge Scheduler) │
                                           │  - news-refresh : RSS + Yahoo + Comprehend    │
                                           │    (toutes les 2 h)                           │
                                           └───────────────────────────────────────────────┘
```

| Service | Rôle |
| --- | --- |
| **EC2**, **ECR** | Serveur web. L'app tourne dans un conteneur tiré d'un dépôt ECR privé |
| **RDS PostgreSQL 17** | Données de marché, profils, portefeuilles, conversations, alertes, news. Base privée |
| **Secrets Manager** | Mot de passe de RDS, généré et renouvelé par RDS, et lu au démarrage par le serveur et par les jobs sans jamais être écrit sur disque. Clé API Bigdata.com de l'agent de recherche |
| **AWS Batch (Fargate)** + **EventBridge Scheduler** | Mise à jour quotidienne des données et des alertes, et des news toutes les 2 h |
| **Amazon Bedrock** + **Bedrock AgentCore** | Agent conversationnel (Claude), agent de recherche, relecture |
| **Amazon Bedrock Knowledge Bases** | Base de connaissances de l'agent de recherche : communiqués de résultats (SEC EDGAR) et rapports de recherche déjà produits, filtrables par titre. Les documents sources sont dans S3 |
| **Amazon Comprehend** | Ton des articles et sociétés nommées, pour rattacher les news aux titres |
| **Amazon SES** | Alertes de prix par courriel |
| **S3** | État Terraform, rapports, paquets de migration. Tous privés |

L'infrastructure est décrite en Terraform, dans trois stacks à appliquer dans cet
ordre : `infra/` (réseau, EC2, ECR, SES, S3), `infra-db/` (RDS) et `infra-batch/`
(jobs). Chaque stack garde son état dans un bucket S3 privé, avec un verrou.

**Un environnement par développeur, en plus de la prod**, dans le même compte AWS.
Chacun a ses propres VPC, EC2, RDS, jobs et dépôts ECR :

| Environnement | Workspace Terraform | Noms des ressources |
| --- | --- | --- |
| prod | `default` | `datathon2026-equipe14-*` |
| Lucas, André, Youcef | `lucas`, `andre`, `youcef` | `datathon2026-equipe14-<nom>-*` |

Le workspace est choisi par la variable `TF_WORKSPACE`, que lisent Terraform,
`db/migrate.py` et les scripts de déploiement. Sans elle, rien ne touche la prod :
Terraform exige `-var confirm_prod=true`, et les scripts refusent de tourner. En dev,
la planification des jobs est désactivée et l'IP de la machine qui fait `apply` est
autorisée en plus de Polytechnique.

**Agent de recherche (Bedrock AgentCore).** Quand une question porte sur une société,
Claude appelle un *harness* AgentCore. Celui-ci interroge, dans l'ordre :
1. la base de connaissances (communiqués de résultats, filtrés par titre) ;
2. Bigdata.com, au plus 2 appels par recherche ;
3. la recherche web d'AgentCore, en dernier recours.

Il renvoie un rapport sourcé. Les questions de jugement (acheter, vendre, est-ce
risqué…) passent ensuite par un second harness, le **relecteur**. Celui-ci évalue la
qualité, la fraîcheur et l'équilibre des sources, et rend un verdict (`SOLID`,
`PARTIAL`, `WEAK`) avec des points de vigilance. Chaque rapport qui a utilisé
Bigdata.com est versé dans la base de connaissances, pour que la même question soit
gratuite la fois suivante.

## Dépendances

**Outils**

| Outil | Version | Pour |
| --- | --- | --- |
| Node.js | 22 (image `node:22-alpine`) | App, jobs, tests |
| npm | celui de Node 22 | Dépendances (`package.json`, `package-lock.json`) |
| Docker + buildx | récent (sur Mac : Docker Desktop ou `colima start --vm-type vz --vz-rosetta`) | Images de l'app et des jobs (`linux/amd64`), Postgres et Flyway en local |
| Terraform | ≥ 1.10 | Infrastructure (`infra*/`) |
| AWS CLI | v2 | Déploiements, jobs Batch à la main |
| Python | ≥ 3.11 avec `boto3` | `db/migrate.py` (migrations Flyway sur RDS) |

**Paquets npm** (`package.json`)

| Paquet | Usage |
| --- | --- |
| `pg` | PostgreSQL (app et jobs) |
| `yahoo-finance2` | Cours, profils, indicateurs, compositions de FNB, news Yahoo |
| `fast-xml-parser` | Lecture des flux RSS des médias |
| `@anthropic-ai/bedrock-sdk` | Claude sur Bedrock (agent conversationnel) |
| `@aws-sdk/client-bedrock-agent`, `@aws-sdk/client-bedrock-agentcore` | Base de connaissances et harness de recherche AgentCore |
| `@aws-sdk/client-comprehend` | Ton et entités des news |
| `@aws-sdk/client-sesv2` | Alertes par courriel |
| `@aws-sdk/client-s3`, `@aws-sdk/client-secrets-manager` | Rapports sur S3, mot de passe de la base |

L'interface (`app/public/`) n'utilise aucun framework ni aucune dépendance.

## Sources de données

Uniquement des données publiques, récupérées **à la demande** : l'app lit d'abord la
base, et n'appelle une source que si la donnée manque ou est périmée. Le jeu de
données de départ du cas n'est pas utilisé. Chaque valeur garde sa source et sa date.

| Source | Données | Accès | Où |
| --- | --- | --- | --- |
| **Yahoo Finance** (`yahoo-finance2`) | Cours quotidiens ajustés, profils, indicateurs, objectifs et notes d'analystes, compositions de FNB, taux de change (`USDCAD=X`), news par titre | Sans clé. Débit limité à 30 appels/min dans le job | `src/marketdata/providers/yahoo/` |
| **Finnhub** | News, résultats, recommandations (optionnel) | Clé gratuite `FINNHUB_API_KEY` (non configurée par défaut) | `src/marketdata/providers/finnhub/` |
| **Banque mondiale** | Indicateurs macroéconomiques annuels, avec leur provenance | API publique, sans clé | `src/marketdata/providers/worldbank/` |
| **companiesmarketcap.com** | Classement mondial des capitalisations (≈ 1 000 sociétés suivies) | CSV public | `src/marketdata/providers/companiesmarketcap/` |
| **CBC Business, Radio-Canada Économie, The Globe and Mail, MarketWatch** | Titres, extraits de 400 caractères au plus, liens, dans leur langue d'origine | Flux RSS publics. On ne garde que le titre, l'extrait et le lien vers l'éditeur | `src/marketdata/news/feeds.js` |
| **SEC EDGAR** | Communiqués de résultats (8-K, pièce 99.1), versés dans la base de connaissances de l'agent | Public | `agents/knowledge-base/` |
| **Bigdata.com** | Données financières premium pour l'agent de recherche | Clé dans Secrets Manager, crédits limités (≈ 9 appels/jour, partagés par l'équipe) | `app/research.js` |
| **Recherche web AgentCore** | Dernier recours de l'agent de recherche | Via AgentCore Gateway | `app/research.js` |

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
de même que `*.tfvars`, `*.tfstate` et `*.pem`.

| Fichier | Contenu |
| --- | --- |
| `.env-aws` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_DEFAULT_REGION=us-east-1` (jeton temporaire, à renouveler) |
| `.env-dev` | `TF_WORKSPACE=<ton nom>`, qui choisit ton environnement pour Terraform, les migrations et les scripts (copie de `.env-dev.example`) |

```bash
set -a; source .env-aws; source .env-dev; set +a
```

**Variables de l'app et des jobs.** Sur AWS, elles sont toutes posées
automatiquement : le serveur construit `DATABASE_URL` depuis RDS et Secrets Manager,
et Terraform remplit `/etc/chatbot.env` et la définition du job. En local, elles sont
toutes optionnelles.

| Variable | Défaut | Effet |
| --- | --- | --- |
| `PORT` | `3000` | Port HTTP de l'app |
| `DATABASE_URL` | non défini → fichier JSON | PostgreSQL. Sans elle, tout est stocké dans `app/data/db.json` |
| `DATA_FILE` | `app/data/db.json` | Fichier JSON du mode sans base |
| `AWS_REGION` | `us-east-1` | Région des SDK AWS |
| `AGENT_MODEL`, `AGENT_EFFORT` | `anthropic.claude-opus-5-5`, `low` | Modèle et effort de l'agent conversationnel |
| `RESEARCH_HARNESS_ARN`, `RESEARCH_REVIEWER_ARN`, `RESEARCH_KB_*`, `BIGDATA_DAILY_CALLS` | non définis → recherche désactivée | Agent de recherche AgentCore (ressources ci-dessous) |
| `REPORTS_BUCKET` | non défini → fichier JSON | Stockage des rapports sur S3 |
| `ALERTS_SENDER`, `SES_CONFIGURATION_SET`, `APP_URL` | non définis → alertes désactivées | Expéditeur SES vérifié, et liens dans les courriels |
| `FINNHUB_API_KEY` | non défini → étapes Finnhub ignorées | Données Finnhub dans les jobs |
| `REFRESH_ENABLED`, `NEWS_ENABLED` | activés (mise à jour désactivée en dev par Terraform) | Désactive le job de mise à jour ou celui des news |

Les principales variables Terraform (par environnement, sinon des valeurs par défaut
adaptées à la prod ou au dev) sont :
- `allowed_cidrs`, par défaut `132.207.0.0/16` (Polytechnique) ;
- `alerts_enabled` et `alerts_sender_email` ;
- `refresh_enabled`, `schedule_enabled` et `job_timeout_seconds` ;
- `confirm_prod`, obligatoire pour toucher à la prod.

Toutes les variables sont décrites dans le fichier `variables.tf` de chaque stack.

## Démarrage et reproduction

### 1. En local, sans AWS ni base (2 minutes)

```bash
npm install
npm start                      # http://localhost:3000, données dans app/data/db.json
```

Ce qui fonctionne : la connexion, le profil, un portefeuille aléatoire avec de
vrais cours Yahoo et la page Macro. Ce qui demande AWS ou une base : les vraies
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
npm test                                       # environ 125 tests ; ceux qui demandent une base sont sautés
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

**L'agent de recherche n'est pas encore dans Terraform.** Ses ressources ont été
créées à la main avec la CLI AWS, dans l'environnement `andre` et en prod :
- un bucket S3 privé et une base de connaissances Bedrock, avec sa source de données ;
- une AgentCore Gateway (authentification IAM), avec trois cibles : la base de
  connaissances, la recherche web, et Bigdata.com en MCP, limitée à 6 requêtes par
  minute, avec une clé lue dans Secrets Manager par AgentCore Identity ;
- deux harnesses, `research` et `reviewer` ;
- leurs rôles IAM.

L'app les trouve par les variables `RESEARCH_*`. Sur l'EC2, ces variables sont dans
`/etc/chatbot.env`, posées par SSM : il faut les remettre si l'instance est remplacée.

### 5. Mettre à jour un environnement

| Changement | Commande |
| --- | --- |
| Code de l'app (`app/`) | `./scripts/deploy-app.sh` (l'instance n'est pas recréée) |
| Code des jobs (`src/`) | `bash scripts/deploy-batch.sh` |
| Nouvelle migration | `python db/migrate.py info`, puis `python db/migrate.py` |
| Infrastructure | `terraform -chdir=<stack> plan`, puis `apply` |

Prod : `TF_WORKSPACE=default`, avec `-var confirm_prod=true` pour Terraform et
`--env prod` pour `migrate.py`. On n'y touche que sur demande, et toujours depuis `main`.
