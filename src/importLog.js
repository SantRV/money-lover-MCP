import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { cacheDir } from './tokenCache.js';

export const BATCH_MARKER_PREFIX = 'ml-batch:';
const BATCH_ID = /^[A-Za-z0-9_-]{4,80}$/;
const MARKER = /\s*ml-batch:[A-Za-z0-9_-]+\s*$/;

export const newBatchId = () => `b${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;

export const assertBatchId = (batchId) => {
  const id = String(batchId ?? '').trim();
  if (!BATCH_ID.test(id)) {
    throw new Error('batchId must be 4-80 letters, numbers, underscores, or hyphens');
  }
  return id;
};

export const batchMarker = (batchId) => `${BATCH_MARKER_PREFIX}${assertBatchId(batchId)}`;

export const stripBatchMarker = (note) =>
  String(note ?? '')
    .replace(MARKER, '')
    .trim();

/** Append the batch marker. Money Lover rejects notes longer than 255 characters. */
export const withBatchMarker = (note, batchId) => {
  if (!batchId) {
    return String(note ?? '');
  }
  const marker = batchMarker(batchId);
  const base = stripBatchMarker(note);
  const suffix = base ? ` ${marker}` : marker;
  if (base.length + suffix.length <= 255) {
    return `${base}${suffix}`;
  }
  const room = Math.max(0, 255 - suffix.length);
  return `${base.slice(0, room).trim()}${suffix}`;
};

const importDir = () => path.join(cacheDir(), 'imports');

const importPath = (batchId) => {
  const id = assertBatchId(batchId);
  const dir = importDir();
  const filePath = path.join(dir, `${id}.json`);
  if (!path.resolve(filePath).startsWith(`${path.resolve(dir)}${path.sep}`)) {
    throw new Error('Refusing to write an import log outside the cache directory');
  }
  return filePath;
};

const ensureImportDir = async () => {
  const dir = importDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.chmod(dir, 0o700);
  return dir;
};

export const readImportLog = async (batchId) => {
  try {
    const raw = await fs.readFile(importPath(batchId), 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : null;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
};

export const appendImportLog = async (batchId, entry) => {
  const id = assertBatchId(batchId);
  await ensureImportDir();
  const existing = (await readImportLog(id)) ?? {
    batchId: id,
    createdAt: new Date().toISOString(),
    ids: []
  };
  const ids = new Set(Array.isArray(existing.ids) ? existing.ids : []);
  if (entry?.id) {
    ids.add(String(entry.id));
  }
  const payload = {
    ...existing,
    batchId: id,
    walletId: entry?.walletId ?? existing.walletId ?? null,
    updatedAt: new Date().toISOString(),
    ids: [...ids]
  };
  const filePath = importPath(id);
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(payload), { mode: 0o600 });
  await fs.chmod(tempPath, 0o600);
  await fs.rename(tempPath, filePath);
  await fs.chmod(filePath, 0o600);
  return payload;
};
