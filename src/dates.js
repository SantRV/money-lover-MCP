/**
 * Calendar dates for Money Lover.
 *
 * A YYYY-MM-DD string is a calendar date and is never converted through UTC.
 * The API also returns that calendar date encoded as UTC midnight
 * (for example "2026-04-18T00:00:00.000Z"). Taking the UTC date part keeps the
 * same day in Australia/Adelaide. Real instants (Date objects and timestamps
 * that are not UTC midnight) are formatted in MONEYLOVER_TIMEZONE.
 */

export const DEFAULT_TIMEZONE = 'Australia/Adelaide';

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const UTC_MIDNIGHT = /^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.0+)?Z$/;
const HAS_TIME = /[T ]\d{2}:\d{2}/;
const SLASH_DATE = /^(\d{1,4})[/.](\d{1,2})[/.](\d{1,4})$/;

export const resolveTimezone = (explicit) => {
  const raw = (explicit ?? process.env.MONEYLOVER_TIMEZONE ?? process.env.TZ ?? DEFAULT_TIMEZONE).toString().trim();
  if (!raw || raw.startsWith(':') || raw.startsWith('/') || raw.toLowerCase() === 'local') {
    return DEFAULT_TIMEZONE;
  }
  return raw;
};

const pad = (value) => String(value).padStart(2, '0');

export const formatParts = (year, month, day) => `${year}-${pad(month)}-${pad(day)}`;

export const isRealDate = (year, month, day) => {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return false;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
};

const formatInTimeZone = (date, timeZone) => {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(date);
  } catch (error) {
    throw new Error(`Invalid timezone "${timeZone}": ${error.message}`, { cause: error });
  }
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  if (!year || !month || !day) {
    throw new Error(`Could not format date in timezone "${timeZone}"`);
  }
  return `${year}-${month}-${day}`;
};

const fromNumbers = (year, month, day) => {
  if (!isRealDate(year, month, day)) {
    throw new Error('date is invalid');
  }
  return formatParts(year, month, day);
};

/**
 * @param {Date | string | number} input
 * @param {{ timeZone?: string, dateOrder?: 'YMD' | 'DMY' | 'MDY' }} [options]
 * @returns {string} YYYY-MM-DD
 */
export const calendarDate = (input, options = {}) => {
  const timeZone = resolveTimezone(options.timeZone);
  const dateOrder = options.dateOrder ?? 'YMD';

  if (input instanceof Date || typeof input === 'number') {
    const date = input instanceof Date ? input : new Date(input);
    if (Number.isNaN(date.getTime())) {
      throw new Error('date is invalid');
    }
    return formatInTimeZone(date, timeZone);
  }

  if (typeof input !== 'string') {
    throw new Error('date must be a Date or YYYY-MM-DD string');
  }

  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('date is required');
  }

  const dateOnly = trimmed.match(DATE_ONLY);
  if (dateOnly) {
    return fromNumbers(Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3]));
  }

  const midnight = trimmed.match(UTC_MIDNIGHT);
  if (midnight) {
    return calendarDate(midnight[1], { timeZone, dateOrder: 'YMD' });
  }

  if (HAS_TIME.test(trimmed)) {
    const date = new Date(trimmed);
    if (Number.isNaN(date.getTime())) {
      throw new Error('date is invalid');
    }
    return formatInTimeZone(date, timeZone);
  }

  const slashed = trimmed.match(SLASH_DATE);
  if (slashed && dateOrder !== 'YMD') {
    const first = Number(slashed[1]);
    const second = Number(slashed[2]);
    const third = Number(slashed[3]);
    if (dateOrder === 'DMY') {
      return fromNumbers(third, second, first);
    }
    if (dateOrder === 'MDY') {
      return fromNumbers(third, first, second);
    }
  }

  if (slashed && String(slashed[1]).length === 4) {
    return fromNumbers(Number(slashed[1]), Number(slashed[2]), Number(slashed[3]));
  }

  throw new Error('date must be in YYYY-MM-DD format');
};

/** Add calendar days to a YYYY-MM-DD date without converting through local midnight. */
export const addCalendarDays = (input, days) => {
  const iso = calendarDate(input);
  const [year, month, day] = iso.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return formatParts(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
};

export const safeCalendarDate = (input, options) => {
  try {
    return calendarDate(input, options);
  } catch {
    return null;
  }
};
