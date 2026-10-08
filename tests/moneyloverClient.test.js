import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MoneyloverClient, MoneyloverApiError } from '../src/moneyloverClient.js';

const { Response } = globalThis;

if (typeof Response === 'undefined') {
  throw new Error('Fetch Response implementation is required for these tests.');
}

const originalFetch = global.fetch;

describe('MoneyloverClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    global.fetch = vi.fn();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('retrieves a token via getToken', async () => {
    const firstResponse = new Response(
      JSON.stringify({
        data: {
          request_token: 'req-token',
          login_url: 'https://web.moneylover.me/login?client=abc123'
        },
        error: 0
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );

    const secondResponse = new Response(JSON.stringify({ access_token: 'jwt-token' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

    global.fetch.mockResolvedValueOnce(firstResponse).mockResolvedValueOnce(secondResponse);

    const token = await MoneyloverClient.getToken('user@example.com', 'password');

    expect(token).toBe('jwt-token');
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls[1][0]).toBe('https://oauth.moneylover.me/token');
  });

  it('throws when API returns an error payload', async () => {
    const response = new Response(JSON.stringify({ error: 1, msg: 'user_unauthenticated' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

    global.fetch.mockResolvedValueOnce(response);

    const client = new MoneyloverClient('token-123');
    await expect(client.getUserInfo()).rejects.toBeInstanceOf(MoneyloverApiError);
  });

  it('sends auth headers when calling protected endpoints', async () => {
    global.fetch.mockImplementation(async (_url, options) => {
      expect(options).toBeDefined();
      expect(options.method).toBe('POST');
      expect(options.headers.get('Authorization')).toBe('AuthJWT secure-token');
      return new Response(JSON.stringify({ error: 0, data: { email: 'user@example.com' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    });

    const client = new MoneyloverClient('secure-token');
    const data = await client.getUserInfo();

    expect(data).toEqual({ email: 'user@example.com' });
  });

  describe('read endpoints', () => {
    const jsonOk = (data) =>
      new Response(JSON.stringify({ error: 0, data }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });

    const captureCall = () => {
      const calls = [];
      global.fetch.mockImplementation(async (url, options) => {
        calls.push({ url, options });
        return jsonOk(calls.length);
      });
      return calls;
    };

    it('hits /user/account for device list', async () => {
      const calls = captureCall();
      await new MoneyloverClient('t').getUserAccount();
      expect(calls[0].url).toBe('https://web.moneylover.me/api/user/account');
      expect(calls[0].options.method).toBe('POST');
    });

    it('hits /user/get-profile', async () => {
      const calls = captureCall();
      await new MoneyloverClient('t').getUserProfile();
      expect(calls[0].url).toBe('https://web.moneylover.me/api/user/get-profile');
    });

    it('posts walletId JSON to /wallet/balance', async () => {
      const calls = captureCall();
      await new MoneyloverClient('t').getWalletBalance('wid-1');
      expect(calls[0].url).toBe('https://web.moneylover.me/api/wallet/balance');
      expect(calls[0].options.headers.get('Content-Type')).toBe('application/json');
      expect(JSON.parse(calls[0].options.body)).toEqual({ walletId: 'wid-1' });
    });

    it('rejects wallet balance without walletId', async () => {
      captureCall();
      await expect(new MoneyloverClient('t').getWalletBalance('')).rejects.toThrow(/walletId/);
    });

    it('hits /wallet/share/list and /wallet/awaiting-shared', async () => {
      const calls = captureCall();
      const client = new MoneyloverClient('t');
      await client.getSharedWallets();
      await client.getAwaitingSharedWallets();
      expect(calls.map((c) => c.url)).toEqual([
        'https://web.moneylover.me/api/wallet/share/list',
        'https://web.moneylover.me/api/wallet/awaiting-shared'
      ]);
    });

    it('sends form-encoded walletId to /category/list', async () => {
      const calls = captureCall();
      await new MoneyloverClient('t').getCategories('wid-1');
      expect(calls[0].url).toBe('https://web.moneylover.me/api/category/list');
      expect(calls[0].options.headers.get('Content-Type')).toBe('application/x-www-form-urlencoded');
      expect(calls[0].options.body).toBe('walletId=wid-1');
    });

    it('hits /category/list-all', async () => {
      const calls = captureCall();
      await new MoneyloverClient('t').getAllCategories();
      expect(calls[0].url).toBe('https://web.moneylover.me/api/category/list-all');
    });

    it('posts empty body to /transaction/config-search', async () => {
      const calls = captureCall();
      await new MoneyloverClient('t').getTransactionSearchConfig();
      expect(calls[0].url).toBe('https://web.moneylover.me/api/transaction/config-search');
      expect(JSON.parse(calls[0].options.body)).toEqual({});
    });

    it('forwards arbitrary filters to /transaction/search', async () => {
      const calls = captureCall();
      await new MoneyloverClient('t').searchTransactions({ walletId: 'wid', amountGT: 1000 });
      expect(calls[0].url).toBe('https://web.moneylover.me/api/transaction/search');
      expect(JSON.parse(calls[0].options.body)).toEqual({ walletId: 'wid', amountGT: 1000 });
    });

    it('hits /transaction/debts', async () => {
      const calls = captureCall();
      await new MoneyloverClient('t').getDebtTransactions();
      expect(calls[0].url).toBe('https://web.moneylover.me/api/transaction/debts');
    });

    it('wraps single id into array for /transaction/related', async () => {
      const calls = captureCall();
      await new MoneyloverClient('t').getRelatedTransactions('txn-1');
      expect(JSON.parse(calls[0].options.body)).toEqual({ ids: ['txn-1'] });
    });

    it('accepts an array of ids for /transaction/related', async () => {
      const calls = captureCall();
      await new MoneyloverClient('t').getRelatedTransactions(['a', 'b']);
      expect(JSON.parse(calls[0].options.body)).toEqual({ ids: ['a', 'b'] });
    });

    it('rejects empty id list for /transaction/related', async () => {
      captureCall();
      await expect(new MoneyloverClient('t').getRelatedTransactions([])).rejects.toThrow(/ids/);
    });

    it('sends categoryID to /transaction/related-by-category', async () => {
      const calls = captureCall();
      await new MoneyloverClient('t').getRelatedTransactionsByCategory('cat-1');
      expect(calls[0].url).toBe('https://web.moneylover.me/api/transaction/related-by-category');
      expect(JSON.parse(calls[0].options.body)).toEqual({ categoryID: 'cat-1' });
    });

    it('sends walletId to /transaction/related-by-wallet', async () => {
      const calls = captureCall();
      await new MoneyloverClient('t').getRelatedTransactionsByWallet('wid');
      expect(calls[0].url).toBe('https://web.moneylover.me/api/transaction/related-by-wallet');
      expect(JSON.parse(calls[0].options.body)).toEqual({ walletId: 'wid' });
    });

    it('interpolates walletId into /event/list/{walletId}', async () => {
      const calls = captureCall();
      await new MoneyloverClient('t').getEvents('wid-e');
      expect(calls[0].url).toBe('https://web.moneylover.me/api/event/list/wid-e');
    });

    it('interpolates walletId into /debt/list/{walletId}', async () => {
      const calls = captureCall();
      await new MoneyloverClient('t').getDebts('wid-d');
      expect(calls[0].url).toBe('https://web.moneylover.me/api/debt/list/wid-d');
    });

    it('defaults icon pack to "default"', async () => {
      const calls = captureCall();
      await new MoneyloverClient('t').getIcons();
      expect(calls[0].url).toBe('https://web.moneylover.me/api/icon/data');
      expect(JSON.parse(calls[0].options.body)).toEqual({ pack: 'default' });
    });

    it('forwards custom icon pack', async () => {
      const calls = captureCall();
      await new MoneyloverClient('t').getIcons('holiday');
      expect(JSON.parse(calls[0].options.body)).toEqual({ pack: 'holiday' });
    });

    it('hits /linked/provider', async () => {
      const calls = captureCall();
      await new MoneyloverClient('t').getLinkedProviders();
      expect(calls[0].url).toBe('https://web.moneylover.me/api/linked/provider');
    });

    it('issues GET requests for /other/currency, /other/exchanger, /other/config', async () => {
      const calls = [];
      global.fetch.mockImplementation(async (url, options) => {
        calls.push({ url, options });
        return new Response(JSON.stringify({ hello: 'world' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      });

      const client = new MoneyloverClient('t');
      await client.getCurrencies();
      await client.getExchangeRates();
      await client.getOtherConfig();

      expect(calls.map((c) => c.options.method)).toEqual(['GET', 'GET', 'GET']);
      expect(calls.map((c) => c.url)).toEqual([
        'https://web.moneylover.me/api/other/currency',
        'https://web.moneylover.me/api/other/exchanger',
        'https://web.moneylover.me/api/other/config'
      ]);
      for (const { options } of calls) {
        expect(options.headers.get('Authorization')).toBe('AuthJWT t');
        expect(options.body).toBeUndefined();
      }
    });

    it('returns raw body for GET endpoints (no error/data unwrapping)', async () => {
      global.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ rates: { EUR: 0.9 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      );
      const data = await new MoneyloverClient('t').getExchangeRates();
      expect(data).toEqual({ rates: { EUR: 0.9 } });
    });

    it('throws MoneyloverApiError when a read endpoint returns error != 0', async () => {
      global.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 1, msg: 'user_unauthenticated' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      );
      await expect(new MoneyloverClient('t').getUserAccount()).rejects.toBeInstanceOf(MoneyloverApiError);
    });
  });

  describe('mutation endpoints', () => {
    const ok = (data) =>
      new Response(JSON.stringify({ error: 0, msg: 'success', data }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });

    const allCatsOk = (cats) =>
      new Response(JSON.stringify({ error: 0, data: cats }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });

    it('addTransaction resolves global category and sends full payload to /transaction/add', async () => {
      global.fetch.mockResolvedValueOnce(
        allCatsOk([{ _id: 'cat-g1', account: 'w1', name: 'Food', metadata: 'food0', type: 2 }])
      );
      global.fetch.mockResolvedValueOnce(
        allCatsOk([{ _id: 'cat-g1', account: 'w1', name: 'Food', metadata: 'food0', type: 2 }])
      );
      global.fetch.mockResolvedValueOnce(ok({ _id: 'new-txn' }));

      const data = await new MoneyloverClient('t').addTransaction({
        walletId: 'w1',
        categoryId: 'cat-g1',
        amount: '5000',
        date: '2026-04-18',
        note: 'test'
      });
      expect(data).toEqual({ _id: 'new-txn' });
      expect(global.fetch).toHaveBeenCalledTimes(3);
      expect(global.fetch.mock.calls[0][0]).toBe('https://web.moneylover.me/api/category/list');
      expect(global.fetch.mock.calls[1][0]).toBe('https://web.moneylover.me/api/category/list-all');
      const body = JSON.parse(global.fetch.mock.calls[2][1].body);
      expect(body.account).toBe('w1');
      expect(body.category).toBe('cat-g1');
      expect(body.amount).toBe('5000');
      expect(body.displayDate).toBe('2026-04-18');
      expect(body.note).toBe('test');
    });

    it('addTransaction resolves wallet-specific category to global ID', async () => {
      global.fetch.mockResolvedValueOnce(
        allCatsOk([{ _id: 'cat-w1', account: 'w1', name: 'Food', metadata: 'food0', type: 2 }])
      );
      global.fetch.mockResolvedValueOnce(
        allCatsOk([{ _id: 'cat-g1', account: 'w1', name: 'Food', metadata: 'food0', type: 2 }])
      );
      global.fetch.mockResolvedValueOnce(ok({ _id: 'new-txn' }));

      await new MoneyloverClient('t').addTransaction({
        walletId: 'w1',
        categoryId: 'cat-w1',
        amount: '5000',
        date: '2026-04-18',
        note: 'test'
      });
      expect(global.fetch).toHaveBeenCalledTimes(3);
      const body = JSON.parse(global.fetch.mock.calls[2][1].body);
      expect(body.category).toBe('cat-g1');
    });

    it('sends a positive magnitude for a negative expense and keeps the calendar date', async () => {
      global.fetch.mockResolvedValueOnce(
        allCatsOk([{ _id: 'cat-g1', account: 'w1', name: 'Food', metadata: 'food0', type: 2 }])
      );
      global.fetch.mockResolvedValueOnce(
        allCatsOk([{ _id: 'cat-g1', account: 'w1', name: 'Food', metadata: 'food0', type: 2 }])
      );
      global.fetch.mockResolvedValueOnce(ok({ _id: 'new-txn' }));

      const adelaideEvening = new Date('2026-04-17T15:00:00.000Z');
      await new MoneyloverClient('t', { timeZone: 'Australia/Adelaide' }).addTransaction({
        walletId: 'w1',
        categoryId: 'cat-g1',
        amount: '-12.50',
        date: adelaideEvening,
        note: 'Cafe'
      });
      const body = JSON.parse(global.fetch.mock.calls[2][1].body);
      expect(body.amount).toBe('12.50');
      expect(body.displayDate).toBe('2026-04-18');
    });

    it('refuses a negative amount on an income category', async () => {
      global.fetch.mockResolvedValueOnce(
        allCatsOk([{ _id: 'cat-in', account: 'w1', name: 'Salary', metadata: 'salary', type: 1 }])
      );
      global.fetch.mockResolvedValueOnce(
        allCatsOk([{ _id: 'cat-in', account: 'w1', name: 'Salary', metadata: 'salary', type: 1 }])
      );

      await expect(
        new MoneyloverClient('t').addTransaction({
          walletId: 'w1',
          categoryId: 'cat-in',
          amount: '-100',
          date: '2026-04-18',
          note: 'Refund?'
        })
      ).rejects.toThrow(/income/);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('editTransaction loads the row and writes the fields the web app keeps', async () => {
      global.fetch.mockResolvedValueOnce(
        ok({
          transactions: [
            {
              _id: 'txn1',
              account: { _id: 'w1' },
              category: { _id: 'cat-g1', type: 2, name: 'Food' },
              amount: '10',
              note: 'old',
              displayDate: '2026-04-18T00:00:00.000Z',
              with: ['sam'],
              exclude_report: true,
              event: { _id: 'event-1' },
              images: ['pic.jpg'],
              remind: 1710000000,
              longtitude: '138.6',
              latitude: '-34.9',
              addressName: 'Adelaide',
              parent: { _id: 'debt-1' }
            }
          ]
        })
      );
      global.fetch.mockResolvedValueOnce(ok({ _id: 'txn1' }));

      const data = await new MoneyloverClient('t').editTransaction('txn1', {
        walletId: 'w1',
        currentDate: '2026-04-18',
        amount: '999',
        note: 'updated'
      });
      expect(data).toEqual({ _id: 'txn1' });
      const editCall = global.fetch.mock.calls.find((call) => String(call[0]).endsWith('/transaction/edit'));
      const body = JSON.parse(editCall[1].body);
      expect(body).toMatchObject({
        _id: 'txn1',
        account: 'w1',
        category: 'cat-g1',
        amount: '999',
        note: 'updated',
        displayDate: '2026-04-18',
        with: ['sam'],
        exclude_report: true,
        event: 'event-1',
        image: 'pic.jpg',
        remind: 1710000000,
        longtitude: '138.6',
        latitude: '-34.9',
        addressName: 'Adelaide',
        parent: 'debt-1'
      });
    });

    it('editTransaction refuses to write when the existing row cannot be loaded', async () => {
      global.fetch.mockResolvedValueOnce(ok({ transactions: [] }));
      global.fetch.mockResolvedValueOnce(ok([]));
      await expect(
        new MoneyloverClient('t').editTransaction('txn1', {
          walletId: 'w1',
          currentDate: '2026-04-18',
          note: 'updated'
        })
      ).rejects.toThrow(/Could not load transaction/);
      expect(global.fetch.mock.calls.some((call) => String(call[0]).endsWith('/transaction/edit'))).toBe(false);
    });

    it('treats HTTP 401 as an authentication error and does not echo the body token', async () => {
      global.fetch.mockResolvedValueOnce(
        new Response('access_token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature', { status: 401 })
      );
      const error = await new MoneyloverClient('t').getUserInfo().then(
        () => null,
        (caught) => caught
      );
      expect(error).toMatchObject({ name: 'MoneyloverApiError', code: 401 });
      expect(String(error.detail)).not.toContain('eyJ');
      expect(error.message).not.toContain('eyJ');
    });

    it('deleteTransaction sends _id to /transaction/delete', async () => {
      global.fetch.mockResolvedValueOnce(ok({}));
      await new MoneyloverClient('t').deleteTransaction('txn1');
      const body = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(body).toEqual({ _id: 'txn1' });
    });

    it('addWallet sends name, currency_id, and icon to /wallet/add', async () => {
      global.fetch.mockResolvedValueOnce(ok({ _id: 'w1' }));
      await new MoneyloverClient('t').addWallet({ name: 'Cash', currencyId: 1, icon: 'icon_7' });
      const body = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(body.name).toBe('Cash');
      expect(body.currency_id).toBe(1);
      expect(body.icon).toBe('icon_7');
    });

    it('editWallet keeps credit, exclude-from-total, and archived flags', async () => {
      global.fetch.mockResolvedValueOnce(
        ok([
          {
            _id: 'w1',
            name: 'Card',
            icon: 'icon_9',
            currency_id: 20,
            account_type: 4,
            exclude_total: true,
            archived: false
          }
        ])
      );
      global.fetch.mockResolvedValueOnce(ok({}));
      await new MoneyloverClient('t').editWallet('w1', { name: 'NewName' });
      const editCall = global.fetch.mock.calls.find((call) => String(call[0]).endsWith('/wallet/edit'));
      expect(JSON.parse(editCall[1].body)).toEqual({
        _id: 'w1',
        name: 'NewName',
        icon: 'icon_9',
        currency_id: 20,
        account_type: 4,
        exclude_total: true,
        archived: false
      });
    });

    it('deleteWallet sends _id to /wallet/delete', async () => {
      global.fetch.mockResolvedValueOnce(ok({}));
      await new MoneyloverClient('t').deleteWallet('w1');
      const body = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(body).toEqual({ _id: 'w1' });
    });

    it('addCategory sends walletId, name, icon, type to /category/add', async () => {
      global.fetch.mockResolvedValueOnce(ok({ _id: 'cat1' }));
      await new MoneyloverClient('t').addCategory({ walletId: 'w1', name: 'Food', icon: 'ic_food', type: 1 });
      const body = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(body.walletId).toBe('w1');
      expect(body.name).toBe('Food');
      expect(body.icon).toBe('ic_food');
      expect(body.type).toBe(1);
    });

    it('addCategory accepts type "2" as expense', async () => {
      global.fetch.mockResolvedValueOnce(ok({ _id: 'cat2' }));
      await new MoneyloverClient('t').addCategory({ walletId: 'w1', name: 'Gym', icon: 'icon_3', type: '2' });
      const body = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(body.type).toBe(2);
    });

    it('editCategory sends _id, icon (required), and optional name to /category/edit', async () => {
      global.fetch.mockResolvedValueOnce(ok({}));
      await new MoneyloverClient('t').editCategory('cat1', { name: 'Groceries', icon: 'icon_3' });
      const body = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(body._id).toBe('cat1');
      expect(body.icon).toBe('icon_3');
      expect(body.name).toBe('Groceries');
    });

    it('deleteCategory sends _id to /category/delete', async () => {
      global.fetch.mockResolvedValueOnce(ok({}));
      await new MoneyloverClient('t').deleteCategory('cat1');
      const body = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(body).toEqual({ _id: 'cat1' });
    });
  });
});
