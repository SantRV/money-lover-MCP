import { prepareAmount, amountCents, formatAmount, parseAmount, wireAmount } from './amounts.js';
import {
  CATEGORY_NOT_USABLE,
  CategoryType,
  categoryIdForAdd,
  coerceCategoryType,
  listAllCategoriesForWallet,
  selectCategory,
  summarizeCategory,
  systemCategoryLabel,
  unusableCategoryReason,
  unwrapList
} from './categories.js';
import { addCalendarDays, calendarDate, safeCalendarDate } from './dates.js';
import { clip, redact } from './redact.js';
import { apiErrorCode, deviceErrorMessage, isAuthError, isDeviceError, NOT_AUTHORIZED_CODE } from './authError.js';
import { readBalance, roundMoney, signedTransactionDelta, summarizeTransactionTotals } from './balance.js';
import {
  cloudflareWriteMessage,
  looksLikeCloudflare,
  looksLikeReadOnly,
  readOnlyWriteMessage,
  userCategoryV2Message,
  writeTimeoutMessage
} from './writeErrors.js';

const WRITE_TIMEOUT_MS = 20000;
const sessionCategories = new Map();
let sessionGlobalCategories;
let sessionWallets;

export const clearCategorySession = () => {
  sessionCategories.clear();
  sessionGlobalCategories = undefined;
  sessionWallets = undefined;
};

const WRITE_PATHS = new Set(['/transaction/add', '/transaction/edit', '/transaction/delete', '/transaction/add-multi']);

export const timeoutForRequest = (path, { requestTimeout = 30000, writeTimeout = WRITE_TIMEOUT_MS } = {}) => {
  const base = String(path ?? '').split('?')[0];
  if (WRITE_PATHS.has(base)) {
    return Math.min(requestTimeout, writeTimeout);
  }
  return requestTimeout;
};

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
  const code = apiErrorCode(payload);
  if (code) {
    const device = deviceErrorMessage(code);
    const rawMessage =
      payload?.msg ||
      payload?.message ||
      (code === NOT_AUTHORIZED_CODE ? 'Not authorized error' : 'Money Lover API error');
    const readOnly = looksLikeReadOnly(rawMessage);
    throw new MoneyloverApiError(device || (readOnly ? readOnlyWriteMessage() : String(rawMessage)), {
      code: device ? code : readOnly ? 'READ_ONLY' : code,
      detail: redact(payload)
    });
  }
  return payload?.data ?? null;
};

const nestedId = (value) => {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (value && typeof value === 'object' && typeof value._id === 'string' && value._id.trim()) {
    return value._id.trim();
  }
  return '';
};

const copyText = (value) => (value == null ? '' : String(value));

const notUsableError = (label, reason) => {
  const why = {
    not_in_list_all:
      'It is on the stored /category/list catalogue. The website add picker is /category/list-all for this wallet, and this category is not in it.',
    ambiguous:
      'More than one add-picker category has this name. Pass one of the candidate add ids from list_categories.',
    uncategorized: 'The website drops uncategorized categories from the add picker.',
    deleted: 'It is marked deleted on the stored category list.',
    hidden: 'It is hidden or archived on the stored category list.',
    different_wallet:
      'It belongs to a different wallet. The same add id can appear on several wallets; pass the wallet you are writing to.'
  };
  return new MoneyloverApiError(
    `${label} cannot be used for a new transaction. ${why[reason] ?? 'It is not in the add picker.'} Nothing was posted.`,
    { code: CATEGORY_NOT_USABLE }
  );
};

const rethrowCategoryError = (error) => {
  if (error?.code === CATEGORY_NOT_USABLE) {
    throw new MoneyloverApiError(error.message, { code: CATEGORY_NOT_USABLE });
  }
  throw error;
};

const photoReference = (image) => {
  if (typeof image !== 'string') {
    throw new Error(
      'image must be an existing photo reference. This server does not upload photo files. The website accepts a photo under 2MB.'
    );
  }
  return image;
};

const finiteOr = (value, fallback) => {
  if (value == null || value === '') {
    return fallback;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error('location coordinates must be numbers');
  }
  return number;
};

/**
 * Body for POST /transaction/add, matching the archived web bundle
 * (saveTransaction → transInfo → Ki.postData).
 * Headers on that call are Accept, dataformat, Content-Type application/json,
 * and authorization AuthJWT. It does not send client, device, or version headers
 * (those are only on the Revo API and image upload). `category` is the `_id`
 * from POST /category/list-all for this wallet, not the id /category/list stores.
 * Amount is a JSON number.
 * displayDate is YYYY-MM-DD. The empty location, event, image, and exclude_report
 * fields are always present; remind is not sent on add.
 */
export const transactionAddBody = ({
  account,
  category,
  amount,
  note = '',
  displayDate,
  with: parties = [],
  event = '',
  excludeReport = false,
  longtitude,
  latitude,
  addressName = '',
  addressDetails = '',
  addressIcon = '',
  image = '',
  remind
}) => {
  const body = {
    with: Array.isArray(parties) ? parties.map((value) => String(value)) : [],
    account,
    category,
    amount: wireAmount(amount),
    note: note == null ? '' : String(note),
    displayDate,
    event: event == null ? '' : String(event),
    exclude_report: Boolean(excludeReport),
    longtitude: finiteOr(longtitude, 0),
    latitude: finiteOr(latitude, 0),
    addressName: addressName == null ? '' : String(addressName),
    addressDetails: addressDetails == null ? '' : String(addressDetails),
    addressIcon: addressIcon == null ? '' : String(addressIcon),
    image: image == null ? '' : String(image)
  };
  if (remind != null) {
    body.remind = remind;
  }
  return body;
};

export class MoneyloverClient {
  constructor(token, { requestTimeout = 30000, timeZone, refreshToken, onSession } = {}) {
    this.token = ensureString(token, 'token');
    this.requestTimeout = requestTimeout;
    this.timeZone = timeZone;
    this.refreshToken = typeof refreshToken === 'string' && refreshToken ? refreshToken : null;
    this.onSession = typeof onSession === 'function' ? onSession : null;
    this.#walletCategoryCache = new Map();
    this.#globalCategoriesCache = null;
    this.#walletsCache = undefined;
    this.#userInfo = null;
  }

  #walletCategoryCache;
  #globalCategoriesCache;
  #walletsCache;
  #userInfo;

  #clearWalletList() {
    this.#walletsCache = undefined;
    sessionWallets = undefined;
  }

  static lastSession = null;

  static async login(email, password) {
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
    const refreshRaw = tokenPayload?.refresh_token ?? tokenPayload?.refreshToken ?? null;
    const session = {
      accessToken,
      refreshToken: typeof refreshRaw === 'string' && refreshRaw ? refreshRaw : null
    };
    this.lastSession = session;
    return session;
  }

  static async getToken(email, password) {
    return (await this.login(email, password)).accessToken;
  }

  async refreshAccessToken() {
    if (!this.refreshToken) {
      throw new MoneyloverApiError('Not authorized error', { code: NOT_AUTHORIZED_CODE });
    }
    const response = await fetch(`${BASE_URL}/user/refresh-token`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        dataformat: 'json'
      },
      body: JSON.stringify({ refreshToken: this.refreshToken })
    });
    const payload = await readJson(response);
    const code = apiErrorCode(payload);
    const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
    const accessToken = data?.access_token || data?.accessToken;
    const nextRefresh = data?.refresh_token || data?.refreshToken || this.refreshToken;
    if (!response.ok || code || !accessToken) {
      const device = deviceErrorMessage(code);
      throw new MoneyloverApiError(device || payload?.msg || 'Not authorized error', {
        code: code ?? NOT_AUTHORIZED_CODE,
        detail: redact(payload)
      });
    }
    this.token = accessToken;
    this.refreshToken = typeof nextRefresh === 'string' ? nextRefresh : this.refreshToken;
    if (this.onSession) {
      await this.onSession({ token: this.token, refreshToken: this.refreshToken });
    }
    return this.token;
  }

  async whoami() {
    const info = await this.getUserInfo();
    this.#userInfo = info;
    const wallets = unwrapList(await this.getWallets());
    const tags = Array.isArray(info?.tags) ? info.tags : [];
    return {
      ok: true,
      email: info?.email ?? null,
      name: info?.name ?? info?.fullname ?? null,
      deviceId: info?.deviceId ?? null,
      purchased: Boolean(info?.purchased),
      tags,
      userCategoryV2: tags.includes('user_category_v2'),
      walletCount: wallets.length,
      activeWalletCount: wallets.filter((wallet) => !wallet?.archived).length
    };
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
    if (this.#walletsCache !== undefined) {
      return this.#walletsCache;
    }
    if (sessionWallets !== undefined) {
      this.#walletsCache = sessionWallets;
      return sessionWallets;
    }
    const list = unwrapList(await this.#post('/wallet/list'));
    this.#walletsCache = list;
    sessionWallets = list;
    return list;
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
    const created = await this.#postJson('/wallet/add', payload);
    this.#clearWalletList();
    return created;
  }

  async editWallet(id, params = {}) {
    const walletId = ensureString(id, 'walletId');
    let existing = null;
    try {
      existing = unwrapList(await this.getWallets()).find((wallet) => wallet?._id === walletId) ?? null;
    } catch (error) {
      if (params.currencyId == null || params.name == null) {
        throw new Error(
          `Could not read wallet ${walletId}, so account type, exclude-from-total, and archived cannot be preserved. ${error.message}`,
          { cause: error }
        );
      }
    }

    const currencySource = params.currencyId ?? existing?.currency_id;
    const currencyId =
      typeof currencySource === 'number' ? currencySource : Number.parseInt(String(currencySource ?? ''), 10);
    if (!Number.isInteger(currencyId)) {
      throw new Error('currencyId is required when the current wallet cannot be read');
    }
    const name = params.name != null ? ensureString(params.name, 'name') : existing?.name;
    if (!name) {
      throw new Error('name is required when the current wallet cannot be read');
    }

    const accountTypeSource = params.accountType ?? existing?.account_type ?? 0;
    const payload = {
      _id: walletId,
      name,
      icon: params.icon != null ? ensureString(params.icon, 'icon') : (existing?.icon ?? 'icon_7'),
      currency_id: currencyId,
      account_type: Number(accountTypeSource),
      exclude_total:
        params.excludeFromTotal != null ? Boolean(params.excludeFromTotal) : Boolean(existing?.exclude_total),
      archived: params.archived != null ? Boolean(params.archived) : Boolean(existing?.archived)
    };
    if (params.dryRun === true) {
      return { dryRun: true, endpoint: '/wallet/edit', payload };
    }
    const updated = await this.#postJson('/wallet/edit', payload);
    this.#clearWalletList();
    return updated;
  }

  async deleteWallet(id, { dryRun = false } = {}) {
    const payload = { _id: ensureString(id, 'walletId') };
    if (dryRun) {
      return { dryRun: true, endpoint: '/wallet/delete', payload };
    }
    const deleted = await this.#postJson('/wallet/delete', payload);
    this.#clearWalletList();
    return deleted;
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
    return this.#globalCategories();
  }

  async listWalletCategories(walletId, { includeUnusable = false } = {}) {
    const id = ensureString(walletId, 'walletId');
    const addRows = listAllCategoriesForWallet(await this.#globalCategories(), id);
    const categories = addRows.map((category) => {
      const summary = summarizeCategory(category);
      summary.addId = category._id;
      summary.usable = true;
      return summary;
    });
    if (!includeUnusable) {
      return { categories, unusable: [] };
    }
    const stored = await this.#walletCategories(id);
    const unusable = [];
    for (const category of stored) {
      const mapped = categoryIdForAdd({ category, id: category._id }, addRows);
      if (mapped?.id) {
        const hit = categories.find((row) => row.addId === mapped.id);
        if (hit) {
          hit.storedIds = hit.storedIds ?? [];
          if (!hit.storedIds.includes(category._id)) {
            hit.storedIds.push(category._id);
          }
          if (!hit.storedId) {
            hit.storedId = category._id;
          }
        }
        continue;
      }
      const summary = {
        ...summarizeCategory(category),
        usable: false,
        code: CATEGORY_NOT_USABLE
      };
      if (mapped?.ambiguous) {
        summary.reason = 'ambiguous';
        summary.candidates = mapped.candidates.map((row) => ({
          id: row._id,
          addId: row._id,
          name: row.name ?? '',
          type: row.type == null ? null : Number(row.type)
        }));
      } else {
        summary.reason = unusableCategoryReason(category, id);
      }
      unusable.push(summary);
    }
    return { categories, unusable };
  }

  async addCategory(params) {
    const payload = {
      walletId: ensureString(params.walletId, 'walletId'),
      name: ensureString(params.name, 'name'),
      icon: ensureString(params.icon, 'icon'),
      type: coerceCategoryType(params.type)
    };
    if (params.parentId) {
      payload.parentId = ensureString(params.parentId, 'parentId');
    }
    if (params.dryRun === true) {
      return { dryRun: true, endpoint: '/category/add', payload };
    }
    try {
      const created = await this.#postJson('/category/add', payload);
      this.#walletCategoryCache.delete(payload.walletId);
      sessionCategories.delete(payload.walletId);
      this.#globalCategoriesCache = null;
      sessionGlobalCategories = undefined;
      return created;
    } catch (error) {
      throw await this.#explainWriteError(error, 'category');
    }
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
    try {
      return await this.#postJson('/category/edit', payload);
    } catch (error) {
      throw await this.#explainWriteError(error, 'category');
    }
  }

  async deleteCategory(id, { dryRun = false } = {}) {
    const payload = { _id: ensureString(id, 'categoryId') };
    if (dryRun) {
      return { dryRun: true, endpoint: '/category/delete', payload };
    }
    try {
      return await this.#postJson('/category/delete', payload);
    } catch (error) {
      throw await this.#explainWriteError(error, 'category');
    }
  }

  async mergeCategories(fromCategoryId, toCategoryId, { dryRun = false } = {}) {
    const payload = {
      id1: ensureString(fromCategoryId, 'fromCategoryId'),
      id2: ensureString(toCategoryId, 'toCategoryId')
    };
    if (dryRun) {
      return { dryRun: true, endpoint: '/category/merge', payload };
    }
    try {
      const merged = await this.#postJson('/category/merge', payload);
      this.#walletCategoryCache.clear();
      sessionCategories.clear();
      this.#globalCategoriesCache = null;
      sessionGlobalCategories = undefined;
      return merged;
    } catch (error) {
      throw await this.#explainWriteError(error, 'category');
    }
  }

  async getTransactions(walletId, startDate, endDate) {
    return this.#postJson('/transaction/list', {
      walletId: ensureString(walletId, 'walletId'),
      startDate: ensureDateString(startDate, { timeZone: this.timeZone }),
      endDate: ensureDateString(endDate, { timeZone: this.timeZone })
    });
  }

  async #walletCategories(walletId) {
    if (this.#walletCategoryCache.has(walletId)) {
      return this.#walletCategoryCache.get(walletId);
    }
    if (sessionCategories.has(walletId)) {
      const cached = sessionCategories.get(walletId);
      this.#walletCategoryCache.set(walletId, cached);
      return cached;
    }
    const list = unwrapList(await this.getCategories(walletId));
    this.#walletCategoryCache.set(walletId, list);
    sessionCategories.set(walletId, list);
    return list;
  }

  async #globalCategories() {
    if (this.#globalCategoriesCache) {
      return this.#globalCategoriesCache;
    }
    if (sessionGlobalCategories) {
      this.#globalCategoriesCache = sessionGlobalCategories;
      return sessionGlobalCategories;
    }
    const list = unwrapList(await this.#post('/category/list-all'));
    this.#globalCategoriesCache = list;
    sessionGlobalCategories = list;
    return list;
  }

  async #resolveCategory(walletId, { categoryId, categoryName, direction }) {
    const addRows = listAllCategoriesForWallet(await this.#globalCategories(), walletId);
    const id = typeof categoryId === 'string' ? categoryId.trim() : '';
    const name = typeof categoryName === 'string' ? categoryName.trim() : '';
    if ((id && addRows.some((category) => category._id === id)) || (!id && name)) {
      try {
        const selected = selectCategory([], addRows, walletId, { categoryId, categoryName, direction });
        if (selected.source === 'list-all') {
          return { category: selected.category, id: selected.id, source: 'list-all' };
        }
      } catch (error) {
        if (id || error?.code === CATEGORY_NOT_USABLE || !/No category named/.test(error?.message ?? '')) {
          rethrowCategoryError(error);
        }
      }
    }
    const walletList = await this.#walletCategories(walletId);
    let selected;
    try {
      selected = selectCategory(walletList, addRows, walletId, { categoryId, categoryName, direction });
    } catch (error) {
      rethrowCategoryError(error);
    }
    if (selected.source === 'list-all') {
      return { category: selected.category, id: selected.id, source: 'list-all' };
    }
    const mapped = categoryIdForAdd(selected, addRows);
    const label = selected.category?.name
      ? `${selected.category.name} [${selected.id}]`
      : selected.id || categoryName || 'this category';
    if (!mapped?.id) {
      if (mapped?.ambiguous) {
        const candidates = mapped.candidates.map((category) => `${category.name} [${category._id}]`).join(', ');
        throw new MoneyloverApiError(
          `More than one add-picker category matches ${label} in this wallet. Pass one of those ids. Candidates: ${candidates}`,
          { code: CATEGORY_NOT_USABLE }
        );
      }
      const reason = selected.category ? unusableCategoryReason(selected.category, walletId) : 'not_in_list_all';
      throw notUsableError(label, reason);
    }
    return {
      category: selected.category ?? mapped.category,
      id: mapped.id,
      source: 'list-all'
    };
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
    if (amount.direction !== 'unknown' && direction && amount.direction !== direction) {
      warnings.push(
        `Amount sign implies ${direction}, but the category is ${amount.direction}. The category type is what Money Lover will use.`
      );
    }

    if (params.image != null) {
      photoReference(params.image);
    }
    const remind = params.remind != null ? params.remind : params.reminder;
    const payload = transactionAddBody({
      with: withParties,
      account: walletId,
      category: resolved.id,
      amount: amount.amount,
      note,
      displayDate: date,
      event: params.eventId ?? (typeof params.event === 'string' ? params.event : ''),
      excludeReport: params.excludeReport,
      longtitude: params.longtitude ?? params.longitude,
      latitude: params.latitude,
      addressName: params.addressName,
      addressDetails: params.addressDetails,
      addressIcon: params.addressIcon,
      image: params.image,
      remind
    });

    return {
      payload,
      date,
      cents: amountCents(amount.amount),
      amountText: amount.amount,
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
    const transactionId = ensureString(id, 'transactionId');
    const timeZone = params.timeZone ?? this.timeZone;
    const lookupDates = [];
    for (const candidate of [params.currentDate, params.date]) {
      if (candidate) {
        lookupDates.push(ensureDateString(candidate, { timeZone }));
      }
    }
    const existing = await this.findTransactionById(transactionId, {
      walletId: params.walletId,
      dates: lookupDates
    });
    if (!existing) {
      throw new Error(
        `Could not load transaction ${transactionId}, so the edit was not sent. Pass walletId and currentDate (the transaction's current day) so exclude_report, event, image, reminder, and location are kept.`
      );
    }

    const walletId = ensureString(params.walletId ?? nestedId(existing.account), 'walletId');
    const warnings = [];
    let categoryId = nestedId(existing.category);
    if (params.categoryId || params.category) {
      const resolved = await this.#resolveCategory(walletId, {
        categoryId: params.categoryId,
        categoryName: params.category
      });
      categoryId = resolved.id;
    }
    if (!categoryId) {
      throw new Error('categoryId is required when the existing transaction has no category');
    }

    let amount = wireAmount(formatAmount(Math.abs(parseAmount(existing.amount))));
    if (params.amount != null) {
      const prepared = prepareAmount(params.amount, existing.category?.type, {
        amountMode: params.amountMode === 'signed' ? 'signed' : 'magnitude'
      });
      amount = wireAmount(prepared.amount);
      warnings.push(...prepared.warnings);
    }

    const displayDate = params.date
      ? ensureDateString(params.date, { timeZone })
      : ensureDateString(existing.displayDate, { timeZone });
    const payload = {
      _id: transactionId,
      account: walletId,
      category: categoryId,
      amount,
      note: params.note != null ? String(params.note) : copyText(existing.note),
      displayDate,
      with: Array.isArray(params.with)
        ? params.with.map((value) => String(value))
        : Array.isArray(existing.with)
          ? existing.with.map((value) => String(value))
          : [],
      event: params.eventId != null ? String(params.eventId) : nestedId(existing.event),
      exclude_report: params.excludeReport != null ? Boolean(params.excludeReport) : Boolean(existing.exclude_report),
      longtitude:
        params.longtitude != null
          ? String(params.longtitude)
          : params.longitude != null
            ? String(params.longitude)
            : copyText(existing.longtitude),
      latitude: params.latitude != null ? String(params.latitude) : copyText(existing.latitude),
      addressName: params.addressName != null ? String(params.addressName) : copyText(existing.addressName),
      addressDetails: params.addressDetails != null ? String(params.addressDetails) : copyText(existing.addressDetails),
      addressIcon: params.addressIcon != null ? String(params.addressIcon) : copyText(existing.addressIcon),
      remind:
        params.remind != null ? params.remind : params.reminder != null ? params.reminder : (existing.remind ?? ''),
      image:
        params.image != null ? photoReference(params.image) : copyText(existing.images?.[0] ?? existing.image ?? '')
    };
    const parent = params.parentId != null ? String(params.parentId) : nestedId(existing.parent);
    if (parent) {
      payload.parent = parent;
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

  async deleteTransaction(id, { dryRun = false, deleteRelated = false } = {}) {
    // The add response assigns _id (the web client copies data._id, often prefixed "web").
    // The client does not generate that id. Delete always sends delRelated, as the dialog does.
    const payload = {
      _id: ensureString(id, 'transactionId'),
      delRelated: deleteRelated === true
    };
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

  async searchTransactionTotals(filters = {}) {
    const raw = await this.#postJson('/transaction/search/balance', filters);
    return summarizeTransactionTotals(raw);
  }

  async searchAllTransactions(filters = {}, { pageSize = 100, maxPages = 20 } = {}) {
    const transactions = [];
    let offset = Number(filters.offset ?? 0) || 0;
    let truncated = false;
    for (let page = 0; page < maxPages; page += 1) {
      const raw = await this.searchTransactions({ ...filters, limit: pageSize, offset });
      const batch = unwrapList(raw);
      transactions.push(...batch);
      if (batch.length < pageSize) {
        return { transactions, truncated: false };
      }
      offset += batch.length;
      truncated = page === maxPages - 1;
    }
    return { transactions, truncated };
  }

  async findTransactionById(id, { walletId, dates = [] } = {}) {
    const transactionId = ensureString(id, 'transactionId');
    const uniqueDates = [...new Set(dates.filter(Boolean))];
    const scan = async (filters, maxPages) => {
      const collected = await this.searchAllTransactions(filters, { pageSize: 100, maxPages });
      return collected.transactions.find((row) => row?._id === transactionId) ?? null;
    };

    for (const day of uniqueDates) {
      const hit = await scan(
        {
          ...(walletId ? { accounts: [walletId] } : {}),
          startDate: day,
          endDate: day
        },
        5
      );
      if (hit) {
        return hit;
      }
    }

    if (walletId && uniqueDates.length === 0) {
      const hit = await scan({ accounts: [walletId] }, 3);
      if (hit) {
        return hit;
      }
    }

    try {
      const related = unwrapList(await this.getRelatedTransactions([transactionId]));
      return related.find((row) => row?._id === transactionId) ?? null;
    } catch {
      return null;
    }
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

  async #categoryIdByMetadata(walletId, metadata, explicitId) {
    if (explicitId) {
      const resolved = await this.#resolveCategory(walletId, { categoryId: explicitId });
      return resolved.id;
    }
    const matches = listAllCategoriesForWallet(await this.#globalCategories(), walletId).filter(
      (category) => String(category.metadata ?? '') === metadata
    );
    const label = systemCategoryLabel(metadata) ?? metadata;
    if (matches.length === 0) {
      throw new MoneyloverApiError(
        `Wallet ${walletId} has no usable "${label}" category (${metadata}) in the add picker. list_categories returns that picker. A stored /category/list row with this metadata is not sent. Do not assume Other expense exists.`,
        { code: CATEGORY_NOT_USABLE }
      );
    }
    if (matches.length > 1) {
      const candidates = matches.map((category) => `${category.name} [${category._id}]`).join(', ');
      throw new MoneyloverApiError(
        `Wallet ${walletId} has more than one usable "${label}" category (${metadata}). Pass categoryId from list_categories for this wallet. Candidates: ${candidates}`,
        { code: CATEGORY_NOT_USABLE }
      );
    }
    return matches[0]._id;
  }

  async transferMoney(params) {
    const fromWalletId = ensureString(params.fromWalletId, 'fromWalletId');
    const toWalletId = ensureString(params.toWalletId, 'toWalletId');
    if (fromWalletId === toWalletId) {
      throw new Error('fromWalletId and toWalletId must be different wallets');
    }
    const date = ensureDateString(params.date, { timeZone: params.timeZone ?? this.timeZone });
    const amount = prepareAmount(params.amount, CategoryType.EXPENSE, { amountMode: 'magnitude' });
    const toAmount =
      params.toAmount == null
        ? amount
        : prepareAmount(params.toAmount, CategoryType.INCOME, { amountMode: 'magnitude' });
    const fromCategory = await this.#categoryIdByMetadata(fromWalletId, 'IS_OUTGOING_TRANSFER', params.fromCategoryId);
    const toCategory = await this.#categoryIdByMetadata(toWalletId, 'IS_INCOMING_TRANSFER', params.toCategoryId);

    let fromName = params.fromWalletName ?? '';
    let toName = params.toWalletName ?? '';
    const outgoingNoteGiven = params.fromNote != null || params.note != null;
    const incomingNoteGiven = params.toNote != null;
    if ((!fromName || !toName) && !(outgoingNoteGiven && incomingNoteGiven)) {
      try {
        const wallets = unwrapList(await this.getWallets());
        fromName = fromName || wallets.find((wallet) => wallet?._id === fromWalletId)?.name || '';
        toName = toName || wallets.find((wallet) => wallet?._id === toWalletId)?.name || '';
      } catch {
        fromName = fromName || '';
        toName = toName || '';
      }
    }

    const excludeReport = params.excludeReport === true;
    const leg = (account, category, magnitude, note, extra = {}) => ({
      account,
      category,
      amount: Number(magnitude),
      note,
      displayDate: date,
      exclude_report: excludeReport,
      with: [],
      related: true,
      ...extra
    });
    const transactions = [
      leg(
        fromWalletId,
        fromCategory,
        amount.amount,
        params.fromNote ?? params.note ?? (toName ? `Transfer to ${toName}` : '')
      ),
      leg(toWalletId, toCategory, toAmount.amount, params.toNote ?? (fromName ? `Transfer from ${fromName}` : ''))
    ];

    if (params.feeAmount != null && Number(params.feeAmount) !== 0) {
      const feeWalletId = params.feeWalletId ? ensureString(params.feeWalletId, 'feeWalletId') : fromWalletId;
      const fee = prepareAmount(params.feeAmount, CategoryType.EXPENSE, { amountMode: 'magnitude' });
      const feeCategory = await this.#categoryIdByMetadata(feeWalletId, 'IS_OTHER_EXPENSE', params.feeCategoryId);
      transactions.push(leg(feeWalletId, feeCategory, fee.amount, params.feeNote ?? 'Transfer fee', { isFee: true }));
    }

    const payload = { transactions, action: 'transfermoney' };
    if (params.dryRun === true) {
      return { dryRun: true, endpoint: '/transaction/add-multi', payload };
    }
    return this.#postJson('/transaction/add-multi', payload);
  }

  async adjustBalance(params) {
    const walletId = ensureString(params.walletId, 'walletId');
    const target = typeof params.balance === 'number' ? params.balance : parseAmount(String(params.balance));
    const currentBalance = readBalance(await this.getWalletBalance(walletId));
    const delta = roundMoney(target - currentBalance);
    if (Math.abs(delta) < 0.005) {
      return { adjusted: false, walletId, currentBalance, targetBalance: target, delta: 0 };
    }
    const metadata = delta > 0 ? 'IS_OTHER_INCOME' : 'IS_OTHER_EXPENSE';
    const categoryId = await this.#categoryIdByMetadata(walletId, metadata, params.categoryId);
    const date = params.date
      ? ensureDateString(params.date, { timeZone: this.timeZone })
      : calendarDate(new Date(), { timeZone: this.timeZone });
    const created = await this.addTransaction({
      walletId,
      categoryId,
      amount: formatAmount(Math.abs(delta)),
      date,
      note: params.note ?? 'Balance adjustment',
      excludeReport: params.excludeReport,
      dryRun: params.dryRun === true
    });
    return {
      adjusted: params.dryRun !== true,
      walletId,
      currentBalance,
      targetBalance: target,
      delta,
      direction: delta > 0 ? 'income' : 'expense',
      categoryMetadata: metadata,
      transaction: created
    };
  }

  async balanceAsOf({ walletId, date }) {
    const id = ensureString(walletId, 'walletId');
    const asOf = ensureDateString(date, { timeZone: this.timeZone });
    const currentBalance = readBalance(await this.getWalletBalance(id));
    const today = calendarDate(new Date(), { timeZone: this.timeZone });
    if (asOf >= today) {
      return {
        walletId: id,
        date: asOf,
        balance: currentBalance,
        currentBalance,
        basis: 'current',
        incomplete: false,
        skipped: []
      };
    }
    const collected = await this.searchAllTransactions({
      accounts: [id],
      startDate: addCalendarDays(asOf, 1),
      endDate: today
    });
    let netAfter = 0;
    const skipped = [];
    for (const row of collected.transactions) {
      const day = safeCalendarDate(row.displayDate, { timeZone: this.timeZone });
      if (day && day <= asOf) {
        continue;
      }
      const delta = signedTransactionDelta(row);
      if (delta == null) {
        skipped.push(row._id ?? null);
        continue;
      }
      netAfter += delta;
    }
    return {
      walletId: id,
      date: asOf,
      balance: roundMoney(currentBalance - netAfter),
      currentBalance,
      netAfterDate: roundMoney(netAfter),
      transactionCount: collected.transactions.length,
      basis: 'current_balance_minus_later_transactions',
      incomplete: collected.truncated || skipped.length > 0,
      skipped
    };
  }

  async getBudgets({ walletId, finished } = {}) {
    if (walletId && walletId !== 'all') {
      const wid = encodeURIComponent(ensureString(walletId, 'walletId'));
      return this.#post(`/budget/list/${wid}`, {
        body: '{}',
        headers: { 'Content-Type': 'application/json' }
      });
    }
    const data = {};
    if (finished != null) {
      data.isFinished = Boolean(finished);
    }
    return this.#postJson('/budget/list/all', data);
  }

  async addBudget(params) {
    const payload = {
      walletId: ensureString(params.walletId, 'walletId'),
      categoryId: ensureString(params.categoryId, 'categoryId'),
      amount: Number(prepareAmount(params.amount, null).amount),
      startDate: ensureDateString(params.startDate, { timeZone: this.timeZone }),
      endDate: ensureDateString(params.endDate, { timeZone: this.timeZone }),
      isRepeat: Boolean(params.isRepeat)
    };
    if (params.dryRun === true) {
      return { dryRun: true, endpoint: '/budget/add', payload };
    }
    try {
      return await this.#postJson('/budget/add', payload);
    } catch (error) {
      throw await this.#explainWriteError(error, 'budget');
    }
  }

  async editBudget(params) {
    const payload = {
      budgetId: ensureString(params.budgetId, 'budgetId'),
      walletId: ensureString(params.walletId, 'walletId'),
      categoryId: params.categoryId != null ? String(params.categoryId) : 0,
      amount: Number(prepareAmount(params.amount, null).amount),
      startDate: ensureDateString(params.startDate, { timeZone: this.timeZone }),
      endDate: ensureDateString(params.endDate, { timeZone: this.timeZone }),
      isRepeat: Boolean(params.isRepeat)
    };
    if (params.allId) {
      payload.allId = params.allId;
    }
    if (params.allAmount != null) {
      payload.allAmount = params.allAmount;
    }
    if (params.dryRun === true) {
      return { dryRun: true, endpoint: '/budget/edit', payload };
    }
    try {
      return await this.#postJson('/budget/edit', payload);
    } catch (error) {
      throw await this.#explainWriteError(error, 'budget');
    }
  }

  async deleteBudget(id, { typeDelete = 'only', dryRun = false } = {}) {
    const mode = typeDelete === 'all' ? 'all' : 'only';
    const payload = { _id: ensureString(id, 'budgetId'), typeDelete: mode };
    if (dryRun) {
      return { dryRun: true, endpoint: '/budget/delete', payload };
    }
    try {
      return await this.#postJson('/budget/delete', payload);
    } catch (error) {
      throw await this.#explainWriteError(error, 'budget');
    }
  }

  async getReport({ walletId = 'all', startDate, endDate, walletIds } = {}) {
    const id = encodeURIComponent(ensureString(String(walletId), 'walletId'));
    const data = {
      startDate: ensureDateString(startDate, { timeZone: this.timeZone }),
      endDate: ensureDateString(endDate, { timeZone: this.timeZone })
    };
    if (Array.isArray(walletIds) && walletIds.length > 0) {
      data.walletIds = walletIds.map((value) => String(value));
    }
    return this.#postJson(`/report/${id}`, data);
  }

  async #explainWriteError(error, kind) {
    if (!(error instanceof Error) || isAuthError(error) || isDeviceError(error)) {
      return error;
    }
    if (error.code === 'CLOUDFLARE' || error.code === 'READ_ONLY' || error.code === 'USER_CATEGORY_V2') {
      return error;
    }
    if (kind === 'category' || kind === 'budget') {
      try {
        const info = this.#userInfo ?? (await this.getUserInfo());
        this.#userInfo = info;
        const tags = Array.isArray(info?.tags) ? info.tags : [];
        if (tags.includes('user_category_v2')) {
          return new MoneyloverApiError(userCategoryV2Message(), {
            code: 'USER_CATEGORY_V2',
            detail: error.message
          });
        }
      } catch {
        return error;
      }
    }
    if (looksLikeReadOnly(error.message)) {
      return new MoneyloverApiError(readOnlyWriteMessage(), { code: 'READ_ONLY', detail: error.message });
    }
    return error;
  }

  presentTransaction(transaction) {
    if (!transaction || typeof transaction !== 'object') {
      return transaction;
    }
    const rest = { ...transaction };
    delete rest.tokenDevice;
    delete rest.token_device;
    const category = rest.category && typeof rest.category === 'object' ? rest.category : null;
    const displayDate = safeCalendarDate(rest.displayDate, { timeZone: this.timeZone });
    return {
      ...rest,
      displayDate: displayDate ?? rest.displayDate,
      displayDateRaw: rest.displayDate,
      categoryId: category?._id ?? (typeof rest.category === 'string' ? rest.category : null),
      categoryName: category?.name ?? null,
      categoryType: category?.type ?? null,
      categoryTypeName: category ? summarizeCategory(category).typeName : null
    };
  }

  #authHeaders() {
    return {
      Accept: 'application/json',
      dataformat: 'json',
      Authorization: `AuthJWT ${this.token}`,
      'Cache-Control': 'no-cache, max-age=0, no-store, no-transform, must-revalidate'
    };
  }

  #withTimeout(timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    return { signal: controller.signal, clear: () => clearTimeout(timer) };
  }

  async #request(path, { method, body, headers, authRetried = false } = {}) {
    const requestHeaders = new Headers(this.#authHeaders());
    if (headers) {
      for (const [key, value] of Object.entries(headers)) {
        requestHeaders.set(key, value);
      }
    }

    const timeoutMs = timeoutForRequest(path, { requestTimeout: this.requestTimeout });
    const write = WRITE_PATHS.has(String(path).split('?')[0]);
    const { signal, clear } = this.#withTimeout(timeoutMs);
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
          write
            ? writeTimeoutMessage(path, timeoutMs)
            : `Request to ${path} timed out — the Money Lover server did not respond within ${timeoutMs}ms`,
          { code: 'TIMEOUT' }
        );
      }
      throw error;
    }
    clear();

    if (!response.ok) {
      const detail = clip(await response.text());
      if (looksLikeCloudflare(response.status, detail)) {
        throw new MoneyloverApiError(cloudflareWriteMessage(response.status), { code: 'CLOUDFLARE', detail });
      }
      if (response.status === 401 && !authRetried && this.refreshToken) {
        await this.refreshAccessToken();
        return this.#request(path, { method, body, headers, authRetried: true });
      }
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

  async #post(path, { body, headers, authRetried = false } = {}) {
    const response = await this.#request(path, { method: 'POST', body, headers, authRetried });
    const payload = await readJson(response);
    const code = apiErrorCode(payload);
    if (code === NOT_AUTHORIZED_CODE && !authRetried && this.refreshToken) {
      await this.refreshAccessToken();
      return this.#post(path, { body, headers, authRetried: true });
    }
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

export { MoneyloverApiError, CategoryType, isAuthError };

export default MoneyloverClient;
