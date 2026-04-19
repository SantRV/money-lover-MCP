const BASE_URL = 'https://web.moneylover.me/api';
const LOGIN_URL = `${BASE_URL}/user/login-url`;
const TOKEN_URL = 'https://oauth.moneylover.me/token';

class MoneyloverApiError extends Error {
  constructor(message, { code, detail } = {}) {
    super(message);
    this.name = 'MoneyloverApiError';
    this.code = code ?? null;
    if (detail) {
      this.detail = detail;
    }
  }
}

const ensureString = (value, name) => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value.trim();
};

const ensureDateString = date => {
  if (!date) {
    throw new Error('date is required');
  }
  if (date instanceof Date) {
    if (Number.isNaN(date.getTime())) {
      throw new Error('date is invalid');
    }
    return date.toISOString().slice(0, 10);
  }
  if (typeof date === 'string') {
    const trimmed = date.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      throw new Error('date must be in YYYY-MM-DD format');
    }
    return trimmed;
  }
  throw new Error('date must be a Date or YYYY-MM-DD string');
};

const readJson = async response => {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch (error) {
    throw new Error(`Failed to parse JSON response: ${error.message}`);
  }
};

const parseApiPayload = payload => {
  const errorCode = payload?.error ?? payload?.e ?? 0;
  if (errorCode && errorCode !== 0) {
    const message = payload?.msg || payload?.message || 'Money Lover API error';
    throw new MoneyloverApiError(message, { code: errorCode, detail: payload });
  }
  return payload?.data ?? null;
};

export class MoneyloverClient {
  constructor(token, { requestTimeout = 30000 } = {}) {
    this.token = ensureString(token, 'token');
    this.requestTimeout = requestTimeout;
  }

  static async getToken(email, password) {
    const loginResponse = await fetch(LOGIN_URL, { method: 'POST' });
    if (!loginResponse.ok) {
      throw new Error(`Failed to initiate login: HTTP ${loginResponse.status}`);
    }

    const loginPayload = await readJson(loginResponse);
    const requestToken = loginPayload?.data?.request_token;
    const loginUrl = loginPayload?.data?.login_url;

    if (!requestToken || !loginUrl) {
      throw new Error('Login response missing request_token or login_url');
    }

    let clientParam = '';
    try {
      const parsed = new URL(loginUrl);
      clientParam = parsed.searchParams.get('client') ?? '';
    } catch (error) {
      throw new Error(`Unable to parse login URL: ${error.message}`);
    }

    if (!clientParam) {
      throw new Error('Login URL missing client parameter');
    }

    const form = new URLSearchParams();
    form.set('email', ensureString(email, 'email'));
    form.set('password', ensureString(password, 'password'));

    const tokenResponse = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${requestToken}`,
        Client: clientParam,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: form.toString()
    });

    if (!tokenResponse.ok) {
      throw new Error(`Failed to retrieve access token: HTTP ${tokenResponse.status}`);
    }

    const tokenPayload = await readJson(tokenResponse);
    const accessToken = tokenPayload?.access_token;
    if (!accessToken) {
      throw new Error('Access token not present in response');
    }
    return accessToken;
  }

  // ===== User =====

  async getUserInfo() {
    return this.#post('/user/info');
  }

  async getUserAccount() {
    return this.#post('/user/account');
  }

  async getUserProfile() {
    return this.#post('/user/get-profile');
  }

  // ===== Wallet =====

  async getWallets() {
    return this.#post('/wallet/list');
  }

  async getWalletBalance(walletId) {
    return this.#postJson('/wallet/balance', {
      walletId: ensureString(walletId, 'walletId')
    });
  }

  async getSharedWallets() {
    return this.#post('/wallet/share/list');
  }

  async getAwaitingSharedWallets() {
    return this.#post('/wallet/awaiting-shared');
  }

  async addWallet(params) {
    return this.#postJson('/wallet/add', {
      name: ensureString(params.name, 'name'),
      currency_id: typeof params.currencyId === 'number' ? params.currencyId : parseInt(params.currencyId, 10),
      icon: typeof params.icon === 'string' ? params.icon : 'icon_7'
    });
  }

  async editWallet(id, params = {}) {
    const payload = {
      _id: ensureString(id, 'walletId'),
      currency_id: typeof params.currencyId === 'number' ? params.currencyId : parseInt(ensureString(String(params.currencyId ?? ''), 'currencyId'), 10)
    };
    if (params.name != null) payload.name = ensureString(params.name, 'name');
    if (params.icon != null) payload.icon = ensureString(params.icon, 'icon');
    return this.#postJson('/wallet/edit', payload);
  }

  async deleteWallet(id) {
    return this.#postJson('/wallet/delete', { _id: ensureString(id, 'walletId') });
  }

  // ===== Category =====

  async getCategories(walletId) {
    const form = new URLSearchParams();
    form.set('walletId', ensureString(walletId, 'walletId'));
    return this.#post('/category/list', {
      body: form.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
  }

  async getAllCategories() {
    return this.#post('/category/list-all');
  }

  async addCategory(params) {
    return this.#postJson('/category/add', {
      walletId: ensureString(params.walletId, 'walletId'),
      name: ensureString(params.name, 'name'),
      icon: ensureString(params.icon, 'icon'),
      type: typeof params.type === 'number' ? params.type : 1
    });
  }

  async editCategory(id, params = {}) {
    const payload = {
      _id: ensureString(id, 'categoryId'),
      icon: ensureString(params.icon, 'icon')
    };
    if (params.name != null) payload.name = ensureString(params.name, 'name');
    return this.#postJson('/category/edit', payload);
  }

  async deleteCategory(id) {
    return this.#postJson('/category/delete', { _id: ensureString(id, 'categoryId') });
  }

  // ===== Transaction =====

  async getTransactions(walletId, startDate, endDate) {
    return this.#postJson('/transaction/list', {
      walletId: ensureString(walletId, 'walletId'),
      startDate: ensureString(startDate, 'startDate'),
      endDate: ensureString(endDate, 'endDate')
    });
  }

  async addTransaction(params) {
    if (!params || typeof params !== 'object') {
      throw new Error('params is required');
    }

    const walletId = ensureString(params.walletId ?? params.WalletID, 'walletId');
    const categoryId = ensureString(params.categoryId ?? params.CategoryID, 'categoryId');

    const payload = {
      with: Array.isArray(params.with) ? params.with : [],
      account: walletId,
      category: await this.#resolveGlobalCategoryId(walletId, categoryId),
      amount: ensureString(params.amount ?? params.Amount, 'amount'),
      note: typeof params.note === 'string' ? params.note : params.Note ?? '',
      displayDate: ensureDateString(params.date ?? params.Date)
    };

    return this.#postJson('/transaction/add', payload);
  }

  async editTransaction(id, params = {}) {
    const walletId = ensureString(params.walletId, 'walletId');
    const categoryId = ensureString(params.categoryId, 'categoryId');

    const payload = {
      _id: ensureString(id, 'transactionId'),
      account: walletId,
      category: await this.#resolveGlobalCategoryId(walletId, categoryId),
      amount: ensureString(params.amount, 'amount'),
      displayDate: ensureDateString(params.date),
      note: params.note != null ? String(params.note) : '',
      with: Array.isArray(params.with) ? params.with : []
    };

    return this.#postJson('/transaction/edit', payload);
  }

  async deleteTransaction(id) {
    return this.#postJson('/transaction/delete', { _id: ensureString(id, 'transactionId') });
  }

  async getTransactionSearchConfig() {
    return this.#postJson('/transaction/config-search', {});
  }

  async searchTransactions(filters = {}) {
    return this.#postJson('/transaction/search', filters);
  }

  async getDebtTransactions() {
    return this.#postJson('/transaction/debts', {});
  }

  async getRelatedTransactions(ids) {
    const idList = Array.isArray(ids) ? ids : [ids];
    if (idList.length === 0) {
      throw new Error('ids is required');
    }
    return this.#postJson('/transaction/related', {
      ids: idList.map(id => ensureString(id, 'transaction id'))
    });
  }

  async getRelatedTransactionsByCategory(categoryId) {
    return this.#postJson('/transaction/related-by-category', {
      categoryID: ensureString(categoryId, 'categoryId')
    });
  }

  async getRelatedTransactionsByWallet(walletId) {
    return this.#postJson('/transaction/related-by-wallet', {
      walletId: ensureString(walletId, 'walletId')
    });
  }



  // ===== Event =====

  async getEvents(walletId) {
    const wid = ensureString(walletId, 'walletId');
    return this.#post(`/event/list/${wid}`);
  }

  // ===== Debt =====

  async getDebts(walletId) {
    const wid = ensureString(walletId, 'walletId');
    return this.#post(`/debt/list/${wid}`);
  }

  // ===== Icons =====

  async getIcons(pack = 'default') {
    return this.#postJson('/icon/data', { pack });
  }

  // ===== Linked providers =====

  async getLinkedProviders() {
    return this.#post('/linked/provider');
  }

  // ===== Static config (GET, no error/data wrapper) =====

  async getCurrencies() {
    return this.#get('/other/currency');
  }

  async getExchangeRates() {
    return this.#get('/other/exchanger');
  }

  async getOtherConfig() {
    return this.#get('/other/config');
  }

  // ===== Internal =====

  async #resolveGlobalCategoryId(walletId, categoryId) {
    const allCats = await this.getAllCategories();
    const list = Array.isArray(allCats) ? allCats : Object.values(allCats ?? {});
    if (list.some(c => c._id === categoryId)) return categoryId;
    const walletCats = await this.getCategories(walletId);
    const walletList = Array.isArray(walletCats) ? walletCats : Object.values(walletCats ?? {});
    const match = walletList.find(c => c._id === categoryId);
    if (!match) return categoryId;
    const global = list.find(c => c.account === walletId && c.name === match.name && c.metadata === match.metadata);
    return global ? global._id : categoryId;
  }

  #authHeaders() {
    return {
      Authorization: `AuthJWT ${this.token}`,
      'Cache-Control': 'no-cache, max-age=0, no-store, no-transform, must-revalidate'
    };
  }

  #withTimeout(signal) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`Money Lover API request timed out after ${this.requestTimeout}ms`)),
      this.requestTimeout
    );
    if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); controller.abort(signal.reason); });
    return { signal: controller.signal, clear: () => clearTimeout(timer) };
  }

  async #post(path, { body, headers } = {}) {
    const requestHeaders = new Headers(this.#authHeaders());
    if (headers) {
      for (const [key, value] of Object.entries(headers)) {
        requestHeaders.set(key, value);
      }
    }

    const { signal, clear } = this.#withTimeout();
    let response;
    try {
      response = await fetch(`${BASE_URL}${path}`, {
        method: 'POST',
        headers: requestHeaders,
        body,
        signal
      });
    } catch (error) {
      clear();
      if (signal.aborted) {
        throw new MoneyloverApiError(
          `Request to ${path} timed out — the Money Lover server did not respond within ${this.requestTimeout}ms`,
          { code: 'TIMEOUT' }
        );
      }
      throw error;
    }
    clear();

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Money Lover API request failed: HTTP ${response.status} - ${detail}`);
    }

    const payload = await readJson(response);
    return parseApiPayload(payload);
  }

  async #postJson(path, data) {
    return this.#post(path, {
      body: JSON.stringify(data ?? {}),
      headers: { 'Content-Type': 'application/json' }
    });
  }

  async #get(path) {
    const { signal, clear } = this.#withTimeout();
    let response;
    try {
      response = await fetch(`${BASE_URL}${path}`, {
        method: 'GET',
        headers: new Headers(this.#authHeaders()),
        signal
      });
    } catch (error) {
      clear();
      if (signal.aborted) {
        throw new MoneyloverApiError(
          `Request to ${path} timed out — the Money Lover server did not respond within ${this.requestTimeout}ms`,
          { code: 'TIMEOUT' }
        );
      }
      throw error;
    }
    clear();

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Money Lover API request failed: HTTP ${response.status} - ${detail}`);
    }

    return readJson(response);
  }
}

export { MoneyloverApiError };

export const CategoryType = Object.freeze({
  INCOME: 1,
  EXPENSE: 2
});

export default MoneyloverClient;
