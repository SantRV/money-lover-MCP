import { calendarDate } from './dates.js';

/** /transaction/search ignores limit and returns this many rows per offset. */
export const SEARCH_PAGE_SIZE = 50;

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

/**
 * /transaction/search ignores limit and returns SEARCH_PAGE_SIZE rows.
 * A full page is not the end of the list, even when the API sends no total.
 */
export const pageSearchResult = ({ transactions, offset = 0, reportedTotal = null, pageSize = SEARCH_PAGE_SIZE }) => {
  const returned = Array.isArray(transactions) ? transactions.length : 0;
  const pageFull = returned >= pageSize;
  const truncated = reportedTotal != null ? offset + returned < reportedTotal : pageFull;
  return {
    returned,
    truncated,
    offset,
    nextOffset: truncated ? offset + returned : null,
    pageSize,
    ...(reportedTotal != null ? { total: reportedTotal } : {})
  };
};
