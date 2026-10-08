import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { MoneyloverClient } from './moneyloverClient.js';
import { isAuthError, isDeviceError } from './authError.js';
import * as tokenCache from './tokenCache.js';

const { readToken, removeToken, writeToken } = tokenCache;
const readRefreshToken = (() => {
  try {
    return typeof tokenCache.readRefreshToken === 'function' ? tokenCache.readRefreshToken : async () => null;
  } catch {
    return async () => null;
  }
})();

const accessTokenStillValid = (token) => {
  try {
    if (typeof tokenCache.accessTokenStillValid === 'function') {
      return tokenCache.accessTokenStillValid(token);
    }
  } catch {
    return true;
  }
  return true;
};
import { clip, redact } from './redact.js';
import { pageItems } from './paging.js';
import { summarizeCategory, unwrapList } from './categories.js';
import { rowsFromBankCsv } from './csv.js';
import { createTransactions, errorFromTransactionRow } from './transactions.js';
import { assertConfirm } from './safety.js';
import { buildSearchFilter, pageSearchResult, SEARCH_PAGE_SIZE } from './searchFilters.js';
import { undoImport } from './importUndo.js';
import { assertBatchId } from './importLog.js';

const require = createRequire(import.meta.url);
const { version: SERVER_VERSION } = require('../package.json');

const DIRECT_TOKEN_ENV_KEYS = ['MONEYLOVER_TOKEN', 'MONEY_LOVER_TOKEN'];
const ENV_FILE_DISABLE_FLAG = 'MONEYLOVER_MCP_DISABLE_ENV_FILE';
const ENV_FILE_PATH_ENV = 'MONEYLOVER_MCP_ENV_FILE';

let envFileLoaded = false;

const warn = (message, error) => {
  const detail = error?.code || error?.message || '';
  console.warn(clip(detail ? `${message}: ${detail}` : message));
};

const normalizeEnvValue = (value) => {
  if (!value) {
    return '';
  }
  let trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    trimmed = trimmed.slice(1, -1);
  }
  return trimmed.replaceAll('\\n', '\n').replaceAll('\\r', '\r').replaceAll('\\t', '\t').replaceAll('\\\\', '\\');
};

const applyEnvFile = (raw) => {
  if (!raw) {
    return;
  }
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const exportless = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const separatorIndex = exportless.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }
    const key = exportless.slice(0, separatorIndex).trim();
    if (!key || typeof process.env[key] !== 'undefined') {
      continue;
    }
    process.env[key] = normalizeEnvValue(exportless.slice(separatorIndex + 1));
  }
};

const loadEnvFileIfNeeded = () => {
  if (envFileLoaded) {
    return;
  }
  envFileLoaded = true;
  if (process.env[ENV_FILE_DISABLE_FLAG] === '1') {
    return;
  }

  const candidates = [];
  const customPath = process.env[ENV_FILE_PATH_ENV]?.trim();
  if (customPath) {
    candidates.push(customPath);
  }
  try {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    candidates.push(path.resolve(moduleDir, '..', '.env'));
  } catch (error) {
    warn('Failed to resolve module directory for env loading', error);
  }
  candidates.push(path.resolve(process.cwd(), '.env'));

  const visited = new Set();
  for (const candidate of candidates) {
    const normalized = candidate ? path.resolve(candidate) : '';
    if (!normalized || visited.has(normalized)) {
      continue;
    }
    visited.add(normalized);
    try {
      applyEnvFile(fs.readFileSync(normalized, 'utf8'));
      break;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        warn(`Failed to load environment file ${normalized}`, error);
      }
    }
  }
};

const firstEnv = (keys) => {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return '';
};

const getEnvConfig = () => {
  loadEnvFileIfNeeded();
  return {
    email: firstEnv(['MONEYLOVER_EMAIL', 'EMAIL']),
    password: firstEnv(['MONEYLOVER_PASSWORD', 'PASSWORD']),
    directToken: firstEnv(DIRECT_TOKEN_ENV_KEYS)
  };
};

let cachedEnvEmail = '';
let cachedEnvToken = '';
let cachedRefreshToken = '';
let envTokenPromise = null;
let cacheLoaded = false;
let cachedEnvUsesDirectToken = false;

const MAX_TOOL_RESPONSE_CHARS = 400_000;

const stripSensitiveFields = (value) => {
  if (Array.isArray(value)) {
    return value.map((item) => stripSensitiveFields(item));
  }
  if (value && typeof value === 'object') {
    const output = {};
    for (const [key, nested] of Object.entries(value)) {
      if (key === 'tokenDevice' || key === 'token_device') {
        continue;
      }
      output[key] = stripSensitiveFields(nested);
    }
    return output;
  }
  return value;
};

const shrinkToolResult = (value) => {
  if (Array.isArray(value)) {
    return value.slice(0, Math.max(1, Math.floor(value.length / 2)));
  }
  if (!value || typeof value !== 'object') {
    return {
      truncated: true,
      message: 'This result was too large for the MCP connection and was not returned. Narrow the query.'
    };
  }
  const next = { ...value, truncated: true };
  let shortened = false;
  for (const key of ['transactions', 'categories', 'wallets', 'results', 'rows', 'config', 'currencies']) {
    if (Array.isArray(next[key]) && next[key].length > 1) {
      const half = Math.max(1, Math.floor(next[key].length / 2));
      next[key] = next[key].slice(0, half);
      next.returned = half;
      if (typeof next.offset === 'number') {
        next.nextOffset = next.offset + half;
      }
      shortened = true;
    }
  }
  next.message = shortened
    ? 'The result was shortened so it fits the MCP connection. Call again with nextOffset to continue.'
    : 'This result was too large for the MCP connection and was not returned. Narrow the query.';
  if (!shortened) {
    for (const key of Object.keys(next)) {
      if (key !== 'truncated' && key !== 'message' && key !== 'offset' && key !== 'nextOffset') {
        delete next[key];
      }
    }
  }
  return next;
};

const formatSuccess = (data) => {
  let structured = stripSensitiveFields(redact(data ?? {}));
  if (!structured || typeof structured !== 'object') {
    structured = { result: structured };
  }
  let text = JSON.stringify(structured, null, 2);
  for (let attempt = 0; text.length > MAX_TOOL_RESPONSE_CHARS && attempt < 12; attempt += 1) {
    structured = shrinkToolResult(structured);
    text = JSON.stringify(structured, null, 2);
  }
  if (text.length > MAX_TOOL_RESPONSE_CHARS) {
    structured = {
      truncated: true,
      message: 'This result was too large for the MCP connection and was not returned. Narrow the query.'
    };
    text = JSON.stringify(structured, null, 2);
  }
  return {
    content: [
      {
        type: 'text',
        text
      }
    ],
    structuredContent: structured
  };
};

const formatError = (error) => {
  const message = clip(error?.message || 'Unknown error', 1500);
  const base = {
    error: error?.name || 'Error',
    message
  };
  if (error?.code != null) {
    base.code = error.code;
  }
  if (error?.detail != null) {
    base.detail = redact(error.detail);
  }
  const text = base.code != null && !message.includes(String(base.code)) ? `${message} (${base.code})` : message;
  return {
    content: [{ type: 'text', text }],
    structuredContent: base,
    isError: true
  };
};

const clientOptions = () => {
  const timeout = Number(process.env.MONEYLOVER_TIMEOUT_MS);
  return {
    requestTimeout: Number.isFinite(timeout) && timeout > 0 ? timeout : 30000,
    timeZone: process.env.MONEYLOVER_TIMEZONE
  };
};

const withClient = async (token, fn) =>
  fn(
    new MoneyloverClient(token, {
      ...clientOptions(),
      refreshToken: cachedRefreshToken || null,
      onSession: async (next) => {
        cachedEnvToken = next.token;
        cachedRefreshToken = next.refreshToken ?? '';
        if (cachedEnvEmail) {
          try {
            await writeToken(cachedEnvEmail, next.token, { refreshToken: next.refreshToken ?? null });
          } catch (error) {
            warn('Failed to persist refreshed Money Lover token', error);
          }
        }
      }
    })
  );

const hasEnvCredentials = () => {
  const { email, password, directToken } = getEnvConfig();
  return Boolean(directToken || (email && password));
};

const fetchEnvToken = async (forceRefresh = false) => {
  const { email, password, directToken } = getEnvConfig();

  if (directToken && !forceRefresh) {
    cachedEnvUsesDirectToken = true;
    cachedEnvEmail = email;
    cachedEnvToken = directToken;
    envTokenPromise = null;
    cacheLoaded = true;
    return directToken;
  }

  if (directToken && forceRefresh && !(email && password)) {
    throw new Error(
      'Money Lover rejected MONEYLOVER_TOKEN, and MONEYLOVER_EMAIL/MONEYLOVER_PASSWORD (or EMAIL/PASSWORD) are not set, so it cannot be refreshed.'
    );
  }

  if (cachedEnvUsesDirectToken) {
    cachedEnvUsesDirectToken = false;
    cachedEnvToken = '';
    envTokenPromise = null;
    cacheLoaded = false;
  }

  if (!email || !password) {
    return null;
  }

  if (email !== cachedEnvEmail) {
    cachedEnvEmail = email;
    cachedEnvToken = '';
    envTokenPromise = null;
    cacheLoaded = false;
  }

  if (forceRefresh) {
    cachedEnvToken = '';
    cachedRefreshToken = '';
    envTokenPromise = null;
    cacheLoaded = false;
    try {
      await removeToken(email);
    } catch (error) {
      warn('Failed to clear cached Money Lover token', error);
    }
  }

  if (!cacheLoaded) {
    try {
      const storedToken = await readToken(email);
      if (storedToken) {
        cachedEnvToken = storedToken;
      }
      if (typeof readRefreshToken === 'function') {
        try {
          cachedRefreshToken = (await readRefreshToken(email)) ?? '';
        } catch (error) {
          warn('Failed to read cached Money Lover refresh token', error);
        }
      }
    } catch (error) {
      warn('Failed to read cached Money Lover token', error);
    }
    cacheLoaded = true;
  }

  if (cachedEnvToken && !accessTokenStillValid(cachedEnvToken)) {
    if (cachedRefreshToken) {
      try {
        const client = new MoneyloverClient(cachedEnvToken, {
          ...clientOptions(),
          refreshToken: cachedRefreshToken,
          onSession: async (next) => {
            cachedEnvToken = next.token;
            cachedRefreshToken = next.refreshToken ?? '';
            await writeToken(cachedEnvEmail, next.token, { refreshToken: next.refreshToken ?? null });
          }
        });
        return await client.refreshAccessToken();
      } catch (error) {
        warn('Cached Money Lover access token expired and refresh failed', error);
        cachedEnvToken = '';
      }
    } else {
      cachedEnvToken = '';
    }
  }

  if (cachedEnvToken) {
    return cachedEnvToken;
  }

  if (!envTokenPromise) {
    envTokenPromise = MoneyloverClient.getToken(email, password)
      .then(async (token) => {
        const refreshToken =
          MoneyloverClient.lastSession?.accessToken === token ? MoneyloverClient.lastSession.refreshToken : null;
        try {
          if (refreshToken) {
            await writeToken(email, token, { refreshToken });
          } else {
            await writeToken(email, token);
          }
        } catch (error) {
          warn('Failed to persist Money Lover token', error);
        }
        cachedEnvToken = token;
        cachedRefreshToken = refreshToken ?? '';
        cacheLoaded = true;
        envTokenPromise = null;
        return token;
      })
      .catch((error) => {
        envTokenPromise = null;
        throw error;
      });
  }
  return envTokenPromise;
};

const missingTokenError = () =>
  new Error(
    'Money Lover credentials are required. Set MONEYLOVER_EMAIL and MONEYLOVER_PASSWORD (EMAIL and PASSWORD still work), or set MONEYLOVER_TOKEN.'
  );

const runWithResolvedToken = async (providedToken, fn) => {
  let usedEnvToken = false;
  let token = providedToken;
  if (!token) {
    token = await fetchEnvToken();
    if (!token) {
      throw missingTokenError();
    }
    usedEnvToken = true;
  }

  try {
    return await fn(token);
  } catch (error) {
    if (usedEnvToken && isAuthError(error) && !isDeviceError(error)) {
      const refreshedToken = await fetchEnvToken(true);
      if (!refreshedToken || refreshedToken === token) {
        throw error;
      }
      return fn(refreshedToken);
    }
    throw error;
  }
};

const runWithClient = (token, fn) => runWithResolvedToken(token, (resolvedToken) => withClient(resolvedToken, fn));

const guard = (fn) => async (args) => {
  try {
    return formatSuccess((await fn(args ?? {})) ?? {});
  } catch (error) {
    return formatError(error instanceof Error ? error : new Error(String(error)));
  }
};

const rememberLogin = (email, token, refreshToken = null) => {
  const { email: envEmail } = getEnvConfig();
  if (email === envEmail && envEmail) {
    cachedEnvEmail = envEmail;
    cachedEnvToken = token;
    cachedRefreshToken = refreshToken ?? '';
    cacheLoaded = true;
    cachedEnvUsesDirectToken = false;
  }
};

const dateArgument = z
  .string()
  .min(8)
  .describe(
    'Calendar date, preferably YYYY-MM-DD. A plain YYYY-MM-DD is never timezone-shifted. ISO timestamps are converted in MONEYLOVER_TIMEZONE (default Australia/Adelaide). A UTC-midnight value such as 2026-04-18T00:00:00.000Z stays 2026-04-18.'
  );

const amountArgument = z
  .union([z.string().min(1), z.number()])
  .describe(
    'Amount. Money Lover stores a positive magnitude. Category type 1 is income and type 2 is expense. A leading minus is accepted on an expense category and rejected on an income category.'
  );

const dryRunArgument = z
  .boolean()
  .optional()
  .describe('When true, validate and return the request that would be sent. Nothing is written.');

const confirmArgument = z
  .boolean()
  .optional()
  .describe(
    'Must be true to delete or merge. A refusal is code CONFIRM_REQUIRED. Pass dryRun: true to preview without confirm.'
  );

const walletIdArgument = {
  walletId: z.string().min(1).describe('Wallet identifier')
};

const transactionDetailArguments = {
  with: z.array(z.string()).optional().describe('People on the transaction ("with"). Omit for none.'),
  excludeReport: z.boolean().optional().describe('Exclude this transaction from reports.'),
  eventId: z.string().optional().describe('Event id from get_events.'),
  reminder: z
    .union([z.string(), z.number()])
    .optional()
    .describe('Reminder. Omit for none. Passed through as the API remind field.'),
  longitude: z.union([z.string(), z.number()]).optional().describe('Location longitude. The API field is longtitude.'),
  latitude: z.union([z.string(), z.number()]).optional().describe('Location latitude.'),
  addressName: z.string().optional().describe('Location name.'),
  addressDetails: z.string().optional().describe('Location details.'),
  addressIcon: z.string().optional().describe('Location icon.'),
  image: z
    .string()
    .optional()
    .describe('Existing photo reference. This server does not upload files. The website accepts a photo under 2MB.')
};

const presentTransactions = (client, data) => {
  const transactions = unwrapList(data).map((transaction) => client.presentTransaction(transaction));
  const daterange = data && typeof data === 'object' && !Array.isArray(data) ? (data.daterange ?? null) : null;
  const reported = Number(data?.total ?? data?.count ?? data?.totalCount);
  return { transactions, daterange, reportedTotal: Number.isFinite(reported) ? reported : null };
};

const registerMoneyloverTools = (server) => {
  server.registerTool(
    'login',
    {
      title: 'Login to Money Lover',
      description:
        'Authenticate with Money Lover and cache the session for later tool calls. The JWT is stored under ~/.moneylover-mcp (mode 0600) and is not returned.',
      inputSchema: {
        email: z.string().email().describe('Money Lover account email'),
        password: z.string().min(1).describe('Money Lover account password')
      },
      outputSchema: {
        authenticated: z.boolean(),
        email: z.string(),
        cached: z.boolean()
      }
    },
    guard(async ({ email, password }) => {
      const session = await MoneyloverClient.login(email, password);
      let cached = true;
      try {
        if (session.refreshToken) {
          await writeToken(email, session.accessToken, { refreshToken: session.refreshToken });
        } else {
          await writeToken(email, session.accessToken);
        }
      } catch (error) {
        cached = false;
        warn('Failed to persist Money Lover token', error);
      }
      rememberLogin(email, session.accessToken, session.refreshToken);
      return { authenticated: true, email, cached };
    })
  );

  server.registerTool(
    'get_user_info',
    {
      title: 'Get User Info',
      description: 'Retrieve the Money Lover user profile for the configured session.',
      inputSchema: {}
    },
    guard(() => runWithClient(undefined, (client) => client.getUserInfo()))
  );

  server.registerTool(
    'whoami',
    {
      title: 'Check Connection',
      description:
        'Check the Money Lover session. Returns the account email, whether the account is tagged user_category_v2, and how many wallets the session can see. Does not return tokens.',
      inputSchema: {}
    },
    guard(() => runWithClient(undefined, (client) => client.whoami()))
  );

  server.registerTool(
    'get_wallets',
    {
      title: 'Get Wallets',
      description: 'List wallets for the authenticated user. Use the returned _id as walletId.',
      inputSchema: {},
      outputSchema: {
        wallets: z.array(z.record(z.any()))
      }
    },
    guard(async () => {
      const wallets = (await runWithClient(undefined, (client) => client.getWallets())) ?? [];
      return { wallets: Array.isArray(wallets) ? wallets : unwrapList(wallets) };
    })
  );

  server.registerTool(
    'get_categories',
    {
      title: 'Get Categories',
      description:
        'Raw POST /category/list for one wallet. This catalogue is larger than the add form: it includes categories the website picker does not offer. Use list_categories for ids that add_transaction can send. type 1 is income and type 2 is expense.',
      inputSchema: walletIdArgument,
      outputSchema: {
        categories: z.array(z.record(z.any()))
      }
    },
    guard(async ({ walletId }) => {
      const data = (await runWithClient(undefined, (client) => client.getCategories(walletId))) ?? [];
      const categories = unwrapList(data).map((category) => ({
        ...category,
        ...summarizeCategory(category)
      }));
      return { categories };
    })
  );

  server.registerTool(
    'list_categories',
    {
      title: 'List Categories',
      description:
        'Categories the website add form offers for one wallet: POST /category/list-all rows with account equal to this wallet. id and addId are the picker id to send on /transaction/add. Search and transaction lists show a different stored id for the same category. includeUnusable adds storedId and storedIds on the picker row; those are the ids search returns. Only picker categories can be used for a new transaction. The same add id can appear on other wallets; pair it with this walletId. Loan and Repayment are included when list-all has them; the website shows those on the debt tab. Set includeUnusable to also list stored /category/list rows the picker does not offer, each with a reason. Some wallets have no Other expense category.',
      inputSchema: {
        ...walletIdArgument,
        includeUnusable: z
          .boolean()
          .optional()
          .describe(
            'When true, also return stored /category/list rows that are not a single add-picker category, with reason and code CATEGORY_NOT_USABLE. reason is not_in_list_all, ambiguous, deleted, hidden, uncategorized, or different_wallet. ambiguous includes the candidate add ids. Default false.'
          )
      }
    },
    guard(async ({ walletId, includeUnusable }) => {
      const listed = await runWithClient(undefined, (client) =>
        client.listWalletCategories(walletId, { includeUnusable: includeUnusable === true })
      );
      const categories = listed.categories;
      const project = (category) => ({
        id: category.id,
        addId: category.addId,
        ...(category.storedId ? { storedId: category.storedId } : {}),
        ...(category.storedIds?.length > 1 ? { storedIds: category.storedIds } : {}),
        name: category.name,
        type: category.type,
        typeName: category.typeName,
        systemLabel: category.systemLabel,
        metadata: category.metadata,
        parentId: category.parentId,
        walletId: category.walletId
      });
      const result = {
        walletId,
        categories: categories.map(project),
        income: categories.filter((category) => category.typeName === 'income').map(project),
        expense: categories.filter((category) => category.typeName === 'expense').map(project)
      };
      if (includeUnusable === true) {
        result.unusable = listed.unusable.map((category) => ({
          id: category.id,
          name: category.name,
          type: category.type,
          typeName: category.typeName,
          metadata: category.metadata,
          walletId: category.walletId,
          reason: category.reason,
          ...(category.candidates ? { candidates: category.candidates } : {}),
          code: category.code
        }));
      }
      return result;
    })
  );

  server.registerTool(
    'get_transactions',
    {
      title: 'Get Transactions',
      description:
        'Transactions in a wallet between two calendar dates. displayDate is normalized to YYYY-MM-DD so it does not shift by a day. Results are paged (default 500). When truncated is true, call again with offset. The list endpoint is not known to support a server-side cursor.',
      inputSchema: {
        ...walletIdArgument,
        startDate: dateArgument.describe('Range start, YYYY-MM-DD'),
        endDate: dateArgument.describe('Range end, YYYY-MM-DD'),
        limit: z.number().int().min(1).max(2000).optional().describe('Page size. Default 500.'),
        offset: z.number().int().min(0).optional().describe('Number of transactions to skip. Default 0.')
      }
    },
    guard(async ({ walletId, startDate, endDate, limit = 500, offset = 0 }) =>
      runWithClient(undefined, async (client) => {
        const data = await client.getTransactions(walletId, startDate, endDate);
        const presented = presentTransactions(client, data);
        const page = pageItems(presented.transactions, { limit, offset, maxLimit: 2000 });
        return {
          transactions: page.items,
          daterange: presented.daterange,
          total: presented.reportedTotal ?? page.total,
          returned: page.returned,
          truncated:
            page.truncated ||
            (presented.reportedTotal != null && presented.reportedTotal > page.offset + page.returned),
          offset: page.offset,
          nextOffset: page.truncated ? page.offset + page.returned : null
        };
      })
    )
  );

  server.registerTool(
    'add_transaction',
    {
      title: 'Add Transaction',
      description:
        'Create one transaction. Amount is sent as a positive magnitude; pick an income category (type 1) or expense category (type 2) from list_categories for this wallet. categoryId is that add id. The same add id may exist on other wallets; walletId selects the row. A stored catalogue id or name that the add picker does not offer is refused with CATEGORY_NOT_USABLE and nothing is posted. date YYYY-MM-DD is not timezone-shifted. Optional fields match the website form: with, reminder, location, event, an existing photo reference, and exclude from report. This server does not upload a photo file. Set dryRun to preview. Set skipDuplicates to skip an existing transaction with the same wallet, date, absolute amount, and similar note.',
      inputSchema: {
        ...walletIdArgument,
        categoryId: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Add id from list_categories for this wallet. A stored /category/list id is accepted only when it maps to an add-picker row. The same add id may exist on other wallets; walletId selects which row.'
          ),
        category: z
          .string()
          .min(1)
          .optional()
          .describe('Category name in this wallet, used when categoryId is omitted. A shared name needs categoryId.'),
        amount: amountArgument,
        note: z.string().optional().describe('Payee or note'),
        date: dateArgument,
        ...transactionDetailArguments,
        amountMode: z
          .enum(['magnitude', 'signed'])
          .optional()
          .describe(
            'magnitude (default) accepts a positive amount for either category type. signed requires a negative expense or a positive income.'
          ),
        skipDuplicates: z
          .boolean()
          .optional()
          .describe('When true, do not create a matching existing transaction. Default false.'),
        dryRun: dryRunArgument
      }
    },
    guard(async ({ skipDuplicates, ...payload }) => {
      const summary = await runWithClient(undefined, (client) =>
        createTransactions(client, {
          walletId: payload.walletId,
          transactions: [payload],
          skipDuplicates: skipDuplicates === true,
          dryRun: payload.dryRun === true,
          amountMode: payload.amountMode
        })
      );
      const row = summary.results[0];
      if (row.status === 'error') {
        throw errorFromTransactionRow(row);
      }
      if (row.status === 'skipped_duplicate') {
        return { skipped: true, reason: 'duplicate', ...row };
      }
      if (row.status === 'dry_run') {
        return row;
      }
      return row;
    })
  );

  server.registerTool(
    'add_transactions',
    {
      title: 'Add Transactions',
      description:
        'Import a batch of transactions (max 200). Each row needs date, amount, note, and category or categoryId. Returns one result per row (created, skipped_duplicate, dry_run, or error) and continues after a row fails. Duplicates are the same wallet, calendar date, absolute amount, and similar note, matched through /transaction/search. Each written note gets an ml-batch marker and the created ids are stored locally so undo_import can remove them, unless markBatch is false. skipDuplicates defaults to true. Use dryRun to preview. Amounts are stored as positive magnitudes; category type selects income or expense.',
      inputSchema: {
        ...walletIdArgument,
        transactions: z
          .array(
            z.object({
              date: z.string().min(8),
              amount: z.union([z.string(), z.number()]),
              note: z.string().optional(),
              categoryId: z.string().min(1).optional(),
              category: z.string().min(1).optional(),
              with: z.array(z.string()).optional(),
              excludeReport: z.boolean().optional(),
              eventId: z.string().optional(),
              reminder: z.union([z.string(), z.number()]).optional(),
              longitude: z.union([z.string(), z.number()]).optional(),
              latitude: z.union([z.string(), z.number()]).optional(),
              addressName: z.string().optional(),
              image: z.string().optional()
            })
          )
          .min(1)
          .max(200)
          .describe('Transactions to create'),
        skipDuplicates: z.boolean().optional().describe('Skip duplicate rows. Default true.'),
        dryRun: dryRunArgument,
        amountMode: z
          .enum(['magnitude', 'signed'])
          .optional()
          .describe('magnitude (default) or signed. See add_transaction.'),
        batchId: z
          .string()
          .min(4)
          .max(80)
          .optional()
          .describe(
            'Id stored as an ml-batch marker in each note and in the local import log. A new id is used when omitted.'
          ),
        markBatch: z
          .boolean()
          .optional()
          .describe(
            'When false, notes are saved without the ml-batch marker and the local import log is not written. undo_import cannot find the batch. Default true.'
          )
      }
    },
    guard(async ({ walletId, transactions, skipDuplicates, dryRun, amountMode, batchId, markBatch }) =>
      runWithClient(undefined, (client) =>
        createTransactions(client, {
          walletId,
          transactions,
          skipDuplicates,
          dryRun,
          amountMode,
          markBatch: markBatch !== false,
          batchId: markBatch === false ? undefined : batchId
        })
      )
    )
  );

  server.registerTool(
    'import_transactions_csv',
    {
      title: 'Import Transactions CSV',
      description:
        'Parse a bank CSV and import it. Accepts a header row plus Date, Amount and/or Debit and Credit, and Description/Narrative/Payee. Australian dates (DD/MM/YYYY) are the default when the order is ambiguous. Debits and negative amounts are expenses; credits and positive amounts are income. Pass expenseCategory and incomeCategory (name or id), a defaultCategory, or a category column. Without a category the tool returns the parsed rows and does not write. skipDuplicates defaults to true. dryRun previews the Money Lover payload. Written notes include an ml-batch marker unless markBatch is false. Never put the CSV in git.',
      inputSchema: {
        ...walletIdArgument,
        csv: z.string().min(1).describe('Full CSV text, including the header row'),
        expenseCategory: z.string().optional().describe('Category name or id for debits and negative amounts'),
        incomeCategory: z.string().optional().describe('Category name or id for credits and positive amounts'),
        defaultCategory: z.string().optional().describe('Category used for every row that has no category of its own'),
        dateOrder: z
          .enum(['auto', 'DMY', 'MDY', 'YMD'])
          .optional()
          .describe(
            'Date column order. Default auto, which prefers DMY for Australian statements when a value is unambiguous.'
          ),
        mapping: z
          .object({
            date: z.string().optional(),
            amount: z.string().optional(),
            debit: z.string().optional(),
            credit: z.string().optional(),
            note: z.string().optional(),
            category: z.string().optional()
          })
          .optional()
          .describe('Header names when the file does not use common bank columns'),
        skipDuplicates: z.boolean().optional().describe('Skip duplicate rows. Default true.'),
        dryRun: dryRunArgument,
        amountMode: z.enum(['magnitude', 'signed']).optional(),
        markBatch: z
          .boolean()
          .optional()
          .describe(
            'When false, notes are saved without the ml-batch marker and the local import log is not written. undo_import cannot find the batch. Default true.'
          )
      }
    },
    guard(
      async ({
        csv,
        walletId,
        expenseCategory,
        incomeCategory,
        defaultCategory,
        dateOrder,
        mapping,
        skipDuplicates,
        dryRun,
        amountMode,
        markBatch
      }) => {
        const parsed = rowsFromBankCsv(csv, {
          expenseCategory,
          incomeCategory,
          defaultCategory,
          dateOrder,
          mapping,
          timeZone: process.env.MONEYLOVER_TIMEZONE
        });
        const needsCategory = parsed.rows.filter((row) => !row.error && !row.category);
        if (parsed.rows.every((row) => row.error || !row.category)) {
          return {
            status: 'needs_categories',
            dateOrder: parsed.dateOrder,
            delimiter: parsed.delimiter === '\t' ? 'tab' : parsed.delimiter,
            rowCount: parsed.rows.length,
            rows: parsed.rows.map((row) => ({
              index: row.index,
              date: row.date,
              amount: row.amount,
              note: row.note,
              direction: row.direction,
              error: row.error ?? 'category is required'
            })),
            message:
              'The CSV was parsed and nothing was written. Pass expenseCategory and incomeCategory, defaultCategory, or a category column, or copy these rows into add_transactions.'
          };
        }

        const mode = amountMode ?? (expenseCategory || incomeCategory ? 'signed' : 'magnitude');
        const summary = await runWithClient(undefined, (client) =>
          createTransactions(client, {
            walletId,
            transactions: parsed.rows.map((row) => ({
              date: row.date,
              amount: row.amount,
              note: row.note,
              category: row.category,
              direction: row.direction,
              error: row.error ?? (row.category ? undefined : 'category is required')
            })),
            skipDuplicates,
            dryRun,
            amountMode: mode,
            markBatch: markBatch !== false
          })
        );
        return {
          ...summary,
          dateOrder: parsed.dateOrder,
          uncategorized: needsCategory.length,
          amountMode: mode
        };
      }
    )
  );

  server.registerTool(
    'get_user_account',
    {
      title: 'Get User Account',
      description: 'List devices and sessions tied to the Money Lover account.',
      inputSchema: {}
    },
    guard(async () => {
      const data = (await runWithClient(undefined, (client) => client.getUserAccount())) ?? [];
      return { devices: data };
    })
  );

  server.registerTool(
    'get_user_profile',
    {
      title: 'Get User Profile',
      description: 'Retrieve extended profile information for the current user.',
      inputSchema: {}
    },
    guard(() => runWithClient(undefined, (client) => client.getUserProfile()))
  );

  server.registerTool(
    'get_wallet_balance',
    {
      title: 'Get Wallet Balance',
      description: 'Fetch the current balance summary for a wallet.',
      inputSchema: walletIdArgument
    },
    guard(({ walletId }) => runWithClient(undefined, (client) => client.getWalletBalance(walletId)))
  );

  server.registerTool(
    'get_shared_wallets',
    {
      title: 'Get Shared Wallets',
      description: 'List wallets shared with other people.',
      inputSchema: {}
    },
    guard(async () => {
      const data = (await runWithClient(undefined, (client) => client.getSharedWallets())) ?? [];
      return { wallets: data };
    })
  );

  server.registerTool(
    'get_awaiting_shared_wallets',
    {
      title: 'Get Awaiting Shared Wallets',
      description: 'List wallet share invitations that are still pending.',
      inputSchema: {}
    },
    guard(async () => {
      const data = (await runWithClient(undefined, (client) => client.getAwaitingSharedWallets())) ?? [];
      return { invitations: data };
    })
  );

  server.registerTool(
    'get_all_categories',
    {
      title: 'Get All Categories',
      description:
        'The add-picker catalogue from POST /category/list-all, fetched once per process and reused. The same _id can appear under many wallets; rows are not collapsed. Prefer list_categories for one wallet. The response is paged. total and truncated say whether the page is complete.',
      inputSchema: {
        limit: z.number().int().min(1).max(1000).optional().describe('Page size. Default 200.'),
        offset: z.number().int().min(0).optional().describe('Number of categories to skip.')
      }
    },
    guard(async ({ limit = 200, offset = 0 }) =>
      runWithClient(undefined, async (client) => {
        const wallets = unwrapList(await client.getWallets());
        const walletIds = new Set(wallets.map((wallet) => wallet?._id).filter(Boolean));
        const all = unwrapList(await client.getAllCategories());
        const mine =
          walletIds.size === 0
            ? all
            : all.filter((category) => {
                const account = category?.account ?? category?.walletId;
                return !account || walletIds.has(account);
              });
        const page = pageItems(mine.map(summarizeCategory), { limit, offset, maxLimit: 1000 });
        return {
          categories: page.items,
          total: page.total,
          returned: page.returned,
          truncated: page.truncated,
          offset: page.offset,
          nextOffset: page.truncated ? page.offset + page.returned : null
        };
      })
    )
  );

  server.registerTool(
    'get_transaction_search_config',
    {
      title: 'Get Transaction Search Config',
      description: 'Saved labels, parties, and filters for search_transactions.',
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional().describe('Maximum config entries to return. Default 50.'),
        offset: z.number().int().min(0).optional()
      }
    },
    guard(async ({ limit = 50, offset = 0 }) =>
      runWithClient(undefined, async (client) => {
        const raw = (await client.getTransactionSearchConfig()) ?? {};
        const entries = Array.isArray(raw) ? raw : Object.values(raw);
        const page = pageItems(entries, { limit, offset, maxLimit: 200 });
        return {
          config: page.items,
          total: page.total,
          returned: page.returned,
          truncated: page.truncated,
          offset: page.offset
        };
      })
    )
  );

  server.registerTool(
    'search_transactions',
    {
      title: 'Search Transactions',
      description:
        'Search transactions with the web app filter: accounts (wallet ids), categoryIDs, startDate, endDate, note, with, and amount {from, to}. Money Lover ignores limit and always returns 50 rows; offset works. When a full page of 50 comes back, nextOffset is offset + returned and the page is not treated as the end of the list. displayDate is normalized to YYYY-MM-DD. tokenDevice is not returned. Duplicate checks for imports use this same filter.',
      inputSchema: {
        accounts: z.array(z.string().min(1)).optional().describe('Wallet ids. Alias: walletId.'),
        walletId: z.string().min(1).optional().describe('Single wallet id, sent as accounts: [walletId].'),
        categoryIDs: z.array(z.string().min(1)).optional().describe('Category ids.'),
        categoryId: z.string().min(1).optional().describe('One category id, sent as categoryIDs.'),
        startDate: dateArgument.optional(),
        endDate: dateArgument.optional(),
        note: z.string().optional().describe('Note text. The web app sends this as note.'),
        with: z.array(z.string()).optional().describe('Related parties.'),
        amountFrom: z.number().optional().describe('Minimum amount, sent as amount.from.'),
        amountTo: z.number().optional().describe('Maximum amount, sent as amount.to.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe('Ignored. Money Lover always returns 50 rows. Use offset and nextOffset.'),
        offset: z.number().int().min(0).optional().describe('Offset sent to the API. Default 0.')
      }
    },
    guard(async ({ offset = 0, ...filters }) =>
      runWithClient(undefined, async (client) => {
        const query = buildSearchFilter(
          { ...filters, limit: SEARCH_PAGE_SIZE, offset },
          { timeZone: process.env.MONEYLOVER_TIMEZONE }
        );
        const raw = await client.searchTransactions(query);
        const presented = presentTransactions(client, raw);
        return {
          transactions: presented.transactions,
          filter: query,
          ...pageSearchResult({
            transactions: presented.transactions,
            offset,
            reportedTotal: presented.reportedTotal
          })
        };
      })
    )
  );

  server.registerTool(
    'search_transaction_totals',
    {
      title: 'Search Transaction Totals',
      description:
        'Income, expense, net, and count for the same filter as search_transactions. /transaction/search/balance returns every matching transaction, which can be thousands of rows. This tool adds them up on the server and does not return those rows or their tokenDevice values.',
      inputSchema: {
        accounts: z.array(z.string().min(1)).optional(),
        walletId: z.string().min(1).optional(),
        categoryIDs: z.array(z.string().min(1)).optional(),
        categoryId: z.string().min(1).optional(),
        startDate: dateArgument.optional(),
        endDate: dateArgument.optional(),
        note: z.string().optional(),
        with: z.array(z.string()).optional(),
        amountFrom: z.number().optional(),
        amountTo: z.number().optional()
      }
    },
    guard((filters) =>
      runWithClient(undefined, async (client) => {
        const query = buildSearchFilter(filters, { timeZone: process.env.MONEYLOVER_TIMEZONE });
        const totals = await client.searchTransactionTotals(query);
        return { filter: query, ...totals };
      })
    )
  );

  server.registerTool(
    'get_debt_transactions',
    {
      title: 'Get Debt Transactions',
      description: 'List transactions flagged as debts or loans.',
      inputSchema: {}
    },
    guard(async () => {
      const data = (await runWithClient(undefined, (client) => client.getDebtTransactions())) ?? [];
      return { transactions: Array.isArray(data) ? data : unwrapList(data) };
    })
  );

  server.registerTool(
    'get_related_transactions',
    {
      title: 'Get Related Transactions',
      description: 'Fetch transactions linked to one or more transaction ids.',
      inputSchema: {
        ids: z.array(z.string().min(1)).min(1).describe('Transaction ids')
      }
    },
    guard(async ({ ids }) => {
      const data = await runWithClient(undefined, (client) => client.getRelatedTransactions(ids));
      return { transactions: Array.isArray(data) ? data : unwrapList(data) };
    })
  );

  server.registerTool(
    'get_related_transactions_by_category',
    {
      title: 'Get Related Transactions By Category',
      description: 'List transactions linked to a category.',
      inputSchema: {
        categoryId: z.string().min(1).describe('Category identifier')
      }
    },
    guard(({ categoryId }) => runWithClient(undefined, (client) => client.getRelatedTransactionsByCategory(categoryId)))
  );

  server.registerTool(
    'get_related_transactions_by_wallet',
    {
      title: 'Get Related Transactions By Wallet',
      description: 'List transactions linked to a wallet.',
      inputSchema: walletIdArgument
    },
    guard(({ walletId }) => runWithClient(undefined, (client) => client.getRelatedTransactionsByWallet(walletId)))
  );

  server.registerTool(
    'get_events',
    {
      title: 'Get Events',
      description: 'Savings goals and campaigns for a wallet.',
      inputSchema: {
        ...walletIdArgument,
        limit: z.number().int().min(1).max(200).optional().describe('Page size. Default 50.'),
        offset: z.number().int().min(0).optional()
      }
    },
    guard(async ({ walletId, limit = 50, offset = 0 }) =>
      runWithClient(undefined, async (client) => {
        const all = unwrapList(await client.getEvents(walletId));
        const page = pageItems(all, { limit, offset, maxLimit: 200 });
        return {
          events: page.items,
          total: page.total,
          returned: page.returned,
          truncated: page.truncated,
          offset: page.offset
        };
      })
    )
  );

  server.registerTool(
    'get_debts',
    {
      title: 'Get Debts',
      description: 'Open debts or loans tracked in a wallet.',
      inputSchema: walletIdArgument
    },
    guard(async ({ walletId }) => {
      const data = (await runWithClient(undefined, (client) => client.getDebts(walletId))) ?? [];
      return { debts: Array.isArray(data) ? data : unwrapList(data) };
    })
  );

  server.registerTool(
    'get_icons',
    {
      title: 'Get Icons',
      description: 'Icon pack used by categories and wallets. Icon names look like icon_3.',
      inputSchema: {
        pack: z.string().min(1).optional().describe('Icon pack id. Default "default".')
      }
    },
    guard(({ pack }) => runWithClient(undefined, (client) => client.getIcons(pack ?? 'default')))
  );

  server.registerTool(
    'get_linked_providers',
    {
      title: 'Get Linked Providers',
      description:
        'Financial institutions Money Lover can link. This server does not link bank feeds; import a CSV or call add_transactions.',
      inputSchema: {}
    },
    guard(async () => {
      const data = (await runWithClient(undefined, (client) => client.getLinkedProviders())) ?? [];
      return { providers: data };
    })
  );

  server.registerTool(
    'get_currencies',
    {
      title: 'Get Currencies',
      description: 'Currencies supported by Money Lover. Use the id as currencyId when creating a wallet.',
      inputSchema: {
        limit: z.number().int().min(1).max(1000).optional().describe('Page size. Default 200.'),
        offset: z.number().int().min(0).optional()
      }
    },
    guard(async ({ limit = 200, offset = 0 }) =>
      runWithClient(undefined, async (client) => {
        const raw = await client.getCurrencies();
        const values = raw && typeof raw === 'object' && !Array.isArray(raw) ? Object.values(raw) : [];
        const currencies = Array.isArray(raw)
          ? raw
          : values.length > 0 && values.every(Array.isArray)
            ? values.flat()
            : unwrapList(raw);
        const page = pageItems(currencies, { limit, offset, maxLimit: 1000 });
        return {
          currencies: page.items,
          total: page.total,
          returned: page.returned,
          truncated: page.truncated,
          offset: page.offset
        };
      })
    )
  );

  server.registerTool(
    'get_exchange_rates',
    {
      title: 'Get Exchange Rates',
      description: 'Exchange rate snapshot used by Money Lover.',
      inputSchema: {}
    },
    guard(() => runWithClient(undefined, (client) => client.getExchangeRates()))
  );

  server.registerTool(
    'get_other_config',
    {
      title: 'Get Other Config',
      description: 'Static configuration from /other/config.',
      inputSchema: {}
    },
    guard(() => runWithClient(undefined, (client) => client.getOtherConfig()))
  );

  server.registerTool(
    'edit_transaction',
    {
      title: 'Edit Transaction',
      description:
        'Change a transaction without wiping the rest of it. The server loads the current row (pass walletId and currentDate so the search can find it), then writes account, category, amount, note, date, with, exclude_report, event, image, reminder, location, and the debt parent. Omit a field to keep the stored value. Pass an empty string or empty array only when you mean to clear note or with. dryRun previews the merged payload.',
      inputSchema: {
        transactionId: z.string().min(1).describe('Transaction identifier'),
        walletId: z.string().min(1).optional().describe('Wallet id. Required to find the row when currentDate is set.'),
        currentDate: dateArgument
          .optional()
          .describe('The transaction’s current day, used to find it. Use this when date is the new day.'),
        categoryId: z.string().min(1).optional().describe('Replacement category id from this wallet’s category list.'),
        category: z.string().min(1).optional().describe('Replacement category name.'),
        amount: amountArgument.optional(),
        date: dateArgument.optional().describe('New calendar date. Omit to keep the current day.'),
        note: z.string().optional().describe('Replacement note. Omit to keep the current note.'),
        with: z.array(z.string()).optional().describe('Replacement parties. Omit to keep the current list.'),
        excludeReport: z.boolean().optional().describe('exclude_report. Omit to keep the current flag.'),
        eventId: z
          .string()
          .optional()
          .describe('Event id. Omit to keep the current event. Pass an empty string to clear it.'),
        reminder: z.union([z.string(), z.number()]).optional().describe('Reminder. Omit to keep the current reminder.'),
        longitude: z
          .union([z.string(), z.number()])
          .optional()
          .describe('Location longitude. Omit to keep the current value.'),
        latitude: z
          .union([z.string(), z.number()])
          .optional()
          .describe('Location latitude. Omit to keep the current value.'),
        addressName: z.string().optional().describe('Location name. Omit to keep the current value.'),
        addressDetails: z.string().optional().describe('Location details. Omit to keep the current value.'),
        addressIcon: z.string().optional().describe('Location icon. Omit to keep the current value.'),
        image: z
          .string()
          .optional()
          .describe('Existing photo reference. Omit to keep the current image. This server does not upload files.'),
        parentId: z.string().optional().describe('Debt or loan parent transaction id.'),
        dryRun: dryRunArgument
      }
    },
    guard(({ transactionId, ...params }) =>
      runWithClient(undefined, (client) => client.editTransaction(transactionId, params))
    )
  );

  server.registerTool(
    'delete_transaction',
    {
      title: 'Delete Transaction',
      description:
        'Permanently delete a transaction. Requires confirm: true. Pass dryRun: true to preview without deleting. The body is {_id, delRelated}. delRelated is false unless deleteRelated is true. The server assigns the transaction id (often prefixed web) when the transaction is created.',
      inputSchema: {
        transactionId: z.string().min(1).describe('Transaction identifier'),
        deleteRelated: z
          .boolean()
          .optional()
          .describe('When true, the API also deletes the related transfer leg. Default false.'),
        confirm: confirmArgument,
        dryRun: dryRunArgument
      }
    },
    guard(async ({ transactionId, confirm, dryRun, deleteRelated }) => {
      assertConfirm({ confirm, dryRun, action: 'delete this transaction' });
      return runWithClient(undefined, (client) =>
        client.deleteTransaction(transactionId, { dryRun: dryRun === true, deleteRelated: deleteRelated === true })
      );
    })
  );

  server.registerTool(
    'add_wallet',
    {
      title: 'Add Wallet',
      description:
        'Create a wallet. currencyId comes from get_currencies. Australian dollars are currency id 20 in the Money Lover catalogue (confirm with get_currencies if that list changes). dryRun previews the payload.',
      inputSchema: {
        name: z.string().min(1).describe('Wallet name'),
        currencyId: z.number().int().positive().describe('Currency id'),
        icon: z.string().optional().describe('Icon name. Default icon_7.'),
        dryRun: dryRunArgument
      }
    },
    guard(({ name, currencyId, icon, dryRun }) =>
      runWithClient(undefined, (client) => client.addWallet({ name, currencyId, icon, dryRun }))
    )
  );

  server.registerTool(
    'edit_wallet',
    {
      title: 'Edit Wallet',
      description:
        'Update a wallet. The current wallet is read first so credit (account_type, 4 for a credit wallet), exclude_total, and archived are sent back. Pass a field only when you want to change it. currencyId can be omitted when the wallet can be read. AUD is currency id 20. dryRun previews the payload.',
      inputSchema: {
        walletId: z.string().min(1),
        currencyId: z.number().int().positive().optional().describe('Currency id. Omit to keep the current one.'),
        name: z.string().min(1).optional(),
        icon: z.string().optional(),
        accountType: z
          .number()
          .int()
          .optional()
          .describe('Wallet type. 0 basic, 2 linked, 4 credit. Omit to keep the current type.'),
        excludeFromTotal: z.boolean().optional().describe('exclude_total. Omit to keep the current flag.'),
        archived: z.boolean().optional().describe('Archived flag. Omit to keep the current flag.'),
        dryRun: dryRunArgument
      }
    },
    guard(({ walletId, dryRun, ...params }) =>
      runWithClient(undefined, (client) => client.editWallet(walletId, { ...params, dryRun }))
    )
  );

  server.registerTool(
    'delete_wallet',
    {
      title: 'Delete Wallet',
      description:
        'Permanently delete a wallet and the data Money Lover removes with it. Requires confirm: true. Pass dryRun: true to preview.',
      inputSchema: {
        walletId: z.string().min(1),
        confirm: confirmArgument,
        dryRun: dryRunArgument
      }
    },
    guard(async ({ walletId, confirm, dryRun }) => {
      assertConfirm({ confirm, dryRun, action: 'delete this wallet' });
      return runWithClient(undefined, (client) => client.deleteWallet(walletId, { dryRun: dryRun === true }));
    })
  );

  server.registerTool(
    'add_category',
    {
      title: 'Add Category',
      description:
        'Create a category. type 1 is income and type 2 is expense. icon comes from get_icons (for example icon_3). parentId makes this a sub-category of that category. Accounts tagged user_category_v2 cannot change categories. dryRun previews the payload.',
      inputSchema: {
        walletId: z.string().min(1),
        name: z.string().min(1),
        icon: z.string().min(1).describe('Icon name from get_icons'),
        type: z.number().int().min(1).max(2).describe('1 = income, 2 = expense'),
        parentId: z.string().min(1).optional().describe('Parent category id for a sub-category.'),
        dryRun: dryRunArgument
      }
    },
    guard(({ dryRun, ...params }) => runWithClient(undefined, (client) => client.addCategory({ ...params, dryRun })))
  );

  server.registerTool(
    'edit_category',
    {
      title: 'Edit Category',
      description:
        'Rename a category or change its icon. The API requires icon even when only the name changes. dryRun previews the payload.',
      inputSchema: {
        categoryId: z.string().min(1),
        icon: z.string().min(1).describe('Icon name. Required even when unchanged.'),
        name: z.string().min(1).optional(),
        dryRun: dryRunArgument
      }
    },
    guard(({ categoryId, dryRun, ...params }) =>
      runWithClient(undefined, (client) => client.editCategory(categoryId, { ...params, dryRun }))
    )
  );

  server.registerTool(
    'delete_category',
    {
      title: 'Delete Category',
      description: 'Permanently delete a category. Requires confirm: true. Pass dryRun: true to preview.',
      inputSchema: {
        categoryId: z.string().min(1),
        confirm: confirmArgument,
        dryRun: dryRunArgument
      }
    },
    guard(async ({ categoryId, confirm, dryRun }) => {
      assertConfirm({ confirm, dryRun, action: 'delete this category' });
      return runWithClient(undefined, (client) => client.deleteCategory(categoryId, { dryRun: dryRun === true }));
    })
  );

  server.registerTool(
    'merge_categories',
    {
      title: 'Merge Categories',
      description:
        'Merge one category into another via /category/merge {id1, id2}. id1 is the category that goes away and id2 is the category that remains. The web app moves transactions, and child categories follow the target. This cannot be undone. Requires confirm: true. Accounts tagged user_category_v2 cannot merge categories.',
      inputSchema: {
        fromCategoryId: z.string().min(1).describe('Category to merge away (id1).'),
        toCategoryId: z.string().min(1).describe('Category that remains (id2).'),
        confirm: confirmArgument,
        dryRun: dryRunArgument
      }
    },
    guard(async ({ fromCategoryId, toCategoryId, confirm, dryRun }) => {
      assertConfirm({ confirm, dryRun, action: 'merge these categories' });
      return runWithClient(undefined, (client) =>
        client.mergeCategories(fromCategoryId, toCategoryId, { dryRun: dryRun === true })
      );
    })
  );

  server.registerTool(
    'transfer_money',
    {
      title: 'Transfer Money',
      description:
        'Move money between two of your wallets in one /transaction/add-multi call: an outgoing leg, an incoming leg, and an optional fee leg. Use this for a bank-to-card payment so it is not counted as both spending and income. Outgoing transfer, Incoming transfer, and Other expense are used only when that metadata is in the add picker for that wallet (list_categories). A stored catalogue row that the picker does not offer is refused with CATEGORY_NOT_USABLE. If the picker has no matching category, pass fromCategoryId, toCategoryId, or feeCategoryId from list_categories. Default notes use wallet names from /wallet/list, loaded once per process. Pass fromNote and toNote to skip that lookup. dryRun previews the legs.',
      inputSchema: {
        fromWalletId: z.string().min(1),
        toWalletId: z.string().min(1),
        amount: amountArgument.describe('Amount leaving the source wallet.'),
        toAmount: amountArgument.optional().describe('Amount arriving in the destination wallet. Defaults to amount.'),
        date: dateArgument,
        note: z.string().optional().describe('Note on the outgoing leg when fromNote is omitted.'),
        fromNote: z
          .string()
          .optional()
          .describe('Note on the outgoing leg. Together with toNote, skips the wallet-name lookup.'),
        toNote: z
          .string()
          .optional()
          .describe('Note on the incoming leg. Together with fromNote or note, skips the wallet-name lookup.'),
        feeAmount: amountArgument.optional().describe('Optional fee, posted as its own expense leg.'),
        feeWalletId: z
          .string()
          .min(1)
          .optional()
          .describe('Wallet charged for the fee. Defaults to the source wallet.'),
        feeNote: z.string().optional(),
        fromCategoryId: z
          .string()
          .optional()
          .describe(
            'Outgoing category on the source wallet. Required when that wallet has no Outgoing transfer category.'
          ),
        toCategoryId: z
          .string()
          .optional()
          .describe(
            'Incoming category on the destination wallet. Required when that wallet has no Incoming transfer category.'
          ),
        feeCategoryId: z
          .string()
          .optional()
          .describe('Fee category on the fee wallet. Required when that wallet has no Other expense category.'),
        excludeReport: z.boolean().optional(),
        dryRun: dryRunArgument
      }
    },
    guard((params) => runWithClient(undefined, (client) => client.transferMoney(params)))
  );

  server.registerTool(
    'adjust_balance',
    {
      title: 'Adjust Balance',
      description:
        'Set a wallet balance by adding one transaction for the difference. When the balance must rise, the category is this wallet’s Other income category in the add picker. When it must fall, it is this wallet’s Other expense category in the add picker. A stored Other expense row that list_categories does not return is refused with CATEGORY_NOT_USABLE. Pass categoryId from list_categories when the picker has no Other expense or Other income. dryRun previews the transaction.',
      inputSchema: {
        ...walletIdArgument,
        balance: z.union([z.number(), z.string()]).describe('The balance the wallet should show after the adjustment.'),
        date: dateArgument.optional().describe('Adjustment date. Default is today in MONEYLOVER_TIMEZONE.'),
        note: z.string().optional().describe('Note. Default "Balance adjustment".'),
        categoryId: z
          .string()
          .optional()
          .describe(
            'Category id from this wallet. Required when this wallet has no Other income or Other expense category.'
          ),
        excludeReport: z.boolean().optional(),
        dryRun: dryRunArgument
      }
    },
    guard((params) => runWithClient(undefined, (client) => client.adjustBalance(params)))
  );

  server.registerTool(
    'get_balance_as_of',
    {
      title: 'Balance As Of Date',
      description:
        'Balance at the end of a calendar date. Starts from the current /wallet/balance and subtracts income and expense posted after that date. Transactions with no category type are listed in skipped and incomplete is true. There is no dedicated balance-as-of endpoint in the web app.',
      inputSchema: {
        ...walletIdArgument,
        date: dateArgument.describe('The calendar date to measure, YYYY-MM-DD.')
      }
    },
    guard(({ walletId, date }) => runWithClient(undefined, (client) => client.balanceAsOf({ walletId, date })))
  );

  server.registerTool(
    'undo_import',
    {
      title: 'Undo Import',
      description:
        'Delete the transactions from one import batch. Uses the local import log when this process has one. With no log, pass walletId plus startDate and endDate and it searches that range for notes tagged ml-batch:<batchId>. Requires confirm: true. A refusal is code CONFIRM_REQUIRED. Set deleteRelated: true to also delete a transfer’s other leg. dryRun lists the ids and does not delete them.',
      inputSchema: {
        batchId: z.string().min(4).max(80).describe('batchId returned by add_transactions or import_transactions_csv.'),
        walletId: z
          .string()
          .min(1)
          .optional()
          .describe('Wallet to search when the import log is missing. Also used with startDate and endDate.'),
        startDate: dateArgument.optional().describe('First day to search when the import log is missing, YYYY-MM-DD.'),
        endDate: dateArgument.optional().describe('Last day to search when the import log is missing, YYYY-MM-DD.'),
        deleteRelated: z.boolean().optional().describe('Also delete related transfer legs. Default false.'),
        confirm: confirmArgument,
        dryRun: dryRunArgument
      }
    },
    guard(async ({ batchId, walletId, startDate, endDate, deleteRelated, confirm, dryRun }) => {
      assertConfirm({ confirm, dryRun, action: 'delete this import batch' });
      const id = assertBatchId(batchId);
      return runWithClient(undefined, (client) =>
        undoImport(client, id, {
          deleteRelated: deleteRelated === true,
          dryRun: dryRun === true,
          walletId,
          startDate,
          endDate
        })
      );
    })
  );

  server.registerTool(
    'get_budgets',
    {
      title: 'Get Budgets',
      description:
        'List budgets. Pass walletId to call /budget/list/{walletId}. Omit it to call /budget/list/all. finished filters the all-wallets call with isFinished.',
      inputSchema: {
        walletId: z.string().min(1).optional(),
        finished: z.boolean().optional().describe('When set, sent as isFinished on /budget/list/all.')
      }
    },
    guard(({ walletId, finished }) => runWithClient(undefined, (client) => client.getBudgets({ walletId, finished })))
  );

  server.registerTool(
    'add_budget',
    {
      title: 'Add Budget',
      description:
        'Create a budget via /budget/add with walletId, categoryId, amount, startDate, endDate, and isRepeat. Accounts tagged user_category_v2 cannot change budgets. dryRun previews the payload.',
      inputSchema: {
        ...walletIdArgument,
        categoryId: z.string().min(1),
        amount: amountArgument,
        startDate: dateArgument,
        endDate: dateArgument,
        isRepeat: z.boolean().optional().describe('Repeat the budget. Default false.'),
        dryRun: dryRunArgument
      }
    },
    guard((params) => runWithClient(undefined, (client) => client.addBudget(params)))
  );

  server.registerTool(
    'edit_budget',
    {
      title: 'Edit Budget',
      description:
        'Update a budget via /budget/edit. The web app sends budgetId, walletId, categoryId, amount, startDate, endDate, and isRepeat. dryRun previews the payload.',
      inputSchema: {
        budgetId: z.string().min(1),
        ...walletIdArgument,
        categoryId: z.string().min(1).optional(),
        amount: amountArgument,
        startDate: dateArgument,
        endDate: dateArgument,
        isRepeat: z.boolean().optional(),
        dryRun: dryRunArgument
      }
    },
    guard((params) => runWithClient(undefined, (client) => client.editBudget(params)))
  );

  server.registerTool(
    'delete_budget',
    {
      title: 'Delete Budget',
      description:
        'Delete a budget via /budget/delete. typeDelete "only" removes this occurrence and "all" removes the repeating series. Requires confirm: true.',
      inputSchema: {
        budgetId: z.string().min(1),
        typeDelete: z.enum(['only', 'all']).optional().describe('only (default) or all for a repeating budget.'),
        confirm: confirmArgument,
        dryRun: dryRunArgument
      }
    },
    guard(async ({ budgetId, typeDelete, confirm, dryRun }) => {
      assertConfirm({ confirm, dryRun, action: 'delete this budget' });
      return runWithClient(undefined, (client) =>
        client.deleteBudget(budgetId, { typeDelete, dryRun: dryRun === true })
      );
    })
  );

  server.registerTool(
    'get_report',
    {
      title: 'Get Report',
      description:
        'Period report via /report/{walletId}. The web app posts startDate and endDate and treats get_report_success as success. Pass walletId "all" for the combined report. The response shape was not checked against a live account.',
      inputSchema: {
        walletId: z.string().min(1).describe('Wallet id, or "all".'),
        startDate: dateArgument,
        endDate: dateArgument,
        walletIds: z.array(z.string().min(1)).optional().describe('Optional wallet id list for a combined report.')
      }
    },
    guard((params) => runWithClient(undefined, (client) => client.getReport(params)))
  );
};

export const createMoneyloverServer = () => {
  const server = new McpServer({
    name: 'money-lover-mcp',
    version: SERVER_VERSION
  });
  registerMoneyloverTools(server);
  return server;
};

export const startMoneyloverServer = async () => {
  const server = createMoneyloverServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return { server, transport };
};

export const __test = {
  hasEnvCredentials,
  fetchEnvToken,
  runWithResolvedToken,
  runWithClient,
  formatError,
  formatSuccess,
  clearEnvTokenCache: () => {
    cachedEnvEmail = '';
    cachedEnvToken = '';
    cachedRefreshToken = '';
    envTokenPromise = null;
    cacheLoaded = false;
    cachedEnvUsesDirectToken = false;
    envFileLoaded = false;
  }
};

const invokedDirectly = () => {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return import.meta.url === pathToFileURL(entry).href;
};

if (invokedDirectly()) {
  startMoneyloverServer().catch((error) => {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error(clip(`Money Lover MCP server failed to start: ${err.message}`));
    process.exitCode = 1;
  });
}
