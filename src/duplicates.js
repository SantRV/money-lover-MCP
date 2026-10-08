import { amountCents } from './amounts.js';
import { safeCalendarDate } from './dates.js';

export const normalizeNote = (note) =>
  String(note ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export const notesSimilar = (left, right) => {
  const a = normalizeNote(left);
  const b = normalizeNote(right);
  if (a === b) {
    return true;
  }
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return shorter.length >= 8 && longer.includes(shorter);
};

export const fingerprintTransaction = (transaction, options = {}) => {
  const date = transaction.date ?? safeCalendarDate(transaction.displayDate, { timeZone: options.timeZone }) ?? null;
  let cents;
  try {
    cents = amountCents(transaction.amount);
  } catch {
    cents = null;
  }
  return {
    id: transaction.id ?? transaction._id ?? null,
    date,
    cents,
    note: transaction.note ?? ''
  };
};

export const findDuplicate = (candidate, existing) => {
  if (!candidate?.date || candidate.cents == null) {
    return null;
  }
  return (
    existing.find(
      (item) =>
        item.date === candidate.date && item.cents === candidate.cents && notesSimilar(item.note, candidate.note)
    ) ?? null
  );
};
