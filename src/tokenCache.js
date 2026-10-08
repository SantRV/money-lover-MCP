import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const encodeEmail = (email) => Buffer.from(email, 'utf8').toString('base64url');

export const cacheDir = () =>
  process.env.MONEYLOVER_TOKEN_CACHE_DIR?.trim() || path.join(os.homedir(), '.moneylover-mcp');

export const getTokenPath = (email) => path.join(cacheDir(), `${encodeEmail(email)}.json`);

const ensureCacheDir = async () => {
  const dir = cacheDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.chmod(dir, 0o700);
  return dir;
};

export const readToken = async (email) => {
  if (!email) {
    return null;
  }
  try {
    const raw = await fs.readFile(getTokenPath(email), 'utf8');
    const data = JSON.parse(raw);
    const token = data?.token;
    return typeof token === 'string' && token ? token : null;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
};

export const writeToken = async (email, token) => {
  if (!email || !token) {
    return;
  }
  const dir = await ensureCacheDir();
  const filePath = getTokenPath(email);
  const resolvedDir = path.resolve(dir);
  const resolvedFile = path.resolve(filePath);
  if (!resolvedFile.startsWith(`${resolvedDir}${path.sep}`)) {
    throw new Error('Refusing to write a token cache file outside the cache directory');
  }

  const payload = {
    token,
    updatedAt: new Date().toISOString()
  };
  const tempPath = path.join(dir, `.${encodeEmail(email)}.${process.pid}.tmp`);
  try {
    await fs.writeFile(tempPath, JSON.stringify(payload), { mode: 0o600, flag: 'w' });
    await fs.chmod(tempPath, 0o600);
    await fs.rename(tempPath, filePath);
    await fs.chmod(filePath, 0o600);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
};

export const removeToken = async (email) => {
  if (!email) {
    return;
  }
  try {
    await fs.unlink(getTokenPath(email));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
};

export const __test = {
  cacheDir,
  getTokenPath,
  ensureCacheDir
};

export default {
  readToken,
  writeToken,
  removeToken
};
