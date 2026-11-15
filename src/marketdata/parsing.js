'use strict';
// Turn loosely-typed provider values into clean values. Providers return
// null, "", "N/A", NaN or numbers as strings; these helpers return null for
// anything unusable so mappers stay simple.

const { isoDate } = require('./values');

function toFloat(value) {
  if (value == null || typeof value === 'boolean') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toInt(value) {
  const number = toFloat(value);
  return number == null ? null : Math.trunc(number);
}

function toText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

// "YYYY-MM-DD", or null. Date objects give their UTC calendar day.
function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : isoDate(value);
  const text = toText(value);
  if (!text || !/^\d{4}-\d{2}-\d{2}/.test(text)) return null;
  const day = text.slice(0, 10);
  const parsed = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && isoDate(parsed) === day ? day : null;
}

// Multiply a numeric value, e.g. millions -> units or percent -> fraction.
function scaled(value, factor) {
  const number = toFloat(value);
  return number == null ? null : number * factor;
}

// Value of the first key whose value is usable as a number. Useful when a
// provider has several names for the same metric.
function firstPresent(raw, keys) {
  for (const key of keys) {
    if (toFloat(raw?.[key]) != null) return raw[key];
  }
  return null;
}

module.exports = { toFloat, toInt, toText, toDate, scaled, firstPresent };
