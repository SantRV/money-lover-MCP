import { findDuplicate, fingerprintTransaction } from './duplicates.js';
import { unwrapList } from './categories.js';
import { safeCalendarDate } from './dates.js';
import { appendImportLog, newBatchId, stripBatchMarker, withBatchMarker } from './importLog.js';

const MAX_BATCH = 200;

const fingerprintsFrom = (rows, timeZone) =>
  rows
    .map((transaction) => fingerprintTransaction(transaction, { timeZone }))
    .filter((item) => item.date && item.cents != null);

export const loadFingerprints = async (client, walletId, dates, timeZone) => {
  const usable = dates.filter(Boolean).sort();
  if (usable.length === 0) {
    return [];
  }
  const startDate = usable[0];
  const endDate = usable[usable.length - 1];
  try {
    if (typeof client.searchAllTransactions === 'function') {
      const collected = await client.searchAllTransactions({
        accounts: [walletId],
        startDate,
        endDate
      });
      const rows = Array.isArray(collected) ? collected : (collected?.transactions ?? []);
      return fingerprintsFrom(rows, timeZone);
    }
    const searched = await client.searchTransactions({
      accounts: [walletId],
      startDate,
      endDate,
      limit: 200,
      offset: 0
    });
    return fingerprintsFrom(unwrapList(searched), timeZone);
  } catch {
    const data = await client.getTransactions(walletId, startDate, endDate);
    return fingerprintsFrom(unwrapList(data), timeZone);
  }
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
  const markBatch = options.markBatch === true || Boolean(options.batchId);
  const batchId = markBatch ? (options.batchId ?? newBatchId()) : null;

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
        direction: row.direction,
        excludeReport: row.excludeReport,
        eventId: row.eventId,
        event: row.event,
        remind: row.remind,
        reminder: row.reminder,
        longtitude: row.longtitude,
        longitude: row.longitude,
        latitude: row.latitude,
        addressName: row.addressName,
        addressDetails: row.addressDetails,
        addressIcon: row.addressIcon,
        image: row.image
      });
      const noteForMatch = stripBatchMarker(prepared.note);
      const storedNote = withBatchMarker(prepared.note, batchId);
      const payload = { ...prepared.payload, note: storedNote };
      const candidate = {
        date: prepared.date,
        cents: prepared.cents,
        note: noteForMatch
      };
      const duplicate = skipDuplicates ? findDuplicate(candidate, existing.concat(accepted)) : null;
      if (duplicate) {
        results.push({
          index,
          status: 'skipped_duplicate',
          date: prepared.date,
          amount: payload.amount,
          note: storedNote,
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
          amount: payload.amount,
          note: storedNote,
          categoryId: prepared.categoryId,
          direction: prepared.direction,
          warnings: prepared.warnings,
          payload
        });
        continue;
      }

      const created = await client.addPreparedTransaction({ ...prepared, payload });
      const createdId = created?._id ?? null;
      if (batchId && createdId) {
        await appendImportLog(batchId, { id: createdId, walletId });
      }
      accepted.push({ ...candidate, id: createdId });
      results.push({
        index,
        status: 'created',
        id: createdId,
        date: prepared.date,
        amount: payload.amount,
        note: storedNote,
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
    batchId,
    created: count('created'),
    skipped: count('skipped_duplicate'),
    failed: count('error'),
    previewed: count('dry_run'),
    results
  };
};
