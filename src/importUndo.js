import { unwrapList } from './categories.js';
import { calendarDate } from './dates.js';
import { batchMarker, readImportLog } from './importLog.js';
import { SEARCH_PAGE_SIZE } from './searchFilters.js';

const idsFromSearch = (payload, marker) => {
  const rows = Array.isArray(payload?.transactions) ? payload.transactions : unwrapList(payload);
  return rows.filter((row) => String(row?.note ?? '').includes(marker) && row?._id).map((row) => String(row._id));
};

const searchMarkedIds = async (client, marker, filters) => {
  if (typeof client.searchAllTransactions !== 'function') {
    return [];
  }
  const collected = await client.searchAllTransactions(filters, { pageSize: SEARCH_PAGE_SIZE, maxPages: 40 });
  return idsFromSearch(collected, marker);
};

/**
 * When the import log is missing, page /transaction/search over the wallet and
 * date range and keep notes that contain ml-batch:<id>. A note query that
 * returns nothing is followed by the same range without the note filter.
 */
const idsFromWalletRange = async (client, marker, { walletId, startDate, endDate } = {}) => {
  const timeZone = client?.timeZone;
  const filters = { note: marker };
  if (walletId) {
    filters.accounts = [String(walletId)];
  }
  if (startDate) {
    filters.startDate = calendarDate(startDate, { timeZone });
  }
  if (endDate) {
    filters.endDate = calendarDate(endDate, { timeZone });
  }
  const matched = await searchMarkedIds(client, marker, filters);
  if (matched.length > 0 || (!filters.accounts && !filters.startDate && !filters.endDate)) {
    return matched;
  }
  const range = { ...filters };
  delete range.note;
  return searchMarkedIds(client, marker, range);
};

/**
 * Delete every transaction recorded for a batch. With no local import log,
 * search the wallet and date range for notes tagged ml-batch:<id>.
 */
export const undoImport = async (
  client,
  batchId,
  { deleteRelated = false, dryRun = false, walletId, startDate, endDate } = {}
) => {
  const marker = batchMarker(batchId);
  const logged = await readImportLog(batchId);
  const ids = new Set(Array.isArray(logged?.ids) ? logged.ids.map(String) : []);
  const fromLog = ids.size;
  try {
    if (fromLog > 0) {
      for (const id of await searchMarkedIds(client, marker, { note: marker })) {
        ids.add(id);
      }
    } else {
      for (const id of await idsFromWalletRange(client, marker, {
        walletId: walletId ?? logged?.walletId,
        startDate,
        endDate
      })) {
        ids.add(id);
      }
    }
  } catch {
    // A missing search still deletes whatever the local log listed.
  }

  const idList = [...ids];
  if (dryRun) {
    return {
      dryRun: true,
      batchId,
      marker,
      ids: idList,
      count: idList.length,
      fromLog,
      fromSearch: idList.length - fromLog
    };
  }

  const deleted = [];
  const failed = [];
  for (const id of idList) {
    try {
      await client.deleteTransaction(id, { deleteRelated });
      deleted.push(id);
    } catch (error) {
      failed.push({ id, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return {
    batchId,
    marker,
    deleted,
    failed,
    fromLog,
    fromSearch: idList.length - fromLog
  };
};
