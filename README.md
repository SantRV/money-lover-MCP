# Money Lover MCP Server

Stdio [MCP](https://modelcontextprotocol.io) server for the **unofficial** Money Lover web API (`web.moneylover.me`). It lets an assistant list wallets and categories, then import bank-statement transactions with stable calendar dates and income/expense categories.

This repository is [SantRV/money-lover-MCP](https://github.com/SantRV/money-lover-MCP). It is a fork of [juansebashr/moneylover-mcp](https://github.com/juansebashr/moneylover-mcp), which extends [ferdhika31/moneylover-mcp](https://github.com/ferdhika31/moneylover-mcp). The licence is ISC. Copyright for the original work remains with Ferdhika Yudira; see [LICENSE.md](LICENSE.md).

Money Lover does not publish this API. It can change or reject requests without notice. Do not rely on it for anything you cannot check in the Money Lover app afterwards.

The package is **not published to npm**. Run it from this git repository.

## Setup

Node.js 22 or newer.

```bash
npm install
npm test
npm start
```

From another machine, without cloning:

```bash
npx -y github:SantRV/money-lover-MCP
```

Or, after cloning:

```bash
node src/cli.js
```

### Cursor / Claude Desktop

Prefer environment variables over a `.env` file. `.env` and `.mcp.json` are gitignored. The checked-in [`.mcp.json.example`](.mcp.json.example) and [`.env.example`](.env.example) contain placeholders only. Do not commit real passwords or tokens.

```json
{
  "mcpServers": {
    "money-lover": {
      "command": "npx",
      "args": ["-y", "github:SantRV/money-lover-MCP"],
      "env": {
        "MONEYLOVER_EMAIL": "you@example.com",
        "MONEYLOVER_PASSWORD": "your-password",
        "MONEYLOVER_TIMEZONE": "Australia/Adelaide"
      }
    }
  }
}
```

A local checkout:

```json
{
  "mcpServers": {
    "money-lover": {
      "command": "node",
      "args": ["/absolute/path/to/money-lover-MCP/src/cli.js"],
      "env": {
        "MONEYLOVER_EMAIL": "you@example.com",
        "MONEYLOVER_PASSWORD": "your-password",
        "MONEYLOVER_TIMEZONE": "Australia/Adelaide"
      }
    }
  }
}
```

`EMAIL` and `PASSWORD` still work if the `MONEYLOVER_` names are unset. `MONEYLOVER_TOKEN` uses an existing JWT and does not log in again. If that token is rejected and no email/password is set, the server stops instead of retrying the same token.

Optional: `MONEYLOVER_MCP_ENV_FILE` points at a dotenv file. `MONEYLOVER_MCP_DISABLE_ENV_FILE=1` skips dotenv loading. `MONEYLOVER_TIMEOUT_MS` is the per-request timeout (default 30000). `MONEYLOVER_TOKEN_CACHE_DIR` moves the token cache.

## Dates, amounts, and categories

- Send dates as `YYYY-MM-DD`. That form is a calendar date and is **not** converted through UTC, so an Adelaide date does not become the previous day.
- Timestamps are formatted in `MONEYLOVER_TIMEZONE` (default `Australia/Adelaide`). A value the API returns as UTC midnight, such as `2026-04-18T00:00:00.000Z`, stays `2026-04-18`.
- Category type `1` is **income** and type `2` is **expense**. This matches the Go client and the Money Lover CLI. `list_categories` returns `typeName` so a statement can be mapped without guessing.
- Money Lover stores a **positive** amount. The category type decides income versus expense. A leading minus is accepted on an expense category (typical bank debit) and rejected on an income category, so a negative salary is not filed as income.
- `edit_transaction` is a full replace. `note` and `with` are required. Pass the current values back, or `""` / `[]` when you mean to clear them.
- Wallet category ids are resolved to the global id when the name and metadata match. If they do not, the original id is sent and the result includes a warning.

## Safety

- `delete_transaction`, `delete_wallet`, and `delete_category` do nothing unless `confirm` is `true`.
- Write tools accept `dryRun: true`. They validate and return the payload without posting it.
- `add_transactions` and `import_transactions_csv` default to skipping duplicates: same wallet, same calendar date, same absolute amount, and a similar note (case and punctuation ignored; a note of 8+ characters may match when one contains the other). Blank notes match other blank notes.
- Each import row returns its own status (`created`, `skipped_duplicate`, `dry_run`, or `error`). One bad row does not roll back rows that already succeeded. Run again with `skipDuplicates: true` after a partial import.
- Batches are limited to 200 rows.

## Tools

Authentication is read from the environment. Tools do not take a token argument, and `login` does not return the JWT.

| Tool                                   | What it does                                                                                                                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `login`                                | Cache a session for an email and password. Does not return the token.                                                                                                                       |
| `get_user_info`                        | Profile for the current session.                                                                                                                                                            |
| `get_user_account`                     | Devices and sessions.                                                                                                                                                                       |
| `get_user_profile`                     | Extended profile.                                                                                                                                                                           |
| `get_wallets`                          | Wallets. Use `_id` as `walletId`.                                                                                                                                                           |
| `get_wallet_balance`                   | Balance for one wallet.                                                                                                                                                                     |
| `get_shared_wallets`                   | Wallets shared with other people.                                                                                                                                                           |
| `get_awaiting_shared_wallets`          | Pending share invitations.                                                                                                                                                                  |
| `add_wallet`                           | Create a wallet. `currencyId` from `get_currencies`. Optional `dryRun`.                                                                                                                     |
| `edit_wallet`                          | Update a wallet. `currencyId` is required even when only the name changes.                                                                                                                  |
| `delete_wallet`                        | Delete a wallet. Requires `confirm: true`.                                                                                                                                                  |
| `get_categories`                       | Categories for one wallet, with `typeName`.                                                                                                                                                 |
| `list_categories`                      | Compact income and expense lists for mapping a statement.                                                                                                                                   |
| `get_all_categories`                   | Categories across your wallets, paged. Records tied to another wallet id are left out.                                                                                                      |
| `add_category`                         | Create a category. `type` 1 income, 2 expense.                                                                                                                                              |
| `edit_category`                        | Rename a category. `icon` is required even when unchanged.                                                                                                                                  |
| `delete_category`                      | Delete a category. Requires `confirm: true`.                                                                                                                                                |
| `get_transactions`                     | Transactions between two dates. `displayDate` is `YYYY-MM-DD`. Default page size 500. `truncated` and `nextOffset` say when to continue.                                                    |
| `add_transaction`                      | Create one transaction. Optional `dryRun` and `skipDuplicates`.                                                                                                                             |
| `add_transactions`                     | Create up to 200 transactions. Per-row results. `skipDuplicates` defaults to true.                                                                                                          |
| `import_transactions_csv`              | Parse a bank CSV (date, amount and/or debit/credit, description). Australian `DD/MM/YYYY` when the order is ambiguous. Returns parsed rows instead of writing when no category is supplied. |
| `edit_transaction`                     | Full replace. Requires `note` and `with`.                                                                                                                                                   |
| `delete_transaction`                   | Delete one transaction. Requires `confirm: true`.                                                                                                                                           |
| `search_transactions`                  | Search. Paged, with `truncated`.                                                                                                                                                            |
| `get_transaction_search_config`        | Search filter metadata.                                                                                                                                                                     |
| `get_debt_transactions`                | Transactions flagged as debts.                                                                                                                                                              |
| `get_related_transactions`             | Related transactions for a list of ids.                                                                                                                                                     |
| `get_related_transactions_by_category` | Related transactions for a category.                                                                                                                                                        |
| `get_related_transactions_by_wallet`   | Related transactions for a wallet.                                                                                                                                                          |
| `get_events`                           | Savings goals / campaigns for a wallet.                                                                                                                                                     |
| `get_debts`                            | Open debts in a wallet.                                                                                                                                                                     |
| `get_icons`                            | Icon pack. Names look like `icon_3`.                                                                                                                                                        |
| `get_linked_providers`                 | Institutions Money Lover can link. This server does not start a bank link.                                                                                                                  |
| `get_currencies`                       | Currency catalogue.                                                                                                                                                                         |
| `get_exchange_rates`                   | Exchange-rate snapshot.                                                                                                                                                                     |
| `get_other_config`                     | Static `/other/config` payload.                                                                                                                                                             |

Prompt-sized examples for the original tools are in [docs/examples.md](docs/examples.md).

### Import a statement

1. `get_wallets` and choose `walletId`.
2. `list_categories` and note income versus expense names.
3. Either call `add_transactions` with rows shaped as `{ date, amount, note, category }`, or pass the CSV text to `import_transactions_csv` with `expenseCategory` and `incomeCategory`.
4. Call the import with `dryRun: true` first. Check dates, amounts, and categories.
5. Run it again without `dryRun`. Duplicates are skipped by default.

`import_transactions_csv` understands common headers (`Date`, `Amount`, `Description`, `Debit`, `Credit`, `Narrative`, `Payee`). Use `mapping` when the header is unusual. Debit columns and negative amounts are expenses. Credit columns and positive amounts are income.

## Library

```javascript
import { MoneyloverClient, CategoryType } from './src/index.js';

const token = await MoneyloverClient.getToken(email, password);
const client = new MoneyloverClient(token, { timeZone: 'Australia/Adelaide' });

const wallets = await client.getWallets();
const categories = await client.listWalletCategories(wallets[0]._id);
await client.addTransaction({
  walletId: wallets[0]._id,
  categoryId: categories.find((category) => category.type === CategoryType.EXPENSE).id,
  amount: '-42.10',
  note: 'Grocer',
  date: '2026-04-18'
});
```

`CategoryType.INCOME` is `1` and `CategoryType.EXPENSE` is `2`.

## Security

- The JWT is cached in `~/.moneylover-mcp/` (or `MONEYLOVER_TOKEN_CACHE_DIR`). The directory is mode `0700` and each token file is mode `0600`. Delete the directory to drop cached sessions.
- Tool results and error text are redacted for JWTs, `password`, and token fields. `login` does not echo the access token.
- Logs do not include the token or password.
- Do not commit `.env`, `.mcp.json`, or a CSV export.

## Tests

```bash
npm test
npm run lint
```

Tests mock `fetch`. They do not call Money Lover and do not need credentials. GitHub Actions runs lint, format check, unit tests, and `npm audit --audit-level=high` on Node 22.

`tests/mcp-tester/` contains optional live scenarios inherited from the upstream project. They need real credentials and an external tester, and CI does not run them.

## What could not be checked against a live account

No Money Lover credentials were available, so none of this was exercised against `web.moneylover.me`:

- Whether `/category/list-all` returns only the signed-in user's categories or a much larger catalogue. `get_all_categories` drops rows whose `account` is another wallet, but it still has to download the response.
- Whether `/transaction/list` or `/transaction/search` silently cap the number of rows on the server. The tools page whatever they receive and set `truncated` when the page is shorter than the list in hand.
- Whether any account stores expense amounts as negative numbers. The sample responses in ferdhika31/moneylover-client-go and the add calls in leMaik/moneylover-cli and allexxis/moneylover-client use a positive magnitude plus category type. This server does the same.
- The exact error code Money Lover returns for an expired JWT beyond the `user_unauthenticated` / HTTP 401 cases handled here.
- Edit and delete field names beyond the payloads the upstream clients send (`account`, `category`, `amount`, `note`, `displayDate`, `with`, `_id`).
