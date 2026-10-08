import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MoneyloverClient, MoneyloverApiError } from '../src/moneyloverClient.js';
import { isAuthError, isDeviceError } from '../src/authError.js';
import { buildSearchFilter } from '../src/searchFilters.js';
import { readBalance, signedTransactionDelta } from '../src/balance.js';
import { createTransactions } from '../src/transactions.js';
import { readImportLog, stripBatchMarker, withBatchMarker } from '../src/importLog.js';
import { undoImport } from '../src/importUndo.js';

const json = (data, extra = {}) =>
  new Response(JSON.stringify({ error: 0, ...extra, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });

describe('phase 2 API behaviour', () => {
  const originalFetch = global.fetch;
  let cacheDir;

  afterEach(async () => {
    global.fetch = originalFetch;
    delete process.env.MONEYLOVER_TOKEN_CACHE_DIR;
    if (cacheDir) {
      await fs.rm(cacheDir, { recursive: true, force: true });
      cacheDir = undefined;
    }
  });

  it('treats error 706 as an auth failure and 717/718 as device failures', () => {
    expect(isAuthError(new MoneyloverApiError('Not authorized error', { code: 706 }))).toBe(true);
    expect(isAuthError(new MoneyloverApiError('device', { code: 717 }))).toBe(false);
    expect(isDeviceError(new MoneyloverApiError('device', { code: 718 }))).toBe(true);
  });

  it('refreshes on e=706 and retries the original call', async () => {
    const onSession = vi.fn();
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 0, e: 706, msg: 'Not authorized error' }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 0, data: { access_token: 'new-token', refresh_token: 'next-refresh' } }), {
          status: 200
        })
      )
      .mockResolvedValueOnce(json({ email: 'person@example.com' }));

    const client = new MoneyloverClient('old-token', { refreshToken: 'refresh-1', onSession });
    const info = await client.getUserInfo();

    expect(info).toEqual({ email: 'person@example.com' });
    expect(client.token).toBe('new-token');
    expect(global.fetch.mock.calls[1][0]).toBe('https://web.moneylover.me/api/user/refresh-token');
    expect(JSON.parse(global.fetch.mock.calls[1][1].body)).toEqual({ refreshToken: 'refresh-1' });
    expect(global.fetch.mock.calls[1][1].headers.Authorization).toBeUndefined();
    expect(global.fetch.mock.calls[2][1].headers.get('Authorization')).toBe('AuthJWT new-token');
    expect(onSession).toHaveBeenCalledWith({ token: 'new-token', refreshToken: 'next-refresh' });
  });

  it('names device 717 and 718 instead of retrying them as expired tokens', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ e: 717 }), { status: 200 }));
    const error = await new MoneyloverClient('t', { refreshToken: 'r' }).getUserInfo().then(
      () => null,
      (caught) => caught
    );
    expect(error).toMatchObject({ code: 717 });
    expect(error.message).toMatch(/device not found/i);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('turns a Cloudflare challenge into a specific error', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(new Response('<html>Just a moment...</html>', { status: 403 }));
    await expect(new MoneyloverClient('t').getUserInfo()).rejects.toMatchObject({ code: 'CLOUDFLARE' });
  });

  it('builds the web app search filter', () => {
    expect(
      buildSearchFilter({
        walletId: 'w1',
        categoryId: 'c1',
        startDate: '2026-04-01',
        endDate: '2026-04-30',
        note: 'cafe',
        with: ['sam'],
        amountFrom: 1,
        amountTo: 20,
        limit: 50,
        offset: 0
      })
    ).toEqual({
      accounts: ['w1'],
      categoryIDs: ['c1'],
      startDate: '2026-04-01',
      endDate: '2026-04-30',
      note: 'cafe',
      with: ['sam'],
      amount: { from: 1, to: 20 },
      limit: 50,
      offset: 0
    });
  });

  it('posts a transfer as from, to, and fee legs', async () => {
    global.fetch = vi.fn(async (url) => {
      const path = String(url);
      if (path.endsWith('/category/list')) {
        return json([
          { _id: 'out-local', account: 'from', name: 'Out', metadata: 'IS_OUTGOING_TRANSFER', type: 2 },
          { _id: 'in-local', account: 'to', name: 'In', metadata: 'IS_INCOMING_TRANSFER', type: 1 },
          { _id: 'fee-local', account: 'from', name: 'Other', metadata: 'IS_OTHER_EXPENSE', type: 2 }
        ]);
      }
      if (path.endsWith('/category/list-all')) {
        return json([
          { _id: 'out', account: 'from', name: 'Out', metadata: 'IS_OUTGOING_TRANSFER', type: 2 },
          { _id: 'in', account: 'to', name: 'In', metadata: 'IS_INCOMING_TRANSFER', type: 1 },
          { _id: 'fee', account: 'from', name: 'Other', metadata: 'IS_OTHER_EXPENSE', type: 2 }
        ]);
      }
      if (path.endsWith('/wallet/list')) {
        return json([
          { _id: 'from', name: 'Bank' },
          { _id: 'to', name: 'Card' }
        ]);
      }
      return json({ ok: true });
    });

    await new MoneyloverClient('t').transferMoney({
      fromWalletId: 'from',
      toWalletId: 'to',
      amount: '40',
      feeAmount: '1.50',
      date: '2026-04-18'
    });

    const post = global.fetch.mock.calls.find((call) => String(call[0]).endsWith('/transaction/add-multi'));
    const body = JSON.parse(post[1].body);
    expect(body.action).toBe('transfermoney');
    expect(body.transactions).toHaveLength(3);
    expect(body.transactions[0]).toMatchObject({ account: 'from', category: 'out', amount: 40, related: true });
    expect(body.transactions[1]).toMatchObject({ account: 'to', category: 'in', amount: 40, related: true });
    expect(body.transactions[2]).toMatchObject({
      account: 'from',
      category: 'fee',
      amount: 1.5,
      isFee: true,
      related: true
    });
  });

  it('adjusts a balance with the Other expense category when the wallet is high', async () => {
    global.fetch = vi.fn(async (url) => {
      const path = String(url);
      if (path.endsWith('/wallet/balance')) {
        return json({ balance: [80] });
      }
      if (path.endsWith('/category/list')) {
        return json([{ _id: 'other-local', account: 'w1', name: 'Other', metadata: 'IS_OTHER_EXPENSE', type: 2 }]);
      }
      if (path.endsWith('/category/list-all')) {
        return json([{ _id: 'other', account: 'w1', name: 'Other', metadata: 'IS_OTHER_EXPENSE', type: 2 }]);
      }
      return json({ _id: 'adj-1' });
    });

    const result = await new MoneyloverClient('t', { timeZone: 'Australia/Adelaide' }).adjustBalance({
      walletId: 'w1',
      balance: 50,
      date: '2026-04-18'
    });

    expect(result.direction).toBe('expense');
    expect(result.delta).toBe(-30);
    const post = global.fetch.mock.calls.find((call) => String(call[0]).endsWith('/transaction/add'));
    expect(JSON.parse(post[1].body)).toMatchObject({
      account: 'w1',
      category: 'other',
      amount: '30',
      displayDate: '2026-04-18',
      note: 'Balance adjustment'
    });
  });

  it('reads a balance array and signs income and expense', () => {
    expect(readBalance({ balance: [12.5] })).toBe(12.5);
    expect(signedTransactionDelta({ amount: '4', category: { type: 1 } })).toBe(4);
    expect(signedTransactionDelta({ amount: '4', category: { type: 2 } })).toBe(-4);
  });

  it('marks a batch in the note and still detects the unmarked duplicate', async () => {
    cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moneylover-import-'));
    process.env.MONEYLOVER_TOKEN_CACHE_DIR = cacheDir;
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ transactions: [] }))
      .mockResolvedValueOnce(json([{ _id: 'local-food', name: 'Food', type: 2, account: 'w1', metadata: 'food0' }]))
      .mockResolvedValueOnce(json([{ _id: 'global-food', name: 'Food', type: 2, account: 'w1', metadata: 'food0' }]))
      .mockResolvedValueOnce(json({ _id: 'created-9' }));

    const summary = await createTransactions(new MoneyloverClient('t'), {
      walletId: 'w1',
      markBatch: true,
      batchId: 'batch1234',
      transactions: [{ date: '2026-04-18', amount: '9', note: 'Cafe', categoryId: 'global-food' }]
    });

    expect(summary.batchId).toBe('batch1234');
    expect(summary.results[0].note).toBe('Cafe ml-batch:batch1234');
    expect(stripBatchMarker(summary.results[0].note)).toBe('Cafe');
    expect(withBatchMarker('Cafe', 'batch1234')).toBe('Cafe ml-batch:batch1234');
    const log = await readImportLog('batch1234');
    expect(log.ids).toEqual(['created-9']);

    const preview = await undoImport(new MoneyloverClient('t'), 'batch1234', { dryRun: true });
    expect(preview.ids).toEqual(['created-9']);
    expect(global.fetch.mock.calls.at(-1)[0]).not.toMatch(/\/transaction\/delete$/);
  });

  it('explains a category write failure on a user_category_v2 account', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 2, msg: 'not_allowed' }), { status: 200 }))
      .mockResolvedValueOnce(json({ email: 'a@b.c', tags: ['user_category_v2'] }));

    await expect(
      new MoneyloverClient('t').addCategory({ walletId: 'w1', name: 'Gym', icon: 'icon_3', type: 2 })
    ).rejects.toMatchObject({ code: 'USER_CATEGORY_V2' });
  });

  it('posts a budget and a report with the web app fields', async () => {
    global.fetch = vi.fn(async () => json({ ok: true }));
    const client = new MoneyloverClient('t');
    await client.addBudget({
      walletId: 'w1',
      categoryId: 'c1',
      amount: '100',
      startDate: '2026-04-01',
      endDate: '2026-04-30',
      isRepeat: true
    });
    await client.getReport({ walletId: 'w1', startDate: '2026-04-01', endDate: '2026-04-30' });
    const budget = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(global.fetch.mock.calls[0][0]).toBe('https://web.moneylover.me/api/budget/add');
    expect(budget).toMatchObject({
      walletId: 'w1',
      categoryId: 'c1',
      amount: 100,
      startDate: '2026-04-01',
      endDate: '2026-04-30',
      isRepeat: true
    });
    expect(global.fetch.mock.calls[1][0]).toBe('https://web.moneylover.me/api/report/w1');
  });
});
