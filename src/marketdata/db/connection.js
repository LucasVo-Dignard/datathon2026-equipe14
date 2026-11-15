'use strict';
// Open a PostgreSQL connection from environment variables.
//
// Two modes, so the same code runs locally and on AWS:
//
// - DATABASE_URL set (local Docker Postgres, see db/README.md, or the web
//   server's /run/chatbot/db.env, written by chatbot-db-env at startup, see
//   infra/user_data.sh.tftpl):
//       DATABASE_URL=postgres://bncd_admin:localdev@127.0.0.1:5432/marketdata
// - Otherwise DB_HOST, DB_PORT, DB_NAME and DB_SECRET_ARN (the AWS Batch job,
//   see infra-batch/). The user name and password are read from Secrets
//   Manager at runtime and never written anywhere. TLS is required.

const { ConfigurationError } = require('../errors');

async function readSecret(secretArn) {
  // Only needed on AWS.
  const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
  const client = new SecretsManagerClient({});
  try {
    const response = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
    return JSON.parse(response.SecretString);
  } finally {
    client.destroy();
  }
}

// pg connection options for this environment.
async function connectionConfig(env = process.env, { readSecret: read = readSecret, applicationName = 'marketdata' } = {}) {
  if (env.DATABASE_URL) return { connectionString: env.DATABASE_URL, application_name: applicationName };

  const missing = ['DB_HOST', 'DB_NAME', 'DB_SECRET_ARN'].filter((name) => !env[name]);
  if (missing.length) {
    throw new ConfigurationError(`set DATABASE_URL, or DB_HOST, DB_NAME and DB_SECRET_ARN (missing: ${missing.join(', ')})`);
  }
  const secret = await read(env.DB_SECRET_ARN);
  return {
    host: env.DB_HOST,
    port: Number(env.DB_PORT || 5432),
    database: env.DB_NAME,
    user: secret.username,
    password: secret.password,
    // RDS presents a certificate signed by the AWS CA, which Node doesn't
    // trust by default: encrypt, like libpq's sslmode=require.
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10_000,
    application_name: applicationName,
  };
}

// A connected pg Client. The caller must `await client.end()`.
async function connect(env = process.env, options = {}) {
  const { Client } = require('pg');
  const client = new Client(await connectionConfig(env, options));
  await client.connect();
  return client;
}

// Run `fn(db)` in a transaction: COMMIT if it resolves, ROLLBACK if it throws.
// `db` must be a single connection (a Client, or a client checked out of a Pool).
async function transaction(db, fn) {
  await db.query('BEGIN');
  try {
    const result = await fn(db);
    await db.query('COMMIT');
    return result;
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

module.exports = { connectionConfig, connect, transaction, readSecret };
