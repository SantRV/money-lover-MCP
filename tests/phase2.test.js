import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MoneyloverClient, MoneyloverApiError, timeoutForRequest } from '../src/moneyloverClient.js';
import { isAuthError, isDeviceError } from '../src/authError.js';
import { buildSearchFilter, pageSearchResult } from '../src/searchFilters.js';
import { readBalance, signedTransactionDelta, summarizeTransactionTotals } from '../src/balance.js';
import { __test as serverTest } from '../src/server.js';
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

    expect(global.fetch.mock.calls.filter((call) => String(call[0]).endsWith('/category/list-all'))).toHaveLength(1);
    expect(global.fetch.mock.calls.some((call) => String(call[0]).endsWith('/category/list'))).toBe(false);
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
      amount: 30,
      displayDate: '2026-04-18',
      note: 'Balance adjustment'
    });
  });

  it('refuses a balance adjustment when this wallet has no Other expense category', async () => {
    global.fetch = vi.fn(async (url) => {
      const path = String(url);
      if (path.endsWith('/wallet/balance')) {
        return json({ balance: [80] });
      }
      if (path.endsWith('/category/list')) {
        return json([{ _id: 'food', account: 'w1', name: 'Food', type: 2 }]);
      }
      return json({ _id: 'should-not-post' });
    });

    await expect(
      new MoneyloverClient('t').adjustBalance({ walletId: 'w1', balance: 50, date: '2026-04-18' })
    ).rejects.toMatchObject({ code: 'CATEGORY_NOT_USABLE' });
    expect(global.fetch.mock.calls.some((call) => String(call[0]).endsWith('/transaction/add'))).toBe(false);
  });

  it('does not adjust with a stored category id that has no list-all id on this wallet', async () => {
    global.fetch = vi.fn(async (url) => {
      const path = String(url);
      if (path.endsWith('/wallet/balance')) {
        return json({ balance: [80] });
      }
      if (path.endsWith('/category/list')) {
        return json([{ _id: 'food', account: 'w1', name: 'Food', metadata: 'food', type: 2 }]);
      }
      if (path.endsWith('/category/list-all')) {
        return json([{ _id: 'food-other-wallet', account: 'w9', name: 'Food', type: 2 }]);
      }
      return json({ _id: 'adj-2' });
    });

    await expect(
      new MoneyloverClient('t').adjustBalance({
        walletId: 'w1',
        balance: 50,
        date: '2026-04-18',
        categoryId: 'food'
      })
    ).rejects.toThrow(/list-all/);
    expect(global.fetch.mock.calls.some((call) => String(call[0]).endsWith('/transaction/add'))).toBe(false);
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

  it('adds up search balance rows and does not return tokenDevice', async () => {
    const rows = [
      { amount: 10, category: { type: 1 }, tokenDevice: 'web' },
      { amount: 4, category: { type: 2 }, tokenDevice: 'web' },
      { amount: 1, tokenDevice: 'secret' }
    ];
    expect(summarizeTransactionTotals(rows)).toEqual({
      count: 3,
      income: 10,
      expense: 4,
      net: 6,
      skipped: 1,
      incomplete: true
    });
    expect(JSON.stringify(summarizeTransactionTotals(rows))).not.toMatch(/tokenDevice|secret/);

    global.fetch = vi.fn().mockResolvedValueOnce(json(rows));
    const totals = await new MoneyloverClient('t').searchTransactionTotals({ accounts: ['w1'] });
    expect(totals.count).toBe(3);
    expect(totals.net).toBe(6);
    expect(JSON.stringify(totals)).not.toMatch(/tokenDevice/);
  });

  it('treats a full search page as incomplete when the API sends no total', () => {
    const full = pageSearchResult({ transactions: Array.from({ length: 50 }, (_, index) => index), offset: 100 });
    expect(full.truncated).toBe(true);
    expect(full.total).toBeUndefined();
    expect(full.nextOffset).toBe(150);

    const last = pageSearchResult({ transactions: Array.from({ length: 7 }, (_, index) => index), offset: 150 });
    expect(last.truncated).toBe(false);
    expect(last.nextOffset).toBeNull();
  });

  it('fails HTTP 524 once, with the explanation in the error text', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(json([{ _id: 'cat-add', account: 'w1', name: 'Food', type: 2 }]))
      .mockResolvedValueOnce(json([{ _id: 'cat', account: 'w1', name: 'Food', type: 2 }]))
      .mockResolvedValueOnce(new Response('error code: 524', { status: 524 }));

    const error = await new MoneyloverClient('t', { requestTimeout: 150000 })
      .addTransaction({
        walletId: 'w1',
        categoryId: 'cat',
        amount: '0.01',
        date: '2026-10-08'
      })
      .catch((caught) => caught);

    expect(error).toMatchObject({ code: 'CLOUDFLARE' });
    expect(error.message).toMatch(/524/);
    expect(error.message).toMatch(/does not retry/);
    expect(global.fetch.mock.calls.filter((call) => String(call[0]).endsWith('/transaction/add'))).toHaveLength(1);
    const formatted = serverTest.formatError(error);
    expect(formatted.content[0].text).toMatch(/HTTP 524/);
    expect(formatted.content[0].text).toMatch(/does not retry/);
    expect(formatted.structuredContent.code).toBe('CLOUDFLARE');
    expect(timeoutForRequest('/transaction/add', { requestTimeout: 150000 })).toBe(20000);
    expect(timeoutForRequest('/wallet/list', { requestTimeout: 150000 })).toBe(150000);
  });

  it('reuses categories for the same wallet across clients', async () => {
    global.fetch = vi.fn(async (url) => {
      if (String(url).endsWith('/category/list')) {
        return json([{ _id: 'cat', account: 'w1', name: 'Food', type: 2 }]);
      }
      if (String(url).endsWith('/category/list-all')) {
        return json([{ _id: 'cat-add', account: 'w1', name: 'Food', type: 2 }]);
      }
      return json({ _id: 'new' });
    });
    const params = { walletId: 'w1', categoryId: 'cat', amount: '1', date: '2026-10-08', dryRun: true };
    const first = await new MoneyloverClient('t').addTransaction(params);
    await new MoneyloverClient('t').addTransaction(params);
    expect(first.payload.category).toBe('cat-add');
    expect(global.fetch.mock.calls.filter((call) => String(call[0]).endsWith('/category/list'))).toHaveLength(1);
    expect(global.fetch.mock.calls.filter((call) => String(call[0]).endsWith('/category/list-all'))).toHaveLength(1);
  });

  it('lists add-picker categories and keeps one list-all fetch for the process', async () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/category-picker.json', import.meta.url), 'utf8'));
    const shared = 'B012AA1D774D42B6A4C68A84B5977C4C';
    global.fetch = vi.fn(async (url) => {
      const path = String(url);
      if (path.endsWith('/category/list-all')) {
        return json(fixture.listAll);
      }
      if (path.endsWith('/category/list')) {
        return json(fixture.storedOrdi);
      }
      return json({});
    });

    const first = await new MoneyloverClient('t').listWalletCategories('ordi');
    const second = await new MoneyloverClient('t').listWalletCategories('tulip');
    expect(first.categories.map((category) => category.addId)).toEqual([shared, '800FD392', '30160C1B']);
    expect(first.unusable).toEqual([]);
    expect(second.categories.map((category) => category.name)).toEqual(['Bank fees']);
    expect(global.fetch.mock.calls.filter((call) => String(call[0]).endsWith('/category/list-all'))).toHaveLength(1);
    expect(global.fetch.mock.calls.some((call) => String(call[0]).endsWith('/category/list'))).toBe(false);

    const full = await new MoneyloverClient('t').listWalletCategories('ordi', { includeUnusable: true });
    expect(full.categories.find((category) => category.name === 'Bank fees').storedId).toBe(
      'FBD2B817A8DE4AE0B8BF8261006DCEC5'
    );
    expect(full.unusable.map((category) => [category.name, category.reason, category.code])).toEqual([
      ['Other Expense', 'not_in_list_all', 'CATEGORY_NOT_USABLE'],
      ['Old coffee', 'deleted', 'CATEGORY_NOT_USABLE']
    ]);
    expect(global.fetch.mock.calls.filter((call) => String(call[0]).endsWith('/category/list'))).toHaveLength(1);

    await expect(
      new MoneyloverClient('t').addTransaction({
        walletId: 'ordi',
        categoryId: '30BC0A0E515245EBAC29F55BAFDA1780',
        amount: '1',
        date: '2026-10-08',
        dryRun: true
      })
    ).rejects.toMatchObject({ code: 'CATEGORY_NOT_USABLE' });
    expect(global.fetch.mock.calls.some((call) => String(call[0]).endsWith('/transaction/add'))).toBe(false);
  });

  it('keeps duplicate stored ids and marks a name that matches two picker rows', async () => {
    global.fetch = vi.fn(async (url) => {
      const path = String(url);
      if (path.endsWith('/category/list-all')) {
        return json([
          { _id: 'cap-a', account: 'w1', name: 'Capital Investment', type: 2 },
          { _id: 'cap-b', account: 'w1', name: 'Capital Investment', type: 2 },
          { _id: 'fees', account: 'w1', name: 'Bank fees', type: 2 }
        ]);
      }
      if (path.endsWith('/category/list')) {
        return json([
          { _id: 'stored-a', account: 'w1', name: 'Capital Investment', type: 2, group: 0 },
          { _id: 'stored-b', account: 'w1', name: 'Capital Investment', type: 2, group: 0 },
          { _id: 'fees-1', account: 'w1', name: 'Bank fees', type: 2, group: 0 },
          { _id: 'fees-2', account: 'w1', name: 'Bank fees', type: 2, group: 0 },
          {
            _id: 'other',
            account: 'w1',
            name: 'Other Expense',
            metadata: 'IS_OTHER_EXPENSE',
            type: 2,
            group: 0
          }
        ]);
      }
      return json({});
    });

    const listed = await new MoneyloverClient('t').listWalletCategories('w1', { includeUnusable: true });
    expect(listed.categories.map((category) => category.addId)).toEqual(['cap-a', 'cap-b', 'fees']);
    expect(listed.categories.find((category) => category.name === 'Bank fees')).toMatchObject({
      storedId: 'fees-1',
      storedIds: ['fees-1', 'fees-2']
    });
    expect(listed.unusable.map((category) => [category.id, category.reason])).toEqual([
      ['stored-a', 'ambiguous'],
      ['stored-b', 'ambiguous'],
      ['other', 'not_in_list_all']
    ]);
    expect(listed.unusable[0].candidates).toEqual([
      { id: 'cap-a', addId: 'cap-a', name: 'Capital Investment', type: 2 },
      { id: 'cap-b', addId: 'cap-b', name: 'Capital Investment', type: 2 }
    ]);
    expect(global.fetch.mock.calls.filter((call) => String(call[0]).endsWith('/category/list-all'))).toHaveLength(1);
  });
});
