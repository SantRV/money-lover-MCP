import { findDuplicate, fingerprintTransaction } from './duplicates.js';
import { unwrapList } from './categories.js';
import { safeCalendarDate } from './dates.js';

const MAX_BATCH = 200;

export const loadFingerprints = async (client, walletId, dates, timeZone) => {
  const usable = dates.filter(Boolean).sort();
  if (usable.length === 0) {
    return [];
  }
  const data = await client.getTransactions(walletId, usable[0], usable[usable.length - 1]);
  return unwrapList(data)
    .map((transaction) => fingerprintTransaction(transaction, { timeZone }))
    .filter((item) => item.date && item.cents != null);
};

/**
 * Create many transactions and return one result per input row.
 * Duplicates match the same wallet, calendar date, absolute amount, and a similar note.
 */
export const createTransactions = async (client, options) => {
  const rows = options.transactions;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('transactions must be a non-empty array');
  }
  if (rows.length > MAX_BATCH) {
    throw new Error(`transactions is limited to ${MAX_BATCH} rows per call`);
  }

  const walletId = options.walletId;
  const skipDuplicates = options.skipDuplicates !== false;
  const dryRun = options.dryRun === true;
  const amountMode = options.amountMode === 'signed' ? 'signed' : 'magnitude';
  const timeZone = options.timeZone;

  let existing = [];
  if (skipDuplicates) {
    const dates = [];
    for (const row of rows) {
      const parsed = safeCalendarDate(row?.date, { timeZone, dateOrder: options.dateOrder });
      if (parsed) {
        dates.push(parsed);
      }
    }
    existing = await loadFingerprints(client, walletId, dates, timeZone);
  }

  const accepted = [];
  const results = [];

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] ?? {};
    if (row.error) {
      results.push({ index, status: 'error', message: row.error });
      continue;
    }
    try {
      const prepared = await client.prepareTransaction({
        walletId,
        categoryId: row.categoryId,
        category: row.category,
        amount: row.amount,
        note: row.note,
        date: row.date,
        with: row.with,
        amountMode: row.amountMode ?? amountMode,
        timeZone,
        dateOrder: options.dateOrder,
        direction: row.direction
      });
      const candidate = {
        date: prepared.date,
        cents: prepared.cents,
        note: prepared.note
      };
      const duplicate = skipDuplicates ? findDuplicate(candidate, existing.concat(accepted)) : null;
      if (duplicate) {
        results.push({
          index,
          status: 'skipped_duplicate',
          date: prepared.date,
          amount: prepared.payload.amount,
          note: prepared.note,
          categoryId: prepared.categoryId,
          direction: prepared.direction,
          matchId: duplicate.id
        });
        continue;
      }

      if (dryRun) {
        accepted.push(candidate);
        results.push({
          index,
          status: 'dry_run',
          date: prepared.date,
          amount: prepared.payload.amount,
          note: prepared.note,
          categoryId: prepared.categoryId,
          direction: prepared.direction,
          warnings: prepared.warnings,
          payload: prepared.payload
        });
        continue;
      }

      const created = await client.addPreparedTransaction(prepared);
      accepted.push({ ...candidate, id: created?._id ?? null });
      results.push({
        index,
        status: 'created',
        id: created?._id ?? null,
        date: prepared.date,
        amount: prepared.payload.amount,
        note: prepared.note,
        categoryId: prepared.categoryId,
        direction: prepared.direction,
        warnings: prepared.warnings
      });
    } catch (error) {
      results.push({
        index,
        status: 'error',
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const count = (status) => results.filter((result) => result.status === status).length;
  return {
    dryRun,
    skipDuplicates,
    created: count('created'),
    skipped: count('skipped_duplicate'),
    failed: count('error'),
    previewed: count('dry_run'),
    results
  };
};
