import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const ORIGINAL_ENV = {
  EMAIL: process.env.EMAIL,
  PASSWORD: process.env.PASSWORD,
  MONEYLOVER_EMAIL: process.env.MONEYLOVER_EMAIL,
  MONEYLOVER_PASSWORD: process.env.MONEYLOVER_PASSWORD,
  MONEYLOVER_TOKEN: process.env.MONEYLOVER_TOKEN,
  MONEYLOVER_MCP_DISABLE_ENV_FILE: process.env.MONEYLOVER_MCP_DISABLE_ENV_FILE,
  MONEYLOVER_TOKEN_CACHE_DIR: process.env.MONEYLOVER_TOKEN_CACHE_DIR
};

let cacheDir;
let createMoneyloverServer;
let clearEnvTokenCache;

const restoreEnv = () => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (typeof value === 'undefined') {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
};

const connect = async () => {
  clearEnvTokenCache();
  const server = createMoneyloverServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'moneylover-mcp-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
};

describe('MCP tools', () => {
  beforeAll(async () => {
    cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moneylover-mcp-tools-'));
    process.env.MONEYLOVER_MCP_DISABLE_ENV_FILE = '1';
    process.env.MONEYLOVER_TOKEN_CACHE_DIR = cacheDir;
    process.env.MONEYLOVER_TOKEN = 'test-session-token';
    delete process.env.EMAIL;
    delete process.env.PASSWORD;
    delete process.env.MONEYLOVER_EMAIL;
    delete process.env.MONEYLOVER_PASSWORD;
    ({
      createMoneyloverServer,
      __test: { clearEnvTokenCache }
    } = await import('../src/server.js'));
  });

  afterAll(async () => {
    restoreEnv();
    if (cacheDir) {
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  it('registers the statement import tools alongside the original tools', async () => {
    const client = await connect();
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    for (const name of [
      'login',
      'get_wallets',
      'get_categories',
      'list_categories',
      'get_transactions',
      'add_transaction',
      'add_transactions',
      'import_transactions_csv',
      'edit_transaction',
      'delete_transaction',
      'delete_wallet',
      'delete_category'
    ]) {
      expect(names).toContain(name);
    }
    expect(names).toHaveLength(48);
    await client.close();
  });

  it('refuses to delete a transaction without confirm', async () => {
    const client = await connect();
    const result = await client.callTool({
      name: 'delete_transaction',
      arguments: { transactionId: 'txn-1' }
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/confirm: true/);
    await client.close();
  });

  it('previews a delete without writing when dryRun is set', async () => {
    const fetchMock = vi.fn();
    const previous = global.fetch;
    global.fetch = fetchMock;
    try {
      const client = await connect();
      const result = await client.callTool({
        name: 'delete_transaction',
        arguments: { transactionId: 'txn-1', dryRun: true }
      });
      expect(result.isError).toBeFalsy();
      expect(JSON.stringify(result)).toContain('txn-1');
      expect(fetchMock).not.toHaveBeenCalled();
      await client.close();
    } finally {
      global.fetch = previous;
    }
  });

  it('does not return the access token from login', async () => {
    const accessToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature';
    const previous = global.fetch;
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              request_token: 'request-token',
              login_url: 'https://web.moneylover.me/login?client=abc'
            }
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: accessToken }), { status: 200 }));

    try {
      const client = await connect();
      const result = await client.callTool({
        name: 'login',
        arguments: { email: 'person@example.com', password: 'secret-password' }
      });
      const text = JSON.stringify(result);
      expect(result.isError).toBeFalsy();
      expect(text).toContain('authenticated');
      expect(text).not.toContain(accessToken);
      expect(text).not.toContain('secret-password');
      expect(text).not.toContain('request-token');
      await client.close();
    } finally {
      global.fetch = previous;
    }
  });
});
