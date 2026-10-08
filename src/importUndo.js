import { unwrapList } from './categories.js';
import { batchMarker, readImportLog } from './importLog.js';

const idsFromSearch = (payload, marker) => {
  const rows = Array.isArray(payload?.transactions) ? payload.transactions : unwrapList(payload);
  return rows.filter((row) => String(row?.note ?? '').includes(marker) && row?._id).map((row) => String(row._id));
};

/**
 * Delete every transaction recorded for a batch, plus any search hit whose note
 * still contains that batch marker.
 */
export const undoImport = async (client, batchId, { deleteRelated = false, dryRun = false } = {}) => {
  const marker = batchMarker(batchId);
  const logged = await readImportLog(batchId);
  const ids = new Set(Array.isArray(logged?.ids) ? logged.ids.map(String) : []);
  try {
    if (typeof client.searchAllTransactions === 'function') {
      const collected = await client.searchAllTransactions({ note: marker });
      for (const id of idsFromSearch(collected, marker)) {
        ids.add(id);
      }
    }
  } catch {
    // The local log is enough when search is unavailable.
  }

  const idList = [...ids];
  if (dryRun) {
    return {
      dryRun: true,
      batchId,
      marker,
      ids: idList,
      count: idList.length,
      fromLog: Array.isArray(logged?.ids) ? logged.ids.length : 0
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
    fromLog: Array.isArray(logged?.ids) ? logged.ids.length : 0
  };
};
