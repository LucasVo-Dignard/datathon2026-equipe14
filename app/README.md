# Chatbot (prototype)

Node.js server: username-only login (no password, this is
a prototype), conversations per user. Profiles and conversations are stored in
Postgres when `DATABASE_URL` is set; users and login sessions (and everything,
without a database) are in a JSON file.

- `server.js`: API (`/api/login`, `/api/chats`, ...) and static files
- `bot.js`: **the agent**. Basic version: Claude Opus 5.5 on Amazon Bedrock
  (`@anthropic-ai/bedrock-sdk`), no tools or search, replies from the
  conversation history and the user's investor `profile` (summary added to the
  system prompt). Refusals fall back to Claude Opus 4.8.
  `AGENT_MODEL` / `AGENT_EFFORT` env vars override the model and effort.
- `chat-store.js`: conversation history (see [Conversations](#conversations)).
- `profile.js`: investor profile. Guided questionnaire, risk scoring, matching with the
  case personas (Amira, Mateo, Robert), tensions and guardrails for the agents.
- `stocks.js`: quick view for the ticker search bar (`GET /api/stocks/:symbol`): name,
  exchange, currency, last close and day change. With `DATABASE_URL`, it reads
  `company_profiles` / `price_bars`. When the symbol is missing or older than an hour,
  it first loads it from Yahoo with `src/marketdata` and saves it: profile, metrics,
  price target, rating actions, and a year of daily prices on the first load
  (the last week afterwards). Without a database, it asks Yahoo and saves nothing.
- `public/`: interface (HTML/CSS/JS). `profile-ui.js` is the questionnaire and result page.

Run locally:

```bash
npm install
npm run dev   # http://localhost:3000, loads AWS credentials from .env-aws,
              # data in app/data/db.json
```

Deployed to the EC2 by Terraform (see `../infra/README.md`).

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
  `db/migrations/V5__create_chats.sql`; the server refuses to start if they are missing.
  The question and the agent's answer are saved together, once the answer is known.
- **not set** → the prototype JSON file (`db.chats`).

Conversations already in an environment's JSON file are not copied to the database.

Tests: `npm test` (from the repo root). To also test Postgres against a **throwaway**
database (the test drops the table): `TEST_DATABASE_URL=postgres://... npm test`.

On the EC2, the Docker image installs the SDK (`npm ci`), but the instance role
still needs `bedrock-mantle:CreateInference` (see `infra/iam.tf`): until then
the agent answers with an error message.
