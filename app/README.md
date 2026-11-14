# Chatbot (prototype)

Node.js server with no dependencies: username-only login (no password, this is
a prototype), conversations per user, data in a JSON file.

- `server.js`: API (`/api/login`, `/api/chats`, ...) and static files
- `bot.js`: **where the agents plug in**. Replace `reply()` with a call to your agents.
  It receives the user's investor `profile` (or `null`).
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
node app/server.js   # http://localhost:3000, data in app/data/db.json
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
For RDS, append `?sslmode=require`. Users and sessions are still in the JSON file
(login prototype). Once a SQL `users` table exists, add the foreign key in a new migration.
All thresholds are prototype assumptions, for simulation only, not financial advice.

Tests: `npm test` (from the repo root). To also test Postgres against a **throwaway**
database (the test drops the table): `TEST_DATABASE_URL=postgres://... npm test`.
