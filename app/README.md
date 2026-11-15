# Chatbot (prototype)

Node.js server: username-only login (no password, this is
a prototype), conversations per user. Profiles and conversations are stored in
Postgres when `DATABASE_URL` is set; users and login sessions (and everything,
without a database) are in a JSON file.

- `server.js`: API (`/api/login`, `/api/chats`, ...) and static files
- `bot.js`: **the agent**. Claude Opus 5.5 on Amazon Bedrock
  (`@anthropic-ai/bedrock-sdk`) writes the answers in Markdown from the
  conversation and the user's investor `profile`. For questions about a
  company it calls the `research_company` tool: `research.js` invokes the
  AgentCore research harness (earnings releases knowledge base, then web
  search), see `../agents/README.md`. Refusals fall back to Claude Opus 4.8.
  `AGENT_MODEL` / `AGENT_EFFORT` override the model and effort,
  `RESEARCH_HARNESS_ARN` enables the research. `report()` writes the simulated
  reports (see [Reports](#reports)).
- `reports.js`: the data sheet the agent writes a report from.
- `public/markdown.js`: safe Markdown renderer for the answers and reports (DOM nodes only, no HTML).
- `chat-store.js`: conversation history (see [Conversations](#conversations)).
- `profile.js`: investor profile. Guided questionnaire, risk scoring, matching with the
  case personas (Amira, Mateo, Robert), tensions and guardrails for the agents.
- `stocks.js`: quick view for the ticker search bar (`GET /api/stocks/:symbol`): name,
  exchange, currency, last close and day change. With `DATABASE_URL`, it reads
  `company_profiles` / `price_bars`. When the symbol is missing or older than an hour,
  it first loads it from Yahoo with `src/marketdata` and saves it: profile, metrics,
  price target, rating actions, and a year of daily prices on the first load
  (the last week afterwards). Without a database, it asks Yahoo and saves nothing.
  For an ETF it also returns its composition (`fund`, see [ETFs](#etfs)).
- `public/`: interface (HTML/CSS/JS). `profile-ui.js` is the questionnaire and result page.
- `portfolio.js` / `portfolio-store.js`: the user's simulated portfolio (see below).

Run locally:

```bash
npm install
npm run dev   # http://localhost:3000, loads AWS credentials from .env-aws,
              # data in app/data/db.json
```

Deployed to the EC2 by Terraform (see `../infra/README.md`).

On the EC2, the agent uses the instance role, which allows
`bedrock-mantle:CreateInference` (`infra/iam.tf`).

## Investor profile

On first login the user is guided through 17 questions (situation, objectives,
risk, preferences), or can start from one of the three case personas and adjust
the prefilled answers. The result page explains the outcome.

- **Risk level** = min(tolerance, capacity), capped by the objective.
  Tolerance is what the user is willing to bear (reaction to a 20 % drop, max
  loss, stability vs growth). Capacity is what their situation allows (age,
  dependents, share of savings, experience, horizon ×2). A preservation or
  near-term-purchase objective caps the score. Five levels: Faible → Élevé.
- **Tensions**: conflicts between answers, flagged as warnings or info, e.g. a
  low-risk profile attracted to hyped stocks (Robert), crypto interest on a
  cautious profile, or a concentrated portfolio on a high-risk profile (Amira).
- **Guardrails** for the agents: max volatility, max crypto share, max single
  sector share, minimum number of assets, ESG exclusions.
- **Closest persona** with a similarity score.

API (logged-in user): `GET /api/profile/questionnaire`, `GET /api/profile`,
`PUT /api/profile { answers }`.

### Storage

`profile-store.js` is the only file that reads or writes profiles:

- **`DATABASE_URL` set** → Postgres, table `investor_profiles`. The table is created
  by the Flyway migration `db/migrations/V4__create_investor_profiles.sql` (see
  `db/README.md`), not by the app. If it is missing, the server refuses to start.
  Needs the `pg` package (`npm install`).
- **not set** → the prototype JSON file (`db.users[username].profile`), so the app
  still runs without a database.

```bash
DATABASE_URL=postgres://bncd_admin:localdev@127.0.0.1:5432/marketdata npm start   # local docker compose DB
```

Never commit a real URL: it contains the password (RDS keeps it in Secrets Manager).
On the EC2, nothing to set by hand: before each start, `chatbot-db-env` (in
`infra/user_data.sh.tftpl`) builds `DATABASE_URL` for that environment's RDS from
its endpoint and Secrets Manager, with `sslmode=verify-full` and the RDS root
certificates shipped in the image. If the environment has no database yet, the
app uses the JSON file. Users and sessions are still in the JSON file
(login prototype). Once a SQL `users` table exists, add the foreign key in a new migration.
All thresholds are prototype assumptions, for simulation only, not financial advice.

## Conversations

`chat-store.js` is the only file that reads or writes conversations, with the same
rule as profiles:

- **`DATABASE_URL` set** → Postgres: `chats` (id, owner, title, dates) and
  `chat_messages` (one row per message, deleted with their chat). Created by
  `db/migrations/V9__create_chats.sql`; the server refuses to start if they are missing.
  The question and the agent's answer are saved together, once the answer is known.
- **not set** → the prototype JSON file (`db.chats`).

Conversations already in an environment's JSON file are not copied to the database.

Tests: `npm test` (from the repo root). To also test Postgres against a **throwaway**
database (the test drops the table): `TEST_DATABASE_URL=postgres://... npm test`.

## Portfolio

The first time the user opens the Portefeuille tab, they choose how to start:

- **Random**: 8 symbols picked at random from `tracked_symbols` (those that already
  have prices in `price_bars` first, CAD/USD preferred), each worth about
  1 500–8 000 $, with a simulated purchase cost (25 % below to 20 % above the
  current price) and some cash. Without a database, it picks from the V3 starter list.
- **Custom**: an empty portfolio. The user adds symbols with a quantity below the
  "Mes actions" table; the purchase cost is the current price.

The ✎ button on each row of "Mes actions" changes the quantity (or removes the stock).
Positions are valued with the latest known price (`stocks.js`), converted to CAD with
Yahoo exchange rates (`USDCAD=X`, ...). Performance history and news are still fictional.

API (logged-in user): `GET /api/portfolio` (`null` until the user has chosen),
`POST /api/portfolio { mode: 'random' | 'custom' }`,
`PUT /api/portfolio/holdings/:symbol { quantity }` (add or edit),
`DELETE /api/portfolio/holdings/:symbol`.

Storage works like profiles: with `DATABASE_URL`, tables `portfolios` and
`portfolio_holdings` (migration `V7__create_portfolios.sql`, the server refuses to
start without it). Otherwise `db.users[username].portfolio` in the JSON file.

## ETFs

A holding can be an ETF (or a mutual fund): add it like a stock (`XEQT.TO`, `QQQ`...).
Its composition comes from the same Yahoo quote summary as the profile (modules
`quoteType`, `fundProfile`, `topHoldings`): sector weights, top holdings, and the
stock / bond / cash split. `stocks.fund(symbol)` returns it (null for a stock); with
`DATABASE_URL` it is stored in `fund_compositions` (migration V10, one row per
looked-up symbol, funds or not) and fetched again after a week; the daily refresh
also saves it (step `yahoo.fund_composition`). Without the table it asks Yahoo and
saves nothing.

- Portfolio: each holding has `fund` (composition or null); "Mes actions" shows an
  FNB tag, and the quick view lists the ETF's main sectors and holdings.
- Reports: sector exposure looks through ETFs (weight × the fund's sector weights).
  ETFs have no published country split, so they get their own region line instead of
  being guessed from the listing (`XEQT.TO` is global).
- Preferences: in the profile's sector question, one click marks a sector of interest,
  a second click a sector to avoid (`avoidSectors`, guardrail `avoidedSectors`), a
  third clears it. The report flags holdings at odds with the profile
  (`reports.preferenceFlags`): stocks in an avoided sector, and ETFs where an avoided
  sector weighs 10 % or more of the fund. Excluded activities count too: fossil fuels by
  the Energy sector, weapons and tobacco by keywords in the fund's name, category or top
  holdings. The flags get their own report section and a "Hors de vos préférences" tile.

## Reports

The Rapports tab simulates the report the client would receive: Quotidien,
Hebdomadaire, Mensuel or Annuel. `reports.js` builds a data sheet for the period
with **percentages and dates only** (no amounts, prices or quantities, so the
report can't quote any): performance over the period from the portfolio history,
high and low, gain since purchase, cash share, each holding's weight and its own
price move over the period (`stocks.changeSince`: stored bars, else Yahoo) with
its contribution; the last session only for a daily report. Also
**regional exposure** (issuer country and region, and currency, cash counted in
CAD), sector exposure, news about the client's stocks or sectors published
during the period, and the investor profile with its guardrails. The issuer
country comes from `company_profiles.country` (Yahoo); when it's missing it is
guessed from the listing (`.TO` → Canada, plain USD symbol → United States, ...)
and the sheet says so. `bot.report()` asks the agent to write the report from
it in Markdown, rendered with `public/markdown.js`. The history and news are
still fictional, so the report is too.

API (logged-in user): `GET /api/reports` (newest first),
`POST /api/reports { period: 'daily' | 'weekly' | 'monthly' | 'yearly' }` (409 until
the user has a portfolio), `DELETE /api/reports/:id`.

Storage (`reports-store.js`, last 20 reports per user):

- **`REPORTS_BUCKET` set** → private S3 bucket (`infra/reports.tf`), one JSON object
  per report at `reports/<username>/<id>.json`. On the EC2, `scripts/deploy-app.sh`
  writes `REPORTS_BUCKET` into `/etc/chatbot.env` from the Terraform output.
- **not set** → the prototype JSON file (`db.reports`), like conversations.

## Price alerts by email

`notifications.js` (API `/api/notifications`, card on the profile page) and the
daily job `src/marketdata/jobs/price-alerts.js` (run after `daily-refresh.js`)
email users when a stock **in their portfolio** moves by their threshold or more
in one trading day. The threshold follows the risk level (2 % Faible … 7 % Élevé,
4 % without a profile). Thresholds and the email format are shared in
`src/marketdata/alerts.js`. Sent with Amazon SES (see `infra/README.md`); tables
`notification_subscriptions` and `price_alerts_sent` (migration V8). Needs
Postgres and `ALERTS_SENDER`, otherwise the card says alerts are unavailable.

