'use strict';
// ---------------------------------------------------------------------------
// Rapports programmés : validation, description en français et calcul des
// échéances. Sans dépendance : utilisé par l'app (bot.js, server.js) et par le
// job horaire (jobs/scheduled-reports.js).
//
// Un horaire a la forme { period, weekday, day, month, hour, timezone } :
//   daily   -> du lundi au vendredi à `hour` (pas de séance la fin de semaine)
//   weekly  -> chaque `weekday` (1 = lundi ... 7 = dimanche) à `hour`
//   monthly -> le `day` (1 à 28) de chaque mois à `hour`
//   yearly  -> le `day` du mois `month` (1 à 12) à `hour`
// Les heures sont celles de `timezone` (America/Toronto, heure de l'Est).
// ---------------------------------------------------------------------------

const PERIODS = ['daily', 'weekly', 'monthly', 'yearly'];
const TIMEZONE = 'America/Toronto';
const WEEKDAYS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet',
  'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const DAY_MS = 86400e3;

class ScheduleError extends Error {}

function int(value, min, max, field) {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (!Number.isInteger(n) || n < min || n > max) throw new ScheduleError(`${field} : entier de ${min} à ${max} attendu`);
  return n;
}

// Liste complète des rapports voulus (remplace la précédente). [] = aucun rapport.
function validate(list) {
  if (!Array.isArray(list)) throw new ScheduleError('Liste de rapports attendue');
  const seen = new Set();
  return list.map((raw) => {
    if (!raw || typeof raw !== 'object') throw new ScheduleError('Rapport invalide');
    const { period } = raw;
    if (!PERIODS.includes(period)) throw new ScheduleError(`Période invalide : ${period}`);
    if (seen.has(period)) throw new ScheduleError(`Période en double : ${period}`);
    seen.add(period);
    return {
      period,
      weekday: period === 'weekly' ? int(raw.weekday, 1, 7, 'weekday') : null,
      day: period === 'monthly' || period === 'yearly' ? int(raw.day, 1, 28, 'day') : null,
      month: period === 'yearly' ? int(raw.month, 1, 12, 'month') : null,
      hour: int(raw.hour, 0, 23, 'hour'),
      timezone: TIMEZONE,
    };
  }).sort((a, b) => PERIODS.indexOf(a.period) - PERIODS.indexOf(b.period));
}

const dayLabel = (d) => (d === 1 ? '1er' : String(d));

function describe(s) {
  const at = `à ${s.hour} h`;
  switch (s.period) {
    case 'daily': return `Rapport quotidien, du lundi au vendredi ${at}`;
    case 'weekly': return `Rapport hebdomadaire, chaque ${WEEKDAYS[s.weekday - 1]} ${at}`;
    case 'monthly': return `Rapport mensuel, le ${dayLabel(s.day)} de chaque mois ${at}`;
    case 'yearly': return `Rapport annuel, le ${dayLabel(s.day)} ${MONTHS[s.month - 1]} de chaque année ${at}`;
    default: return s.period;
  }
}

// --- Échéances ------------------------------------------------------------------

// "Heure murale" de `ms` dans `tz`, exprimée comme si c'était de l'UTC.
function wallMs(ms, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms));
  const p = Object.fromEntries(parts.map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

// Instant UTC de l'heure murale `wall` (ms "comme UTC") dans `tz`.
function zonedToUtc(wall, tz) {
  let t = wall;
  for (let i = 0; i < 3; i++) t += wall - wallMs(t, tz);
  return t;
}

// Dernière échéance de l'horaire à `now` ou avant (instant UTC, en ms).
function lastOccurrence(s, now = Date.now()) {
  const tz = s.timezone || TIMEZONE;
  const nowWall = wallMs(now, tz);
  const today = new Date(Math.floor(nowWall / DAY_MS) * DAY_MS);
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  const at = (date) => date + s.hour * 3600e3;
  let wall;
  if (s.period === 'daily') {
    let d = today.getTime();
    const weekend = (t) => [0, 6].includes(new Date(t).getUTCDay());
    while (weekend(d) || at(d) > nowWall) d -= DAY_MS;
    wall = at(d);
  } else if (s.period === 'weekly') {
    const iso = today.getUTCDay() || 7;
    let d = today.getTime() - ((iso - s.weekday + 7) % 7) * DAY_MS;
    if (at(d) > nowWall) d -= 7 * DAY_MS;
    wall = at(d);
  } else if (s.period === 'monthly') {
    wall = at(Date.UTC(y, m, s.day));
    if (wall > nowWall) wall = at(Date.UTC(y, m - 1, s.day));
  } else if (s.period === 'yearly') {
    wall = at(Date.UTC(y, s.month - 1, s.day));
    if (wall > nowWall) wall = at(Date.UTC(y - 1, s.month - 1, s.day));
  } else {
    throw new ScheduleError(`Période invalide : ${s.period}`);
  }
  return zonedToUtc(wall, tz);
}

// Échéance à traiter, ou null. Une échéance passée avant la création ou la
// dernière modification de l'horaire ne compte pas ; si le job a manqué
// plusieurs échéances, un seul rapport est écrit (le plus récent).
function dueAt(s, now = Date.now()) {
  const occurrence = lastOccurrence(s, now);
  const since = Math.max(s.lastRunAt || 0, s.updatedAt || s.createdAt || 0);
  return occurrence > since ? occurrence : null;
}

module.exports = {
  PERIODS, TIMEZONE, WEEKDAYS, ScheduleError, validate, describe, lastOccurrence, dueAt, zonedToUtc, wallMs,
};
