# CourtIAge Direct (prototype)

Node.js web app that helps a client follow their investments: tabs **Portefeuille**,
**Mon profil** and **Rapports**, plus an assistant panel (the chatbot). Username-only
login (no password, this is a prototype), conversations per user. Users, login
sessions, profiles, portfolios, conversations and report schedules are stored in
Postgres when `DATABASE_URL` is set, otherwise in a JSON file (see [Storage](#storage)).

- `server.js`: API (`/api/login`, `/api/chats`, ...) and static files
- `session-store.js`: users and login sessions
- `bot.js`: **the agent**. Claude Opus 5.5 on Amazon Bedrock
  (`@anthropic-ai/bedrock-sdk`) writes the answers in Markdown from the
  conversation, the user's investor `profile` and portfolio. Its tools:
  - `research_company`: `research.js` invokes the AgentCore research harness
    (earnings releases knowledge base, then Bigdata.com, then web search), see
    `../agents/README.md`. For a judgment question (should I buy, sell, switch...),
    a reviewer harness peer-reviews the data (`RESEARCH_REVIEWER_ARN`);
  - `find_similar_companies` (`peers.js`, needs the database);
  - `get_portfolio_details` (`portfolio-context.js`);
  - `set_report_schedule` (see [Scheduled reports](#scheduled-reports)).

  Refusals fall back to Claude Opus 4.8. `report()` writes the reports (see
  [Reports](#reports)).
- `reports.js`: the data sheet the agent writes a report from.
- `public/markdown.js`: safe Markdown renderer for the answers and reports (DOM nodes only, no HTML).
- `chat-store.js`: conversation history (see [Conversations](#conversations)).
- `profile.js`: investor profile. Guided questionnaire, risk scoring, matching with the
  case personas (Amira, Mateo, Robert), tensions and guardrails for the agents.
- `stocks.js`: market-data access for the app: quick view for the ticker search bar
  (`GET /api/stocks/:symbol`: name, exchange, currency, last close and day change),
  portfolio pricing, random picks, price change since a date (`changeSince`) and ETF
  compositions. With `DATABASE_URL`, it reads `company_profiles` / `price_bars`. When
  the symbol is missing or older than an hour, it first loads it from Yahoo with
  `src/marketdata` and saves it: profile, metrics, price target, rating actions, fund
  composition, and a year of daily prices on the first load (the last week afterwards).
  Without a database, it asks Yahoo and saves nothing. For an ETF it also returns its
  composition (`fund`, see [ETFs](#etfs)).
- `news.js`: real news (see [Portfolio](#portfolio)).
- `portfolio.js` / `portfolio-store.js`: the user's simulated portfolio (see below).
- `report-generator.js`, `report-schedule.js`, `report-schedule-store.js`,
  `jobs/scheduled-reports.js`: reports on demand and scheduled reports.
- `notifications.js`: price alerts by email (see [Price alerts](#price-alerts-by-email)).
- `public/`: interface (HTML/CSS/JS): `index.html`, `style.css`, `app.js` (login,
  tabs, assistant), `dashboard.js` (Portefeuille), `profile-ui.js` (questionnaire and
  result page), `notifications-ui.js`, `reports.js` (Rapports), `stock-search.js`,
  `markdown.js`, `intro.js`, `manifest.webmanifest`, `icon.svg`. `server.js` only
  serves the files in its fixed `STATIC` list: a new public file returns 404 until it
  is added there.

Run locally, from the repo root:

```bash
npm install
npm run dev   # http://localhost:3000, loads .env-aws (AWS credentials) and .env-dev,
              # data in app/data/db.json
```

Deployed to the EC2 by Terraform (see `../infra/README.md`).

On the EC2, the agent uses the instance role: Bedrock inference
(`bedrock-mantle:CreateInference`), the research harnesses and gateway, the knowledge
base (see `infra/iam.tf`), plus the reports bucket (`infra/reports.tf`) and SES
(`infra/ses.tf`).

Agent settings (environment variables):

- `AGENT_MODEL` (default `anthropic.claude-opus-5-5`), `AGENT_EFFORT` (default `low`).
- Research (top of `research.js`): `RESEARCH_HARNESS_ARN` (unset = no research),
  `RESEARCH_REVIEWER_ARN` (peer review, unset = none), `RESEARCH_KB_BUCKET`, `RESEARCH_KB_ID`,
  `RESEARCH_KB_DATA_SOURCE_ID` (where reports are saved), `RESEARCH_GATEWAY_URL` (daily market snapshot).

## Chat API

Logged-in user: `GET /api/chats`, `POST /api/chats`, `GET` / `PATCH { title }` /
`DELETE /api/chats/:id`, and `POST /api/chats/:id/messages { content }`, which returns
`{ messages, chat }`. With `Accept: application/x-ndjson`, the answer is streamed as
JSON lines instead: `{"type":"progress", id, label, status, detail}` for each step of
the agents, then `{"type":"done", messages, chat}` (or `{"type":"error", error}`).
Also `POST /api/login { username }`, `POST /api/logout`, `GET /api/me`.

## Investor profile

On first login the user is guided through the questionnaire (situation, objectives,
risk, preferences such as sectors and regions), or clicks one of the three case
personas, which creates the profile directly from its answers (they can be edited
afterwards). The result page explains the outcome.

- **Risk level** = min(tolerance, capacity), capped by the objective.
  Tolerance is what the user is willing to bear (reaction to a 20 % drop, max
  loss, stability vs growth). Capacity is what their situation allows (age,
  dependents, share of savings, experience, horizon ×2). A preservation or
  near-term-purchase objective caps the score. Five levels: Faible → Élevé.
- **Tensions**: conflicts between answers, flagged as warnings or info, e.g. a
  low-risk profile attracted to hyped stocks (Robert), crypto interest on a
  cautious profile, or a concentrated portfolio on a high-risk profile (Amira).
- **Guardrails** for the agents: max volatility, max crypto share, max single
  sector share, minimum number of assets, ESG exclusions, avoided sectors, regions.
- **Closest persona** with a similarity score.

API (logged-in user): `GET /api/profile/questionnaire`, `GET /api/profile`,
`PUT /api/profile { answers }`.

All thresholds are prototype assumptions, for simulation only, not financial advice.

## Storage

Each kind of data has one store file, and only that file reads or writes it:

| Store | Postgres tables (migration) | JSON file |
|---|---|---|
| `session-store.js` | `users`, `sessions` (V12) | `db.users`, `db.sessions` |
| `profile-store.js` | `investor_profiles` (V4) | `db.users[username].profile` |
| `portfolio-store.js` | `portfolios`, `portfolio_holdings` (V7) | `db.users[username].portfolio` |
| `chat-store.js` | `chats`, `chat_messages` (V9) | `db.chats` |
| `report-schedule-store.js` | `report_preferences`, `report_schedules` (V13) | `db.reportSchedules` |

- **`DATABASE_URL` set** → Postgres. The tables are created by the Flyway migrations
  in `db/migrations` (see `db/README.md`), not by the app. If one is missing (V13
  included), the server refuses to start. Needs the `pg` package (`npm install`).
  Since V12, `investor_profiles`, `portfolios`, `notification_subscriptions` and
  `chats` have a foreign key to `users`. Sessions expire after 30 days, like the cookie.
- **not set** → the prototype JSON file (`app/data/db.json`, or `DATA_FILE`), so the
  app still runs without a database.

Reports are separate: S3 with `REPORTS_BUCKET`, otherwise the JSON file (see [Reports](#reports)).

On each start with Postgres, if the JSON file still has users, sessions or
conversations, the server copies them into the database (`json-import.js`, along with
profiles and portfolios saved before the environment had a database), keeps a copy of
the file as `db.json.imported-<timestamp>`, then removes them from the file. Rows
already in the database are kept (for users, only the earliest creation date is
kept). Users stay logged in and keep their conversations. Report schedules
(`db.reportSchedules`) are not imported.

```bash
DATABASE_URL=postgres://bncd_admin:localdev@127.0.0.1:5432/marketdata npm start   # local docker compose DB
```

Never commit a real URL: it contains the password (RDS keeps it in Secrets Manager).
On the EC2, nothing to set by hand: before each start, `chatbot-db-env` (in
`infra/user_data.sh.tftpl`) builds `DATABASE_URL` for that environment's RDS from
its endpoint and Secrets Manager, with `sslmode=verify-full` and the RDS root
certificates shipped in the image. If the environment has no database yet, the
app uses the JSON file.

## Conversations

The question and the agent's answer are saved together, once the answer is known.

## Portfolio

The first time the user opens the Portefeuille tab, they choose how to start:

- **Random**: 6 stocks drawn purely at random from all active `tracked_symbols` (any
  region), each worth about 1 500–8 000 $, plus 2 well-known ETFs (`RANDOM_ETFS` in
  `stocks.js`) of about 4 000–12 000 $, with a simulated purchase cost (25 % below to
  20 % above the current price) and some cash. One batch Yahoo request (`quote` on all
  the candidates) drops symbols without a price; the others are loaded on valuation and
  then kept. Without a database, stocks come from the V3 starter list.
- **Custom**: an empty portfolio. The user adds symbols with a quantity below the
  "Mes titres" table; the purchase cost is the current price.

The ✎ button on each row of "Mes titres" changes the quantity (or removes the stock).
Positions are valued with the latest known price (`stocks.js`), converted to CAD with
Yahoo exchange rates (`USDCAD=X`, ...). Only the performance history is fictional.
News are real with `DATABASE_URL`: `news.js` reads `news_items` (migration V10, filled
by `src/marketdata/jobs/news-refresh.js`), first the articles about the holdings, then
general news useful to an investor. Without a database, the portfolio shows sample news.

API (logged-in user): `GET /api/portfolio` (`null` until the user has chosen),
`POST /api/portfolio { mode: 'random' | 'custom' }`,
`PUT /api/portfolio/holdings/:symbol { quantity }` (add or edit),
`DELETE /api/portfolio/holdings/:symbol`.

Storage: see [Storage](#storage).

## ETFs

A holding can be an ETF (or a mutual fund): add it like a stock (`XEQT.TO`, `QQQ`...).
Its composition comes from the same Yahoo quote summary as the profile (modules
`quoteType`, `fundProfile`, `topHoldings`): sector weights, top holdings, and the
stock / bond / cash split. `stocks.fund(symbol)` returns it (null for a stock); with
`DATABASE_URL` it is stored in `fund_compositions` (migration V11, one row per
looked-up symbol, funds or not) and fetched again after a week; the daily refresh
also saves it (step `yahoo.fund_composition`). If the table can't be read, it asks
Yahoo and saves nothing.

- Portfolio: each holding has `fund` (composition or null); "Mes titres" shows an
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

The Rapports tab shows the reports the client receives: Quotidien, Hebdomadaire,
Mensuel or Annuel, on demand ("Générer") or scheduled. `reports.js` builds a data
sheet for the period with **percentages and dates only** (no amounts, prices or
quantities, so the report can't quote any): performance over the period from the
portfolio history, high and low, gain since purchase, cash share, each holding's
weight and its own price move over the period (`stocks.changeSince`: stored bars,
else Yahoo) with its contribution; the last session only for a daily report. Also
**regional exposure** (issuer country and region, and currency, cash counted in
CAD), sector exposure, news about the client's stocks or sectors published
during the period, and the investor profile with its guardrails. The issuer
country comes from `company_profiles.country` (Yahoo); when it's missing it is
guessed from the listing (`.TO` → Canada, plain USD symbol → United States, ...)
and the sheet says so. `report-generator.js` asks the agent (`bot.report()`) to
write the report from it in Markdown, rendered with `public/markdown.js`, and saves
it with its key-figure tiles (`highlights`). The performance history is fictional,
so the performance figures are too; with a database, the stock moves and news are real.

API (logged-in user): `GET /api/reports` (newest first),
`POST /api/reports { period: 'daily' | 'weekly' | 'monthly' | 'yearly' }` (409 until
the user has a portfolio), `DELETE /api/reports/:id`.

Storage (`reports-store.js`, last 20 reports per user):

- **`REPORTS_BUCKET` set** → private S3 bucket (`infra/reports.tf`), one JSON object
  per report at `reports/<username>/<id>.json`. On the EC2, `scripts/deploy-app.sh`
  writes `REPORTS_BUCKET` and the `RESEARCH_*` settings into `/etc/chatbot.env`
  (from the Terraform output and the AWS account).
- **not set** → the prototype JSON file (`db.reports`).

## Scheduled reports

The client sets them up with the assistant (e.g. "Configurer les notifications"): it
asks which reports and when, then calls the `set_report_schedule` tool (`bot.js`),
which replaces the whole list.

- Rules (`report-schedule.js`): hours in Eastern time (America/Toronto), on the hour;
  daily = Monday to Friday, weekly on a weekday, monthly on a day from 1 to 28, yearly
  on a month and day. At most one schedule per period.
- Storage (`report-schedule-store.js`): Postgres tables `report_preferences` and
  `report_schedules` (V13), or `db.reportSchedules` in the JSON file. In JSON mode the
  schedules are saved but **never run** (the job reads Postgres only).
- API (logged-in user): `GET /api/report-schedule`, `DELETE /api/report-schedule`
  (stops them all).
- Job `jobs/scheduled-reports.js`, every hour on AWS Batch (`infra-batch/`): writes each
  due report like the "Générer" button and saves it in the reports bucket. Each
  occurrence is claimed in the database first, so it is never written twice; a failed
  report is retried next hour. Needs `REPORTS_BUCKET`; `--dry-run` lists the due
  reports, `--now <ISO date>` simulates another time.
- In the interface, an unseen scheduled report shows a "Nouveau" badge on the Rapports
  tab and a notice in the assistant panel, with a `#rapport/<id>` link that opens it.

## Price alerts by email

`notifications.js` (API `/api/notifications`, `POST /api/notifications/test` for a
test email, card on the profile page) and `src/marketdata/jobs/price-alerts.js` email
users when a stock **in their portfolio** moves by their threshold or more in one
trading day. The alerts are sent from inside the daily `daily-refresh.js`, right after
the subscribers' holdings are refreshed (before the rest of the symbols). The
threshold follows the risk level (2 % Faible … 7 % Élevé, 4 % without a profile).
Thresholds and the email format are shared in `src/marketdata/alerts.js`. Sent with
Amazon SES (see `infra/README.md`); tables `notification_subscriptions` and
`price_alerts_sent` (migration V8). Needs Postgres and `ALERTS_SENDER`, otherwise the
card says alerts are unavailable; `APP_URL` (links in the email) and
`SES_CONFIGURATION_SET` are optional.

- Every email has a one-click unsubscribe link to the public page `/desabonnement`
  (no login).
- SES sandbox: while the account has no production access, SES only sends to verified
  addresses, so on subscription the app asks SES to verify the address and the
  subscription stays pending until the user clicks the AWS link.

## Tests

`npm test` (from the repo root). To also test Postgres, point `TEST_DATABASE_URL` at a
**throwaway** database with all the migrations applied (the tests delete rows, and
drop and recreate some tables), and run the files one at a time:
`TEST_DATABASE_URL=postgres://... npm test -- --test-concurrency=1`.
