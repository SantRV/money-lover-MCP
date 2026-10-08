import { prepareAmount, amountCents } from './amounts.js';
import {
  CategoryType,
  coerceCategoryType,
  matchGlobalCategory,
  selectCategory,
  summarizeCategory,
  unwrapList
} from './categories.js';
import { calendarDate, safeCalendarDate } from './dates.js';
import { clip, redact } from './redact.js';
import { isAuthError } from './authError.js';

const BASE_URL = 'https://web.moneylover.me/api';
const LOGIN_URL = `${BASE_URL}/user/login-url`;
const TOKEN_URL = 'https://oauth.moneylover.me/token';

class MoneyloverApiError extends Error {
  constructor(message, { code, detail } = {}) {
    super(message);
    this.name = 'MoneyloverApiError';
    this.code = code ?? null;
    if (detail != null) {
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

const ensureDateString = (date, options) => calendarDate(date, options);

const readJson = async (response) => {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch (error) {
    throw new Error(`Failed to parse JSON response: ${error.message}`, { cause: error });
  }
};

const parseApiPayload = (payload) => {
  const errorCode = payload?.error ?? payload?.e ?? 0;
  const numeric = typeof errorCode === 'string' && errorCode.trim() !== '' ? Number(errorCode) : errorCode;
  const failed = numeric !== 0 && numeric !== '0' && Boolean(errorCode);
  if (failed) {
    const message = payload?.msg || payload?.message || 'Money Lover API error';
    throw new MoneyloverApiError(String(message), {
      code: Number.isFinite(numeric) ? numeric : errorCode,
      detail: redact(payload)
    });
  }
  return payload?.data ?? null;
};

const resolutionWarning = (source) => {
  if (source === 'passthrough') {
    return 'Category id was not found on this wallet. It was sent unchanged.';
  }
  if (source === 'wallet' || source === 'wallet-name') {
    return 'No matching global category id was found. The wallet category id was sent. Money Lover may reject a wallet-local id.';
  }
  return null;
};

export class MoneyloverClient {
  constructor(token, { requestTimeout = 30000, timeZone } = {}) {
    this.token = ensureString(token, 'token');
    this.requestTimeout = requestTimeout;
    this.timeZone = timeZone;
    this.#walletCategoryCache = new Map();
    this.#globalCategoriesCache = null;
  }

  #walletCategoryCache;
  #globalCategoriesCache;

  static async getToken(email, password) {
    const loginResponse = await fetch(LOGIN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    if (!loginResponse.ok) {
      throw new Error(`Failed to initiate login: HTTP ${loginResponse.status}`);
    }

    const loginPayload = await readJson(loginResponse);
    const requestToken = loginPayload?.data?.request_token;
    const loginUrl = loginPayload?.data?.login_url;

    if (!requestToken || !loginUrl) {
      throw new Error('Login response missing request_token or login_url');
    }

    let clientParam;
    try {
      const parsed = new URL(loginUrl);
      clientParam = parsed.searchParams.get('client') ?? '';
    } catch (error) {
      throw new Error(`Unable to parse login URL: ${error.message}`, { cause: error });
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
      const message =
        tokenPayload?.error_description ||
        tokenPayload?.message ||
        tokenPayload?.msg ||
        'Access token not present in response';
      throw new Error(clip(message));
    }
    return accessToken;
  }

  async getUserInfo() {
    return this.#post('/user/info');
  }

  async getUserAccount() {
    return this.#post('/user/account');
  }

  async getUserProfile() {
    return this.#post('/user/get-profile');
  }

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
    const payload = {
      name: ensureString(params.name, 'name'),
      currency_id: typeof params.currencyId === 'number' ? params.currencyId : Number.parseInt(params.currencyId, 10),
      icon: typeof params.icon === 'string' && params.icon.trim() ? params.icon.trim() : 'icon_7'
    };
    if (!Number.isInteger(payload.currency_id)) {
      throw new Error('currencyId must be an integer');
    }
    if (params.dryRun === true) {
      return { dryRun: true, endpoint: '/wallet/add', payload };
    }
    return this.#postJson('/wallet/add', payload);
  }

  async editWallet(id, params = {}) {
    const payload = {
      _id: ensureString(id, 'walletId'),
      currency_id:
        typeof params.currencyId === 'number'
          ? params.currencyId
          : Number.parseInt(ensureString(String(params.currencyId ?? ''), 'currencyId'), 10)
    };
    if (!Number.isInteger(payload.currency_id)) {
      throw new Error('currencyId must be an integer');
    }
    if (params.name != null) {
      payload.name = ensureString(params.name, 'name');
    }
    if (params.icon != null) {
      payload.icon = ensureString(params.icon, 'icon');
    }
    if (params.dryRun === true) {
      return { dryRun: true, endpoint: '/wallet/edit', payload };
    }
    return this.#postJson('/wallet/edit', payload);
  }

  async deleteWallet(id, { dryRun = false } = {}) {
    const payload = { _id: ensureString(id, 'walletId') };
    if (dryRun) {
      return { dryRun: true, endpoint: '/wallet/delete', payload };
    }
    return this.#postJson('/wallet/delete', payload);
  }

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

  async listWalletCategories(walletId) {
    const categories = await this.#walletCategories(walletId);
    return categories.map(summarizeCategory);
  }

  async addCategory(params) {
    const payload = {
      walletId: ensureString(params.walletId, 'walletId'),
      name: ensureString(params.name, 'name'),
      icon: ensureString(params.icon, 'icon'),
      type: coerceCategoryType(params.type)
    };
    if (params.dryRun === true) {
      return { dryRun: true, endpoint: '/category/add', payload };
    }
    const created = await this.#postJson('/category/add', payload);
    this.#walletCategoryCache.delete(payload.walletId);
    this.#globalCategoriesCache = null;
    return created;
  }

  async editCategory(id, params = {}) {
    const payload = {
      _id: ensureString(id, 'categoryId'),
      icon: ensureString(params.icon, 'icon')
    };
    if (params.name != null) {
      payload.name = ensureString(params.name, 'name');
    }
    if (params.dryRun === true) {
      return { dryRun: true, endpoint: '/category/edit', payload };
    }
    return this.#postJson('/category/edit', payload);
  }

  async deleteCategory(id, { dryRun = false } = {}) {
    const payload = { _id: ensureString(id, 'categoryId') };
    if (dryRun) {
      return { dryRun: true, endpoint: '/category/delete', payload };
    }
    return this.#postJson('/category/delete', payload);
  }

  async getTransactions(walletId, startDate, endDate) {
    return this.#postJson('/transaction/list', {
      walletId: ensureString(walletId, 'walletId'),
      startDate: ensureDateString(startDate, { timeZone: this.timeZone }),
      endDate: ensureDateString(endDate, { timeZone: this.timeZone })
    });
  }

  async #walletCategories(walletId) {
    if (!this.#walletCategoryCache.has(walletId)) {
      this.#walletCategoryCache.set(walletId, unwrapList(await this.getCategories(walletId)));
    }
    return this.#walletCategoryCache.get(walletId);
  }

  async #globalCategories() {
    if (this.#globalCategoriesCache) {
      return this.#globalCategoriesCache;
    }
    try {
      this.#globalCategoriesCache = unwrapList(await this.getAllCategories());
    } catch {
      this.#globalCategoriesCache = [];
    }
    return this.#globalCategoriesCache;
  }

  async #resolveCategory(walletId, { categoryId, categoryName, direction }) {
    const walletList = await this.#walletCategories(walletId);
    const globalList = await this.#globalCategories();
    return selectCategory(walletList, globalList, walletId, { categoryId, categoryName, direction });
  }

  async prepareTransaction(params) {
    if (!params || typeof params !== 'object') {
      throw new Error('params is required');
    }

    const walletId = ensureString(params.walletId ?? params.WalletID, 'walletId');
    const date = ensureDateString(params.date ?? params.Date, {
      timeZone: params.timeZone ?? this.timeZone,
      dateOrder: params.dateOrder
    });
    const note = typeof params.note === 'string' ? params.note : (params.Note ?? '');
    const withParties = Array.isArray(params.with) ? params.with.map((value) => String(value)) : [];
    const amountMode = params.amountMode === 'signed' ? 'signed' : 'magnitude';
    const rawAmount = params.amount ?? params.Amount;
    const parsedPreview = prepareAmount(rawAmount, null, { amountMode: 'magnitude' });
    const direction =
      params.direction === 'income' || params.direction === 'expense'
        ? params.direction
        : amountMode === 'signed'
          ? parsedPreview.negative
            ? 'expense'
            : 'income'
          : undefined;

    const resolved = await this.#resolveCategory(walletId, {
      categoryId: params.categoryId ?? params.CategoryID,
      categoryName: params.category ?? params.categoryName,
      direction
    });
    const amount = prepareAmount(rawAmount, resolved.category?.type, { amountMode });
    const warnings = [...amount.warnings];
    const warning = resolutionWarning(resolved.source);
    if (warning) {
      warnings.push(warning);
    }
    if (amount.direction !== 'unknown' && direction && amount.direction !== direction) {
      warnings.push(
        `Amount sign implies ${direction}, but the category is ${amount.direction}. The category type is what Money Lover will use.`
      );
    }

    const payload = {
      with: withParties,
      account: walletId,
      category: resolved.id,
      amount: amount.amount,
      note,
      displayDate: date
    };

    return {
      payload,
      date,
      cents: amountCents(amount.amount),
      note,
      categoryId: resolved.id,
      categoryType: resolved.category?.type ?? null,
      direction: amount.direction,
      warnings,
      source: resolved.source
    };
  }

  async addPreparedTransaction(prepared) {
    return this.#postJson('/transaction/add', prepared.payload);
  }

  async addTransaction(params) {
    const prepared = await this.prepareTransaction(params);
    if (params.dryRun === true) {
      return {
        dryRun: true,
        endpoint: '/transaction/add',
        payload: prepared.payload,
        categoryId: prepared.categoryId,
        direction: prepared.direction,
        warnings: prepared.warnings
      };
    }
    const created = await this.addPreparedTransaction(prepared);
    if (prepared.warnings.length === 0) {
      return created;
    }
    if (created && typeof created === 'object' && !Array.isArray(created)) {
      return { ...created, warnings: prepared.warnings };
    }
    return { result: created, warnings: prepared.warnings };
  }

  async editTransaction(id, params = {}) {
    if (params.note == null) {
      throw new Error(
        'edit_transaction replaces the whole transaction. Pass note (use an empty string to clear it) so the existing note is not wiped.'
      );
    }
    if (!Array.isArray(params.with)) {
      throw new Error(
        'edit_transaction replaces the whole transaction. Pass with (use an empty array to clear related parties).'
      );
    }

    const walletId = ensureString(params.walletId, 'walletId');
    const date = ensureDateString(params.date, { timeZone: params.timeZone ?? this.timeZone });
    const resolved = await this.#resolveCategory(walletId, {
      categoryId: params.categoryId,
      categoryName: params.category
    });
    const amount = prepareAmount(params.amount, resolved.category?.type, {
      amountMode: params.amountMode === 'signed' ? 'signed' : 'magnitude'
    });
    const payload = {
      _id: ensureString(id, 'transactionId'),
      account: walletId,
      category: resolved.id,
      amount: amount.amount,
      displayDate: date,
      note: String(params.note),
      with: params.with.map((value) => String(value))
    };
    const warnings = [...amount.warnings];
    const warning = resolutionWarning(resolved.source);
    if (warning) {
      warnings.push(warning);
    }
    if (params.dryRun === true) {
      return { dryRun: true, endpoint: '/transaction/edit', payload, warnings };
    }
    const updated = await this.#postJson('/transaction/edit', payload);
    if (warnings.length === 0) {
      return updated;
    }
    if (updated && typeof updated === 'object' && !Array.isArray(updated)) {
      return { ...updated, warnings };
    }
    return { result: updated, warnings };
  }

  async deleteTransaction(id, { dryRun = false } = {}) {
    const payload = { _id: ensureString(id, 'transactionId') };
    if (dryRun) {
      return { dryRun: true, endpoint: '/transaction/delete', payload };
    }
    return this.#postJson('/transaction/delete', payload);
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
      ids: idList.map((id) => ensureString(id, 'transaction id'))
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

  async getEvents(walletId) {
    const wid = encodeURIComponent(ensureString(walletId, 'walletId'));
    return this.#post(`/event/list/${wid}`);
  }

  async getDebts(walletId) {
    const wid = encodeURIComponent(ensureString(walletId, 'walletId'));
    return this.#post(`/debt/list/${wid}`);
  }

  async getIcons(pack = 'default') {
    return this.#postJson('/icon/data', { pack });
  }

  async getLinkedProviders() {
    return this.#post('/linked/provider');
  }

  async getCurrencies() {
    return this.#get('/other/currency');
  }

  async getExchangeRates() {
    return this.#get('/other/exchanger');
  }

  async getOtherConfig() {
    return this.#get('/other/config');
  }

  presentTransaction(transaction) {
    if (!transaction || typeof transaction !== 'object') {
      return transaction;
    }
    const category = transaction.category && typeof transaction.category === 'object' ? transaction.category : null;
    const displayDate = safeCalendarDate(transaction.displayDate, { timeZone: this.timeZone });
    return {
      ...transaction,
      displayDate: displayDate ?? transaction.displayDate,
      displayDateRaw: transaction.displayDate,
      categoryId: category?._id ?? (typeof transaction.category === 'string' ? transaction.category : null),
      categoryName: category?.name ?? null,
      categoryType: category?.type ?? null,
      categoryTypeName: category ? summarizeCategory(category).typeName : null
    };
  }

  #authHeaders() {
    return {
      Authorization: `AuthJWT ${this.token}`,
      'Cache-Control': 'no-cache, max-age=0, no-store, no-transform, must-revalidate'
    };
  }

  #withTimeout() {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.requestTimeout);
    return { signal: controller.signal, clear: () => clearTimeout(timer) };
  }

  async #request(path, { method, body, headers }) {
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
        method,
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
      const detail = clip(await response.text());
      if (response.status === 401) {
        throw new MoneyloverApiError('user_unauthenticated', { code: 401, detail });
      }
      throw new MoneyloverApiError(`Money Lover API request failed: HTTP ${response.status}`, {
        code: response.status,
        detail
      });
    }

    return response;
  }

  async #post(path, { body, headers } = {}) {
    const response = await this.#request(path, { method: 'POST', body, headers });
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
    const response = await this.#request(path, { method: 'GET' });
    return readJson(response);
  }
}

export { MoneyloverApiError, CategoryType, matchGlobalCategory, isAuthError };

export default MoneyloverClient;
