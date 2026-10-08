import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getTokenPath, readToken, writeToken } from '../src/tokenCache.js';

describe('token cache permissions', () => {
  let directory;

  afterEach(async () => {
    delete process.env.MONEYLOVER_TOKEN_CACHE_DIR;
    if (directory) {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('writes the token as mode 0600 inside a mode 0700 directory', async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'moneylover-cache-'));
    process.env.MONEYLOVER_TOKEN_CACHE_DIR = directory;

    await writeToken('person@example.com', 'secret-token');

    const dirMode = (await fs.stat(directory)).mode & 0o777;
    const filePath = getTokenPath('person@example.com');
    const fileMode = (await fs.stat(filePath)).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
    expect(await readToken('person@example.com')).toBe('secret-token');
    expect(filePath.startsWith(`${directory}${path.sep}`)).toBe(true);
    expect(path.basename(filePath)).not.toContain('person@example.com');
  });
});
