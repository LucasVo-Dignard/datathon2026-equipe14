'use strict';
// ---------------------------------------------------------------------------
// Stockage des portefeuilles simulés.
//
//   - DATABASE_URL défini -> Postgres (tables portfolios / portfolio_holdings,
//                            migration Flyway db/migrations/V7__create_portfolios.sql)
//   - sinon               -> fichier JSON du prototype (db.users[username].portfolio)
//
// Un portefeuille stocké a la forme
//   { source: 'random' | 'custom', cash, createdAt, holdings: [{ symbol, quantity, avgCost }] }
// avgCost est dans la devise du titre. null = l'utilisateur n'a pas encore choisi.
// ---------------------------------------------------------------------------

function createJsonStore({ db, saveDb }) {
  const portfolioOf = (username) => db.users[username]?.portfolio || null;

  return {
    kind: 'json',
    async init() {},
    async get(username) {
      const p = portfolioOf(username);
      return p && structuredClone(p);
    },
    async create(username, { source, cash, holdings }) {
      const portfolio = { source, cash, createdAt: Date.now(), holdings: holdings.map(({ symbol, quantity, avgCost }) => ({ symbol, quantity, avgCost })) };
      db.users[username] = { ...db.users[username], portfolio };
      saveDb();
      return structuredClone(portfolio);
    },
    // Ajoute le titre (avec avgCost) ou change seulement sa quantité s'il est déjà là.
    async setHolding(username, { symbol, quantity, avgCost }) {
      const p = portfolioOf(username);
      if (!p) throw new Error(`no portfolio for ${username}`);
      const existing = p.holdings.find((h) => h.symbol === symbol);
      if (existing) existing.quantity = quantity;
      else p.holdings.push({ symbol, quantity, avgCost });
      saveDb();
    },
    async removeHolding(username, symbol) {
      const p = portfolioOf(username);
      if (!p) return;
      p.holdings = p.holdings.filter((h) => h.symbol !== symbol);
      saveDb();
    },
    async close() {},
  };
}

function createPgStore({ connectionString }) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString, max: 5 });
  pool.on('error', (err) => console.error('postgres pool error (portfolios):', err.message));

  return {
    kind: 'postgres',
    async init() {
      const { rows } = await pool.query(
        "SELECT to_regclass('portfolios') AS p, to_regclass('portfolio_holdings') AS h");
      if (!rows[0].p || !rows[0].h) {
        throw new Error('tables portfolios / portfolio_holdings absentes : appliquez les migrations Flyway (voir db/README.md)');
      }
    },
    async get(username) {
      const { rows: [p] } = await pool.query(
        'SELECT source, cash::float8 AS cash, created_at FROM portfolios WHERE username = $1', [username]);
      if (!p) return null;
      const { rows } = await pool.query(
        `SELECT symbol, quantity::float8 AS quantity, avg_cost::float8 AS avg_cost
           FROM portfolio_holdings WHERE username = $1 ORDER BY added_at, symbol`, [username]);
      return {
        source: p.source,
        cash: p.cash,
        createdAt: p.created_at.getTime(),
        holdings: rows.map((r) => ({ symbol: r.symbol, quantity: r.quantity, avgCost: r.avg_cost })),
      };
    },
    // Remplace le portefeuille (et ses titres) de l'utilisateur.
    async create(username, { source, cash, holdings }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM portfolios WHERE username = $1', [username]);
        await client.query('INSERT INTO portfolios (username, source, cash) VALUES ($1, $2, $3)', [username, source, cash]);
        for (const h of holdings) {
          await client.query(
            'INSERT INTO portfolio_holdings (username, symbol, quantity, avg_cost) VALUES ($1, $2, $3, $4)',
            [username, h.symbol, h.quantity, h.avgCost]);
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
      return this.get(username);
    },
    async setHolding(username, { symbol, quantity, avgCost }) {
      await pool.query(
        `INSERT INTO portfolio_holdings (username, symbol, quantity, avg_cost) VALUES ($1, $2, $3, $4)
         ON CONFLICT (username, symbol) DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = now()`,
        [username, symbol, quantity, avgCost]);
    },
    async removeHolding(username, symbol) {
      await pool.query('DELETE FROM portfolio_holdings WHERE username = $1 AND symbol = $2', [username, symbol]);
    },
    async close() {
      await pool.end();
    },
  };
}

function createPortfolioStore({ db, saveDb, connectionString = process.env.DATABASE_URL }) {
  return connectionString ? createPgStore({ connectionString }) : createJsonStore({ db, saveDb });
}

module.exports = { createPortfolioStore };
