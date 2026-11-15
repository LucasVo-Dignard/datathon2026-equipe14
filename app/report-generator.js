'use strict';
// ---------------------------------------------------------------------------
// Rédaction et enregistrement d'un rapport (onglet Rapports). Partagé par le
// bouton « Générer » (server.js, POST /api/reports) et par le job horaire des
// rapports programmés (jobs/scheduled-reports.js).
// ---------------------------------------------------------------------------

const crypto = require('node:crypto');
const reports = require('./reports');

class ReportError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function createReportGenerator({
  portfolios, profiles, stocks, reportStore, write, log = console, now = Date.now,
}) {
  // scheduledFor : échéance (ms) d'un rapport programmé, absent pour un rapport à la demande.
  async function generate(user, period, { scheduledFor } = {}) {
    if (!Object.hasOwn(reports.PERIODS, period)) throw new ReportError(400, 'Période invalide');
    const portfolio = await portfolios.get(user);
    if (!portfolio) throw new ReportError(409, 'Créez d’abord votre portefeuille (onglet Portefeuille)');
    const investorProfile = await profiles.get(user).then((p) => p?.result || null, (err) => {
      log.error('profile load error:', err.message);
      return null;
    });
    // Period reports: each stock's own move since the start of the period.
    const from = reports.periodFrom(portfolio, period);
    const changes = {};
    if (from) {
      await Promise.all(portfolio.holdings.filter((h) => h.available).map(async (h) => {
        changes[h.symbol] = await stocks.changeSince(h.symbol, from).catch((err) => {
          log.error(`report change error (${h.symbol}):`, err.message);
          return null;
        });
      }));
    }
    const brief = reports.buildBrief({ period, portfolio, profile: investorProfile, changes });
    const highlights = reports.highlights(reports.analyze({ period, portfolio, changes, profile: investorProfile }));
    let content;
    try {
      content = await write({ label: reports.PERIODS[period].label, brief });
    } catch (err) {
      log.error('report error:', err);
      throw new ReportError(502, "L'agent n'a pas pu rédiger le rapport, réessayez plus tard");
    }
    const entry = {
      id: crypto.randomUUID(),
      owner: user,
      period,
      title: reports.PERIODS[period].title,
      asOf: portfolio.asOf,
      createdAt: now(),
      ...(scheduledFor ? { scheduled: true, scheduledFor } : {}),
      highlights,
      content: String(content),
    };
    return reportStore.save(entry);
  }

  return { generate };
}

module.exports = { createReportGenerator, ReportError };
