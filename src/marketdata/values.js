'use strict';
// Small value objects shared by fetchers. Calendar days are ISO strings
// ("2026-11-14"): they sort and compare as text and have no time zone.

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Canonical form of a ticker (" ry.to " -> "RY.TO"). Yahoo uses the .TO
// suffix for TSX listings.
function normalizeSymbol(symbol) {
  const cleaned = typeof symbol === 'string' ? symbol.trim().toUpperCase() : '';
  if (!cleaned) throw new RangeError('symbol must not be empty');
  return cleaned;
}

// Today's date in the local time zone.
function today() {
  const d = new Date();
  return isoDate(new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())));
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(day, days) {
  return isoDate(new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS));
}

// Inclusive range of calendar days.
class DateRange {
  constructor(start, end) {
    for (const day of [start, end]) {
      if (!ISO_DATE_RE.test(day)) throw new RangeError(`not an ISO date: ${day}`);
    }
    if (start > end) throw new RangeError(`start ${start} is after end ${end}`);
    this.start = start;
    this.end = end;
    Object.freeze(this);
  }

  // Range covering the `days` days that end on `end` (inclusive).
  static lastDays(days, end = today()) {
    if (!(days >= 1)) throw new RangeError('days must be at least 1');
    return new DateRange(addDays(end, -(days - 1)), end);
  }

  includes(day) {
    return this.start <= day && day <= this.end;
  }
}

module.exports = { normalizeSymbol, DateRange, today, isoDate, addDays };
