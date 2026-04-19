import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { MoneyloverClient, MoneyloverApiError } from './moneyloverClient.js';
import { readToken, writeToken, removeToken } from './tokenCache.js';

const DIRECT_TOKEN_ENV_KEYS = ['MONEYLOVER_TOKEN', 'MONEY_LOVER_TOKEN'];
const ENV_FILE_DISABLE_FLAG = 'MONEYLOVER_MCP_DISABLE_ENV_FILE';
const ENV_FILE_PATH_ENV = 'MONEYLOVER_MCP_ENV_FILE';

let envFileLoaded = false;

const normalizeEnvValue = value => {
  if (!value) {
    return '';
  }
  let trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    trimmed = trimmed.slice(1, -1);
  }
  return trimmed
    .replaceAll('\\n', '\n')
    .replaceAll('\\r', '\r')
    .replaceAll('\\t', '\t')
    .replaceAll('\\\\', '\\');
};

const applyEnvFile = raw => {
  if (!raw) {
    return;
  }
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.startsWith('#')) {
      continue;
    }
    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    if (!key || typeof process.env[key] !== 'undefined') {
      continue;
    }
    const value = normalizeEnvValue(line.slice(separatorIndex + 1));
    process.env[key] = value;
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
    console.warn('Failed to resolve module directory for env loading:', error);
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
      const raw = fs.readFileSync(normalized, 'utf8');
      applyEnvFile(raw);
      break;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        console.warn('Failed to load environment file', normalized, error);
      }
    }
  }
};

const getEnvConfig = () => {
  loadEnvFileIfNeeded();
  const email = process.env.EMAIL?.trim() ?? '';
  const password = process.env.PASSWORD?.trim() ?? '';
  const directToken = DIRECT_TOKEN_ENV_KEYS.map(key => process.env[key]?.trim()).find(Boolean) ?? '';
  return { email, password, directToken };
};

let cachedEnvEmail = '';
let cachedEnvToken = '';
let envTokenPromise = null;
let cacheLoaded = false;
let cachedEnvUsesDirectToken = false;

const formatSuccess = data => ({
  content: [
    {
      type: 'text',
      text: JSON.stringify(data, null, 2)
    }
  ],
  structuredContent: data
});

const formatError = error => {
  const base = {
    error: error.name,
    message: error.message
  };
  if (typeof error.code !== 'undefined' && error.code !== null) {
    base.code = error.code;
  }
  if (error.detail) {
    base.detail = error.detail;
  }

  return {
    content: [
      {
        type: 'text',
        text: error.message
      }
    ],
    structuredContent: base,
    isError: true
  };
};

const withClient = async (token, fn) => {
  const client = new MoneyloverClient(token);
  return fn(client);
};

const hasEnvCredentials = () => {
  const { email, password, directToken } = getEnvConfig();
  return Boolean(directToken || (email && password));
};

const fetchEnvToken = async (forceRefresh = false) => {
  const { email, password, directToken } = getEnvConfig();

  if (directToken) {
    cachedEnvUsesDirectToken = true;
    cachedEnvEmail = email;
    cachedEnvToken = directToken;
    envTokenPromise = null;
    cacheLoaded = true;
    return directToken;
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
    envTokenPromise = null;
    cacheLoaded = false;
    try {
      await removeToken(email);
    } catch (error) {
      console.warn('Failed to clear cached Money Lover token:', error);
    }
  }
  if (!cacheLoaded) {
    try {
      const storedToken = await readToken(email);
      if (storedToken) {
        cachedEnvToken = storedToken;
      }
    } catch (error) {
      console.warn('Failed to read cached Money Lover token:', error);
    }
    cacheLoaded = true;
  }
  if (cachedEnvToken) {
    return cachedEnvToken;
  }
  if (!envTokenPromise) {
    envTokenPromise = MoneyloverClient.getToken(email, password)
      .then(async token => {
        try {
          await writeToken(email, token);
        } catch (error) {
          console.warn('Failed to persist Money Lover token:', error);
        }
        cachedEnvToken = token;
        cacheLoaded = true;
        envTokenPromise = null;
        return token;
      })
      .catch(error => {
        envTokenPromise = null;
        throw error;
      });
  }
  return envTokenPromise;
};

const missingTokenError = () =>
  new Error(
    'Token is required. Provide a token parameter or set EMAIL/PASSWORD, MONEYLOVER_TOKEN, or a .env file for automatic authentication.'
  );

const isAuthError = error => {
  if (!(error instanceof MoneyloverApiError)) {
    return false;
  }
  if (typeof error.code === 'number' && (error.code === 1 || error.code === 401)) {
    return true;
  }
  const message = error.message?.toLowerCase?.() ?? '';
  return message.includes('unauth') || message.includes('token');
};

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
    if (usedEnvToken && isAuthError(error)) {
      const refreshedToken = await fetchEnvToken(true);
      if (!refreshedToken) {
        throw error;
      }
      return fn(refreshedToken);
    }
    throw error;
  }
};

const runWithClient = (token, fn) => runWithResolvedToken(token, resolvedToken => withClient(resolvedToken, fn));

const registerMoneyloverTools = server => {
  const TOKEN_PLACEHOLDERS = new Set([
    'string',
    'your_token',
    'your_token_here',
    'your_jwt_token',
    'jwt_token',
    'token',
    'null',
    'undefined',
    'none',
    '/',
    '-'
  ]);

  const looksLikePlaceholder = value => {
    const lower = value.toLowerCase();
    if (TOKEN_PLACEHOLDERS.has(lower)) return true;
    // Real JWTs have the form xxx.yyy.zzz and are much longer than 20 chars
    if (!value.includes('.') && value.length < 20) return true;
    return false;
  };

  const tokenSchema = z.preprocess(value => {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed === '' || looksLikePlaceholder(trimmed)) {
        return undefined;
      }
      return trimmed;
    }
    return value;
  }, z.string().min(1).optional());

  server.registerTool(
    'login',
    {
      title: 'Login to Money Lover',
      description: 'Authenticate using Money Lover credentials to retrieve a JWT token.',
      inputSchema: {
        email: z.string().email().describe('Money Lover account email'),
        password: z.string().min(1).describe('Money Lover account password')
      },
      outputSchema: {
        token: z.string()
      }
    },
    async ({ email, password }) => {
      try {
        const token = await MoneyloverClient.getToken(email, password);
        try {
          await writeToken(email, token);
        } catch (error) {
          console.warn('Failed to persist Money Lover token:', error);
        }
        const { email: envEmail } = getEnvConfig();
        if (email === envEmail && envEmail) {
          cachedEnvEmail = envEmail;
          cachedEnvToken = token;
          cacheLoaded = true;
          cachedEnvUsesDirectToken = false;
        }
        return formatSuccess({ token });
      } catch (error) {
        return formatError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  );

  const tokenArgument = {};

  server.registerTool(
    'get_user_info',
    {
      title: 'Get User Info',
      description: 'Retrieve the Money Lover user profile associated with the provided token.',
      inputSchema: tokenArgument
    },
    async ({ token }) => {
      try {
        const data = await runWithClient(token, client => client.getUserInfo());
        return formatSuccess(data ?? {});
      } catch (error) {
        return formatError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  );

  server.registerTool(
    'get_wallets',
    {
      title: 'Get Wallets',
      description: 'List all wallets accessible to the authenticated user.',
      inputSchema: tokenArgument,
      outputSchema: {
        wallets: z.array(z.record(z.any()))
      }
    },
    async ({ token }) => {
      try {
        const wallets = (await runWithClient(token, client => client.getWallets())) ?? [];
        return formatSuccess({ wallets });
      } catch (error) {
        return formatError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  );

  server.registerTool(
    'get_categories',
    {
      title: 'Get Categories',
      description: 'Retrieve categories for a specific wallet.',
      inputSchema: {
        ...tokenArgument,
        walletId: z.string().min(1).describe('Wallet identifier')
      },
      outputSchema: {
        categories: z.array(z.record(z.any()))
      }
    },
    async ({ token, walletId }) => {
      try {
        const data = (await runWithClient(token, client => client.getCategories(walletId))) ?? [];
        return formatSuccess({ categories: data });
      } catch (error) {
        return formatError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  );

  server.registerTool(
    'get_transactions',
    {
      title: 'Get Transactions',
      description: 'Fetch transactions for a wallet between two dates.',
      inputSchema: {
        ...tokenArgument,
        walletId: z.string().min(1).describe('Wallet identifier'),
        startDate: z
          .string()
          .regex(/\d{4}-\d{2}-\d{2}/)
          .describe('Start date in YYYY-MM-DD format'),
        endDate: z
          .string()
          .regex(/\d{4}-\d{2}-\d{2}/)
          .describe('End date in YYYY-MM-DD format')
      }
    },
    async ({ token, walletId, startDate, endDate }) => {
      try {
        const data = await runWithClient(token, client => client.getTransactions(walletId, startDate, endDate));
        return formatSuccess(data ?? {});
      } catch (error) {
        return formatError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  );

  server.registerTool(
    'add_transaction',
    {
      title: 'Add Transaction',
      description: 'Create a new transaction in a wallet.',
      inputSchema: {
        ...tokenArgument,
        walletId: z.string().min(1).describe('Wallet identifier'),
        categoryId: z.string().min(1).describe('Category identifier'),
        amount: z.string().min(1).describe('Transaction amount as string'),
        note: z.string().optional().describe('Optional transaction note'),
        date: z
          .string()
          .regex(/\d{4}-\d{2}-\d{2}/)
          .describe('Display date in YYYY-MM-DD format'),
        with: z
          .array(z.string())
          .optional()
          .describe('Optional array of related parties')
      }
    },
    async ({ token, ...payload }) => {
      try {
        const data = await runWithClient(token, client =>
          client.addTransaction({
            walletId: payload.walletId,
            categoryId: payload.categoryId,
            amount: payload.amount,
            note: payload.note,
            date: payload.date,
            with: payload.with
          })
        );
        return formatSuccess(data ?? {});
      } catch (error) {
        return formatError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  );

  // ===== Additional read tools =====

  const walletIdArgument = {
    walletId: z.string().min(1).describe('Wallet identifier')
  };

  server.registerTool(
    'get_user_account',
    {
      title: 'Get User Account',
      description: 'List devices and sessions tied to the Money Lover account.',
      inputSchema: tokenArgument
    },
    async ({ token }) => {
      try {
        const data = (await runWithClient(token, client => client.getUserAccount())) ?? [];
        return formatSuccess({ devices: data });
      } catch (error) {
        return formatError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  );

  server.registerTool(
    'get_user_profile',
    {
      title: 'Get User Profile',
      description: 'Retrieve extended profile information for the current user.',
      inputSchema: tokenArgument
    },
    async ({ token }) => {
      try {
        const data = await runWithClient(token, client => client.getUserProfile());
        return formatSuccess(data ?? {});
      } catch (error) {
        return formatError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  );

  server.registerTool(
    'get_wallet_balance',
    {
      title: 'Get Wallet Balance',
      description: 'Fetch the current balance summary for a specific wallet.',
      inputSchema: { ...tokenArgument, ...walletIdArgument }
    },
    async ({ token, walletId }) => {
      try {
        const data = await runWithClient(token, client => client.getWalletBalance(walletId));
        return formatSuccess(data ?? {});
      } catch (error) {
        return formatError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  );

  server.registerTool(
    'get_shared_wallets',
    {
      title: 'Get Shared Wallets',
      description: 'List wallets the authenticated user shares with others.',
      inputSchema: tokenArgument
    },
    async ({ token }) => {
      try {
        const data = (await runWithClient(token, client => client.getSharedWallets())) ?? [];
        return formatSuccess({ wallets: data });
      } catch (error) {
        return formatError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  );

  server.registerTool(
    'get_awaiting_shared_wallets',
    {
      title: 'Get Awaiting Shared Wallets',
      description: 'List wallet share invitations pending acceptance.',
      inputSchema: tokenArgument
    },
    async ({ token }) => {
      try {
        const data = (await runWithClient(token, client => client.getAwaitingSharedWallets())) ?? [];
        return formatSuccess({ invitations: data });
      } catch (error) {
        return formatError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  );

  server.registerTool(
    'get_all_categories',
    {
      title: 'Get All Categories',
      description: 'List ALL categories across ALL wallets with no wallet filter. Use this instead of get_categories when no specific wallet is provided.',
      inputSchema: {
        limit: z.number().int().min(1).max(500).optional().describe('Maximum categories to return (default 50)')
      }
    },
    async ({ limit = 50 }) => {
      try {
        const all = (await runWithClient(undefined, client => client.getAllCategories())) ?? [];
        const categories = all.slice(0, limit);
        return formatSuccess({ categories, total: all.length, returned: categories.length });
      } catch (error) {
        return formatError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  );

  server.registerTool(
    'get_transaction_search_config',
    {
      title: 'Get Transaction Search Config',
      description: 'Return the saved configuration options (labels, with-parties, saved filters) available for use with the search_transactions tool.',
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional().describe('Maximum config entries to return (default 20)')
      }
    },
    async ({ limit = 20 }) => {
      try {
        const raw = (await runWithClient(undefined, client => client.getTransactionSearchConfig())) ?? {};
        const entries = Array.isArray(raw) ? raw : Object.values(raw);
        const config = entries.slice(0, limit);
        return formatSuccess({ config, total: entries.length, returned: config.length });
      } catch (error) {
        return formatError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  );

  server.registerTool(
    'search_transactions',
    {
      title: 'Search Transactions',
      description: 'Free-form search across transactions using optional filters (walletId, categoryId, keyword, parties). Use this when no date range is given or when doing a keyword/label search instead of a date-range fetch.',
      inputSchema: {
        filters: z
          .record(z.any())
          .optional()
          .describe('Arbitrary filter object forwarded to /transaction/search (e.g. walletId, categoryId, dates, with)'),
        limit: z.number().int().min(1).max(200).optional().describe('Max results to return (default 20)')
      }
    },
    async ({ filters, limit = 20 }) => {
      try {
        const raw = await runWithClient(undefined, client => client.searchTransactions(filters ?? {}));
        const arr = Array.isArray(raw) ? raw : (raw?.transactions ?? []);
        const data = arr.slice(0, limit);
        return formatSuccess({ transactions: data, total: arr.length, returned: data.length });
      } catch (error) {
        return formatError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  );

  server.registerTool(
    'get_debt_transactions',
    {
      title: 'Get Debt Transactions',
      description: 'List transactions flagged as debts or loans across the account.',
      inputSchema: tokenArgument
    },
    async ({ token }) => {
      try {
        const data = (await runWithClient(token, client => client.getDebtTransactions())) ?? [];
        return formatSuccess({ transactions: data });
      } catch (error) {
        return formatError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  );

  server.registerTool(
    'get_related_transactions',
    {
      title: 'Get Related Transactions',
      description: 'Given one or more transaction IDs, fetch their related/linked transactions. Pass IDs as an array of strings.',
      inputSchema: {
        ...tokenArgument,
        ids: z
          .array(z.string().min(1))
          .min(1)
          .describe('One or more transaction identifiers to resolve relationships for')
      }
    },
    async ({ token, ids }) => {
      try {
        const data = await runWithClient(token, client => client.getRelatedTransactions(ids));
        return formatSuccess({ transactions: Array.isArray(data) ? data : [] });
      } catch (error) {
        return formatError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  );

  server.registerTool(
    'get_related_transactions_by_category',
    {
      title: 'Get Related Transactions By Category',
      description: 'List transactions linked to a category across wallets.',
      inputSchema: {
        ...tokenArgument,
        categoryId: z.string().min(1).describe('Category identifier')
      }
    },
    async ({ token, categoryId }) => {
      try {
        const data = await runWithClient(token, client => client.getRelatedTransactionsByCategory(categoryId));
        return formatSuccess(data ?? {});
      } catch (error) {
        return formatError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  );

  server.registerTool(
    'get_related_transactions_by_wallet',
    {
      title: 'Get Related Transactions By Wallet',
      description: 'List transactions linked to a wallet, grouped by relationship.',
      inputSchema: { ...tokenArgument, ...walletIdArgument }
    },
    async ({ token, walletId }) => {
      try {
        const data = await runWithClient(token, client => client.getRelatedTransactionsByWallet(walletId));
        return formatSuccess(data ?? {});
      } catch (error) {
        return formatError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  );


  server.registerTool(
    'get_events',
    {
      title: 'Get Events',
      description: 'List Money Lover events (savings goals, campaigns) associated with a wallet.',
      inputSchema: {
        ...walletIdArgument,
        limit: z.number().int().min(1).max(200).optional().describe('Maximum number of events to return (default 50)')
      }
    },
    async ({ walletId, limit = 50 }) => {
      try {
        const all = (await runWithClient(undefined, client => client.getEvents(walletId))) ?? [];
        const events = all.slice(0, limit);
        return formatSuccess({ events, total: all.length, returned: events.length });
      } catch (error) {
        return formatError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  );

  server.registerTool(
    'get_debts',
    {
      title: 'Get Debts',
      description: 'List open debts or loans tracked in a specific wallet.',
      inputSchema: { ...tokenArgument, ...walletIdArgument }
    },
    async ({ token, walletId }) => {
      try {
        const data = (await runWithClient(token, client => client.getDebts(walletId))) ?? [];
        return formatSuccess({ debts: data });
      } catch (error) {
        return formatError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  );

  server.registerTool(
    'get_icons',
    {
      title: 'Get Icons',
      description: 'Fetch the icon pack used by Money Lover categories, wallets, and events.',
      inputSchema: {
        ...tokenArgument,
        pack: z
          .string()
          .min(1)
          .optional()
          .describe('Icon pack identifier (defaults to "default")')
      }
    },
    async ({ token, pack }) => {
      try {
        const data = await runWithClient(token, client => client.getIcons(pack ?? 'default'));
        return formatSuccess(data ?? {});
      } catch (error) {
        return formatError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  );

  server.registerTool(
    'get_linked_providers',
    {
      title: 'Get Linked Providers',
      description: 'List financial institution providers supported for linked accounts.',
      inputSchema: tokenArgument
    },
    async ({ token }) => {
      try {
        const data = (await runWithClient(token, client => client.getLinkedProviders())) ?? [];
        return formatSuccess({ providers: data });
      } catch (error) {
        return formatError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  );

  server.registerTool(
    'get_currencies',
    {
      title: 'Get Currencies',
      description: 'List all currencies supported by Money Lover (names, symbols, codes). Use this for currency metadata, not exchange rates.',
      inputSchema: {
        limit: z.number().int().min(1).max(1000).optional().describe('Max currencies to return (default 100)')
      }
    },
    async ({ limit = 100 }) => {
      try {
        const raw = await runWithClient(undefined, client => client.getCurrencies());
        const arr = (Array.isArray(raw) ? raw : Object.values(raw ?? {}).flat()).flat();
        const currencies = arr.slice(0, limit);
        return formatSuccess({ currencies, total: arr.length, returned: currencies.length });
      } catch (error) {
        return formatError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  );

  server.registerTool(
    'get_exchange_rates',
    {
      title: 'Get Exchange Rates',
      description: 'Fetch the USD-based exchange rate snapshot used by Money Lover.',
      inputSchema: tokenArgument
    },
    async ({ token }) => {
      try {
        const data = await runWithClient(token, client => client.getExchangeRates());
        return formatSuccess(data ?? {});
      } catch (error) {
        return formatError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  );

  server.registerTool(
    'get_other_config',
    {
      title: 'Get Other Config',
      description: 'Retrieve the small static configuration blob served under /other/config.',
      inputSchema: tokenArgument
    },
    async ({ token }) => {
      try {
        const data = await runWithClient(token, client => client.getOtherConfig());
        return formatSuccess(data ?? {});
      } catch (error) {
        return formatError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  );
  // ===== Mutation tools =====

  const dateArgument = z
    .string()
    .regex(/\d{4}-\d{2}-\d{2}/)
    .describe('Date in YYYY-MM-DD format');

  server.registerTool(
    'edit_transaction',
    {
      title: 'Edit Transaction',
      description:
        'Update an existing transaction. The API requires the full transaction payload on every edit, so you must supply walletId, categoryId, amount, and date (fetch the transaction with get_transactions first if you need the current values). categoryId should be the global category ID from get_all_categories or from an existing transaction response.',
      inputSchema: {
        transactionId: z.string().min(1).describe('Transaction identifier'),
        walletId: z.string().min(1).describe('Wallet identifier (required by API)'),
        categoryId: z.string().min(1).describe('Category identifier — use global ID from get_all_categories or an existing transaction'),
        amount: z.string().min(1).describe('Transaction amount as string'),
        date: dateArgument,
        note: z.string().optional().describe('Transaction note'),
        with: z.array(z.string()).optional().describe('Related parties')
      }
    },
    async ({ transactionId, ...params }) => {
      try {
        const data = await runWithClient(undefined, client => client.editTransaction(transactionId, params));
        return formatSuccess(data ?? {});
      } catch (error) {
        return formatError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  );

  server.registerTool(
    'delete_transaction',
    {
      title: 'Delete Transaction',
      description: 'Permanently delete a transaction by its identifier.',
      inputSchema: {
        transactionId: z.string().min(1).describe('Transaction identifier to delete')
      }
    },
    async ({ transactionId }) => {
      try {
        const data = await runWithClient(undefined, client => client.deleteTransaction(transactionId));
        return formatSuccess(data ?? {});
      } catch (error) {
        return formatError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  );

  server.registerTool(
    'add_wallet',
    {
      title: 'Add Wallet',
      description: 'Create a new Money Lover wallet.',
      inputSchema: {
        name: z.string().min(1).describe('Wallet display name'),
        currencyId: z.number().int().positive().describe('Currency identifier (see get_currencies)'),
        icon: z.string().optional().describe('Icon name (defaults to icon_7)')
      }
    },
    async ({ name, currencyId, icon }) => {
      try {
        const data = await runWithClient(undefined, client => client.addWallet({ name, currencyId, icon }));
        return formatSuccess(data ?? {});
      } catch (error) {
        return formatError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  );

  server.registerTool(
    'edit_wallet',
    {
      title: 'Edit Wallet',
      description: 'Update a wallet name, icon, or currency.',
      inputSchema: {
        walletId: z.string().min(1).describe('Wallet identifier'),
        currencyId: z.number().int().positive().describe('Currency identifier (required by API — use get_currencies for valid IDs, e.g. 30 for COP)'),
        name: z.string().min(1).optional().describe('New display name'),
        icon: z.string().optional().describe('New icon name')
      }
    },
    async ({ walletId, ...params }) => {
      try {
        const data = await runWithClient(undefined, client => client.editWallet(walletId, params));
        return formatSuccess(data ?? {});
      } catch (error) {
        return formatError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  );

  server.registerTool(
    'delete_wallet',
    {
      title: 'Delete Wallet',
      description: 'Permanently delete a wallet and all its data.',
      inputSchema: {
        walletId: z.string().min(1).describe('Wallet identifier to delete')
      }
    },
    async ({ walletId }) => {
      try {
        const data = await runWithClient(undefined, client => client.deleteWallet(walletId));
        return formatSuccess(data ?? {});
      } catch (error) {
        return formatError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  );

  server.registerTool(
    'add_category',
    {
      title: 'Add Category',
      description: 'Create a new transaction category in a wallet.',
      inputSchema: {
        walletId: z.string().min(1).describe('Wallet to create the category in'),
        name: z.string().min(1).describe('Category name'),
        icon: z.string().min(1).describe('Icon identifier (see get_icons)'),
        type: z.number().int().min(1).max(2).describe('1 = expense, 2 = income')
      }
    },
    async ({ walletId, name, icon, type }) => {
      try {
        const data = await runWithClient(undefined, client => client.addCategory({ walletId, name, icon, type }));
        return formatSuccess(data ?? {});
      } catch (error) {
        return formatError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  );

  server.registerTool(
    'edit_category',
    {
      title: 'Edit Category',
      description: 'Rename a category or update its icon.',
      inputSchema: {
        categoryId: z.string().min(1).describe('Category identifier'),
        icon: z.string().min(1).describe('Icon identifier (required by API even when only renaming — use get_icons for valid names, e.g. icon_3)'),
        name: z.string().min(1).optional().describe('New category name')
      }
    },
    async ({ categoryId, ...params }) => {
      try {
        const data = await runWithClient(undefined, client => client.editCategory(categoryId, params));
        return formatSuccess(data ?? {});
      } catch (error) {
        return formatError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  );

  server.registerTool(
    'delete_category',
    {
      title: 'Delete Category',
      description: 'Permanently delete a category.',
      inputSchema: {
        categoryId: z.string().min(1).describe('Category identifier to delete')
      }
    },
    async ({ categoryId }) => {
      try {
        const data = await runWithClient(undefined, client => client.deleteCategory(categoryId));
        return formatSuccess(data ?? {});
      } catch (error) {
        return formatError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  );




};

export const createMoneyloverServer = () => {
  const server = new McpServer({
    name: 'moneylover-mcp-server',
    version: '0.0.3'
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
  clearEnvTokenCache: () => {
    cachedEnvEmail = '';
    cachedEnvToken = '';
    envTokenPromise = null;
    cacheLoaded = false;
    cachedEnvUsesDirectToken = false;
    envFileLoaded = false;
  }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  startMoneyloverServer().catch(error => {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error('Money Lover MCP server failed to start:', err.message);
    if (err instanceof MoneyloverApiError && err.detail) {
      console.error('Detail:', JSON.stringify(err.detail));
    }
    process.exitCode = 1;
  });
}
