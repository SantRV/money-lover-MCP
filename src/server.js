import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { MoneyloverClient } from './moneyloverClient.js';
import { isAuthError } from './authError.js';
import { readToken, removeToken, writeToken } from './tokenCache.js';
import { clip, redact } from './redact.js';
import { pageItems } from './paging.js';
import { summarizeCategory, unwrapList } from './categories.js';
import { rowsFromBankCsv } from './csv.js';
import { createTransactions } from './transactions.js';
import { assertConfirm } from './safety.js';

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
let envTokenPromise = null;
let cacheLoaded = false;
let cachedEnvUsesDirectToken = false;

const formatSuccess = (data) => {
  const safe = redact(data ?? {});
  const structured = safe && typeof safe === 'object' ? safe : { result: safe };
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(structured, null, 2)
      }
    ],
    structuredContent: structured
  };
};

const formatError = (error) => {
  const message = clip(error?.message || 'Unknown error', 1000);
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
  return {
    content: [{ type: 'text', text: message }],
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

const withClient = async (token, fn) => fn(new MoneyloverClient(token, clientOptions()));

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
    } catch (error) {
      warn('Failed to read cached Money Lover token', error);
    }
    cacheLoaded = true;
  }

  if (cachedEnvToken) {
    return cachedEnvToken;
  }

  if (!envTokenPromise) {
    envTokenPromise = MoneyloverClient.getToken(email, password)
      .then(async (token) => {
        try {
          await writeToken(email, token);
        } catch (error) {
          warn('Failed to persist Money Lover token', error);
        }
        cachedEnvToken = token;
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
    if (usedEnvToken && isAuthError(error)) {
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

const rememberLogin = (email, token) => {
  const { email: envEmail } = getEnvConfig();
  if (email === envEmail && envEmail) {
    cachedEnvEmail = envEmail;
    cachedEnvToken = token;
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
  .describe('Must be true to delete. Pass dryRun: true to preview without confirm.');

const walletIdArgument = {
  walletId: z.string().min(1).describe('Wallet identifier')
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
      const token = await MoneyloverClient.getToken(email, password);
      let cached = true;
      try {
        await writeToken(email, token);
      } catch (error) {
        cached = false;
        warn('Failed to persist Money Lover token', error);
      }
      rememberLogin(email, token);
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
        'Categories for one wallet, including type (1 income, 2 expense) and typeName. Prefer list_categories when choosing a category for an import.',
      inputSchema: walletIdArgument,
      outputSchema: {
        categories: z.array(z.record(z.any()))
      }
    },
    guard(async ({ walletId }) => {
      const data = (await runWithClient(undefined, (client) => client.getCategories(walletId))) ?? [];
      const categories = unwrapList(data).map((category) => ({
        ...category,
        typeName: summarizeCategory(category).typeName
      }));
      return { categories };
    })
  );

  server.registerTool(
    'list_categories',
    {
      title: 'List Categories',
      description:
        'Compact category list for one wallet, grouped into income (type 1) and expense (type 2). Use this to map a bank statement payee to a category id or name before add_transactions.',
      inputSchema: walletIdArgument
    },
    guard(async ({ walletId }) => {
      const categories = await runWithClient(undefined, (client) => client.listWalletCategories(walletId));
      const project = (category) => ({
        id: category.id,
        name: category.name,
        type: category.type,
        typeName: category.typeName
      });
      return {
        walletId,
        categories,
        income: categories.filter((category) => category.typeName === 'income').map(project),
        expense: categories.filter((category) => category.typeName === 'expense').map(project)
      };
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
        'Create one transaction. Amount is sent as a positive magnitude; pick an income category (type 1) or expense category (type 2). categoryId may be a wallet id or a global id, and category may be a name. date YYYY-MM-DD is not timezone-shifted. Set dryRun to preview. Set skipDuplicates to skip an existing transaction with the same wallet, date, absolute amount, and similar note.',
      inputSchema: {
        ...walletIdArgument,
        categoryId: z.string().min(1).optional().describe('Category id from list_categories or get_categories'),
        category: z.string().min(1).optional().describe('Category name, used when categoryId is omitted'),
        amount: amountArgument,
        note: z.string().optional().describe('Payee or note'),
        date: dateArgument,
        with: z.array(z.string()).optional().describe('Related people. Omit for none.'),
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
        throw new Error(row.message);
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
        'Import a batch of transactions (max 200). Each row needs date, amount, note, and category or categoryId. Returns one result per row (created, skipped_duplicate, dry_run, or error) and continues after a row fails. Duplicates are the same wallet, calendar date, absolute amount, and similar note. skipDuplicates defaults to true. Use dryRun to preview. Amounts are stored as positive magnitudes; category type selects income or expense.',
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
              with: z.array(z.string()).optional()
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
          .describe('magnitude (default) or signed. See add_transaction.')
      }
    },
    guard(async ({ walletId, transactions, skipDuplicates, dryRun, amountMode }) =>
      runWithClient(undefined, (client) =>
        createTransactions(client, {
          walletId,
          transactions,
          skipDuplicates,
          dryRun,
          amountMode
        })
      )
    )
  );

  server.registerTool(
    'import_transactions_csv',
    {
      title: 'Import Transactions CSV',
      description:
        'Parse a bank CSV and import it. Accepts a header row plus Date, Amount and/or Debit and Credit, and Description/Narrative/Payee. Australian dates (DD/MM/YYYY) are the default when the order is ambiguous. Debits and negative amounts are expenses; credits and positive amounts are income. Pass expenseCategory and incomeCategory (name or id), a defaultCategory, or a category column. Without a category the tool returns the parsed rows and does not write. skipDuplicates defaults to true. dryRun previews the Money Lover payload. Never put the CSV in git.',
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
        amountMode: z.enum(['magnitude', 'signed']).optional()
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
        amountMode
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
            amountMode: mode
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
        'Categories across the user wallets, with typeName. Prefer list_categories for a single wallet. The response is paged and, when category records include an account id, limited to wallets this user can see. total and truncated say whether the page is complete.',
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
        'Search transactions. Pass filters such as walletId, categoryId, or a keyword if the API accepts it. displayDate values are normalized to YYYY-MM-DD. The page reports total and truncated. Default limit is 50.',
      inputSchema: {
        filters: z.record(z.any()).optional().describe('Filter object forwarded to /transaction/search'),
        limit: z.number().int().min(1).max(500).optional().describe('Page size. Default 50.'),
        offset: z.number().int().min(0).optional()
      }
    },
    guard(async ({ filters, limit = 50, offset = 0 }) =>
      runWithClient(undefined, async (client) => {
        const raw = await client.searchTransactions(filters ?? {});
        const presented = presentTransactions(client, raw);
        const page = pageItems(presented.transactions, { limit, offset, maxLimit: 500 });
        const total = presented.reportedTotal ?? page.total;
        return {
          transactions: page.items,
          total,
          returned: page.returned,
          truncated: page.truncated || total > page.offset + page.returned,
          offset: page.offset,
          nextOffset: page.truncated ? page.offset + page.returned : null
        };
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
        'Replace a transaction. Money Lover requires the full payload on every edit: walletId, categoryId, amount, date, note, and with. Omitted note or with is rejected so an edit cannot silently clear them. Fetch the current transaction first and pass every field back, changing only what you intend to change. dryRun previews the payload.',
      inputSchema: {
        transactionId: z.string().min(1).describe('Transaction identifier'),
        walletId: z.string().min(1).describe('Wallet identifier'),
        categoryId: z.string().min(1).describe('Category id. Wallet ids are resolved to the global id when possible.'),
        amount: amountArgument,
        date: dateArgument,
        note: z.string().describe('Note to store. Pass an empty string to clear it.'),
        with: z.array(z.string()).describe('Related parties. Pass an empty array to clear them.'),
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
        'Permanently delete a transaction. Requires confirm: true. Pass dryRun: true to preview without deleting.',
      inputSchema: {
        transactionId: z.string().min(1).describe('Transaction identifier'),
        confirm: confirmArgument,
        dryRun: dryRunArgument
      }
    },
    guard(async ({ transactionId, confirm, dryRun }) => {
      assertConfirm({ confirm, dryRun, action: 'delete this transaction' });
      return runWithClient(undefined, (client) => client.deleteTransaction(transactionId, { dryRun: dryRun === true }));
    })
  );

  server.registerTool(
    'add_wallet',
    {
      title: 'Add Wallet',
      description: 'Create a wallet. currencyId comes from get_currencies. dryRun previews the payload.',
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
        'Update a wallet. currencyId is required by the API even when you only rename the wallet. Pass the current currency id to keep it. dryRun previews the payload.',
      inputSchema: {
        walletId: z.string().min(1),
        currencyId: z.number().int().positive().describe('Currency id, required even when unchanged'),
        name: z.string().min(1).optional(),
        icon: z.string().optional(),
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
        'Create a category. type 1 is income and type 2 is expense. icon comes from get_icons (for example icon_3). dryRun previews the payload.',
      inputSchema: {
        walletId: z.string().min(1),
        name: z.string().min(1),
        icon: z.string().min(1).describe('Icon name from get_icons'),
        type: z.number().int().min(1).max(2).describe('1 = income, 2 = expense'),
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
