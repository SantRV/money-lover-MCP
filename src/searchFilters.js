import { calendarDate } from './dates.js';

const stringList = (value, name) => {
  if (value == null) {
    return undefined;
  }
  const list = Array.isArray(value) ? value : [value];
  const cleaned = list.map((item) => String(item).trim()).filter(Boolean);
  if (cleaned.length === 0) {
    throw new Error(`${name} must contain at least one value`);
  }
  return cleaned;
};

/**
 * Filter object the web app posts to /transaction/search and /transaction/search/balance.
 * Unknown keys in `extra` are copied through so a caller can still pass a raw filter.
 */
export const buildSearchFilter = (input = {}, { timeZone } = {}) => {
  const extra = input.extra && typeof input.extra === 'object' ? { ...input.extra } : {};
  const filter = { ...extra };

  const accounts =
    stringList(input.accounts, 'accounts') ?? (input.walletId ? [String(input.walletId).trim()] : undefined);
  if (accounts) {
    filter.accounts = accounts;
  }

  const categoryIDs =
    stringList(input.categoryIDs, 'categoryIDs') ?? (input.categoryId ? [String(input.categoryId).trim()] : undefined);
  if (categoryIDs) {
    filter.categoryIDs = categoryIDs;
  }

  if (input.startDate) {
    filter.startDate = calendarDate(input.startDate, { timeZone });
  }
  if (input.endDate) {
    filter.endDate = calendarDate(input.endDate, { timeZone });
  }
  if (typeof input.note === 'string') {
    filter.note = input.note;
  }
  if (input.with != null) {
    filter.with = stringList(input.with, 'with') ?? [];
  }
  if (input.amountFrom != null || input.amountTo != null || input.amount) {
    const amount = input.amount && typeof input.amount === 'object' ? input.amount : {};
    const from = input.amountFrom ?? amount.from;
    const to = input.amountTo ?? amount.to;
    filter.amount = {};
    if (from != null && from !== '') {
      filter.amount.from = Number(from);
    }
    if (to != null && to !== '') {
      filter.amount.to = Number(to);
    }
  }
  if (input.limit != null) {
    filter.limit = input.limit;
  }
  if (input.offset != null) {
    filter.offset = input.offset;
  }
  return filter;
};
