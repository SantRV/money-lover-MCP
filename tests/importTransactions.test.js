import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MoneyloverApiError, MoneyloverClient } from '../src/moneyloverClient.js';
import { createTransactions, errorFromTransactionRow } from '../src/transactions.js';
import { __test as serverTest } from '../src/server.js';

const json = (data) =>
  new Response(JSON.stringify({ error: 0, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });

const walletCategories = [{ _id: 'local-food', name: 'Food', type: 2, account: 'w1', metadata: 'food0' }];
const globalCategories = [{ _id: 'global-food', name: 'Food', type: 2, account: 'w1', metadata: 'food0' }];

describe('createTransactions', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('skips a duplicate and reports the existing id', async () => {
    global.fetch
      .mockResolvedValueOnce(
        json({
          transactions: [
            {
              _id: 'existing',
              amount: 12.5,
              note: 'Cafe Royal',
              displayDate: '2026-04-18T00:00:00.000Z'
            }
          ]
        })
      )
      .mockResolvedValueOnce(json(walletCategories))
      .mockResolvedValueOnce(json(globalCategories));

    const summary = await createTransactions(new MoneyloverClient('token'), {
      walletId: 'w1',
      skipDuplicates: true,
      transactions: [{ date: '2026-04-18', amount: '-12.50', note: 'cafe royal', category: 'Food' }]
    });

    expect(summary.skipped).toBe(1);
    expect(summary.created).toBe(0);
    expect(summary.results[0]).toMatchObject({ status: 'skipped_duplicate', matchId: 'existing', amount: '12.50' });
    expect(global.fetch.mock.calls.some((call) => String(call[0]).endsWith('/transaction/add'))).toBe(false);
  });

  it('creates the first row and skips the second copy in the same batch', async () => {
    global.fetch
      .mockResolvedValueOnce(json({ transactions: [] }))
      .mockResolvedValueOnce(json(globalCategories))
      .mockResolvedValueOnce(json(walletCategories))
      .mockResolvedValueOnce(json({ _id: 'created-1' }));

    const summary = await createTransactions(new MoneyloverClient('token', { timeZone: 'Australia/Adelaide' }), {
      walletId: 'w1',
      transactions: [
        { date: '18/04/2026', amount: '12.50', note: 'Cafe', categoryId: 'local-food', dateOrder: 'DMY' },
        { date: '2026-04-18', amount: '-12.50', note: 'Cafe', category: 'Food' }
      ],
      dateOrder: 'DMY'
    });

    expect(summary.results.map((row) => row.status)).toEqual(['created', 'skipped_duplicate']);
    expect(summary.results[0].id).toBe('created-1');
    const post = global.fetch.mock.calls.find((call) => String(call[0]).endsWith('/transaction/add'));
    expect(JSON.parse(post[1].body).displayDate).toBe('2026-04-18');
    expect(JSON.parse(post[1].body).amount).toBe(12.5);
    expect(JSON.parse(post[1].body).category).toBe('global-food');
  });

  it('previews a batch without posting', async () => {
    global.fetch.mockResolvedValueOnce(json(globalCategories)).mockResolvedValueOnce(json(walletCategories));

    const summary = await createTransactions(new MoneyloverClient('token'), {
      walletId: 'w1',
      dryRun: true,
      skipDuplicates: false,
      transactions: [{ date: '2026-04-18', amount: '9', note: 'Bus', categoryId: 'global-food' }]
    });

    expect(summary.previewed).toBe(1);
    expect(summary.results[0].payload).toMatchObject({
      account: 'w1',
      category: 'global-food',
      amount: 9,
      displayDate: '2026-04-18'
    });
    expect(global.fetch.mock.calls.some((call) => String(call[0]).endsWith('/transaction/add'))).toBe(false);
  });

  it('keeps going when one row fails', async () => {
    global.fetch
      .mockResolvedValueOnce(json(walletCategories))
      .mockResolvedValueOnce(json(globalCategories))
      .mockResolvedValueOnce(json({ _id: 'created-2' }));

    const summary = await createTransactions(new MoneyloverClient('token'), {
      walletId: 'w1',
      skipDuplicates: false,
      transactions: [
        { date: 'not-a-date', amount: '5', note: 'Bad', categoryId: 'global-food' },
        { date: '2026-04-19', amount: '5', note: 'Good', categoryId: 'global-food' }
      ]
    });

    expect(summary.failed).toBe(1);
    expect(summary.created).toBe(1);
    expect(summary.results[0].status).toBe('error');
    expect(summary.results[1].status).toBe('created');
  });

  it('keeps TIMEOUT and CLOUDFLARE on a failed add row', async () => {
    const client = {
      prepareTransaction: async () => ({
        payload: { note: '', category: 'add-id', amount: 0.01 },
        date: '2026-10-08',
        cents: 1,
        amountText: '0.01',
        note: '',
        categoryId: 'add-id',
        direction: 'expense',
        warnings: []
      }),
      addPreparedTransaction: async () => {
        throw new MoneyloverApiError('POST /transaction/add did not answer within 20000ms', { code: 'TIMEOUT' });
      }
    };
    const summary = await createTransactions(client, {
      walletId: 'w1',
      skipDuplicates: false,
      transactions: [{ date: '2026-10-08', amount: '0.01', note: '', categoryId: 'stored' }]
    });
    expect(summary.results[0]).toMatchObject({ status: 'error', code: 'TIMEOUT', name: 'MoneyloverApiError' });
    const formatted = serverTest.formatError(errorFromTransactionRow(summary.results[0]));
    expect(formatted.structuredContent.code).toBe('TIMEOUT');
    expect(formatted.structuredContent.error).toBe('MoneyloverApiError');
    expect(formatted.content[0].text).toMatch(/TIMEOUT/);

    const cloudflare = errorFromTransactionRow({
      message: 'HTTP 524',
      code: 'CLOUDFLARE',
      name: 'MoneyloverApiError'
    });
    const cloudflareFormatted = serverTest.formatError(cloudflare);
    expect(cloudflareFormatted.structuredContent).toMatchObject({
      error: 'MoneyloverApiError',
      code: 'CLOUDFLARE'
    });
  });
});
