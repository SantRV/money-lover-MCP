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

const readCacheFile = async (email) => {
  if (!email) {
    return null;
  }
  try {
    const raw = await fs.readFile(getTokenPath(email), 'utf8');
    const trimmed = raw.trim();
    if (!trimmed) {
      return null;
    }
    try {
      const data = JSON.parse(trimmed);
      if (data && typeof data === 'object') {
        return data;
      }
    } catch {
      return { token: trimmed };
    }
    return null;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
};

/**
 * A cached access token is reusable until its JWT exp, when it has one.
 * Opaque tokens are treated as valid until the API rejects them.
 */
export const accessTokenStillValid = (token, now = Date.now()) => {
  if (typeof token !== 'string' || !token) {
    return false;
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    return true;
  }
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (typeof payload.exp !== 'number') {
      return true;
    }
    return payload.exp * 1000 > now + 60_000;
  } catch {
    return true;
  }
};

export const readToken = async (email) => {
  const data = await readCacheFile(email);
  const token = data?.token;
  return typeof token === 'string' && token ? token : null;
};

export const readRefreshToken = async (email) => {
  const data = await readCacheFile(email);
  const refreshToken = data?.refreshToken;
  return typeof refreshToken === 'string' && refreshToken ? refreshToken : null;
};

export const writeToken = async (email, token, extra = {}) => {
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

  const refreshToken = Object.prototype.hasOwnProperty.call(extra, 'refreshToken')
    ? typeof extra.refreshToken === 'string' && extra.refreshToken
      ? extra.refreshToken
      : null
    : await readRefreshToken(email);

  const payload = {
    token,
    updatedAt: new Date().toISOString(),
    ...(refreshToken ? { refreshToken } : {})
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
