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
- Money Lover stores a **positive** amount. The category type decides income versus expense. A leading minus is accepted on an expense category (typical bank debit) and rejected on an income category, so a negative salary is not filed as income. `/transaction/add` sends that amount as a JSON number, the same way the website’s amount field does (`parseFloat`), with `displayDate` as `YYYY-MM-DD`.
- `edit_transaction` reads the current transaction, then writes the full record back. Pass `walletId` and `currentDate` so it can be found. Omit a field to keep it. The written payload includes `exclude_report`, event, image, reminder, location, and a debt parent when the row has one.
- Categories belong to one wallet. `list_categories` returns the id the server stores. `addId` on that row, when present, is the id from `POST /category/list-all` for the same wallet (same name, type, and metadata). The website’s add form posts `addId`. `add_transaction` accepts either id and sends `addId`. A stored id with no list-all row on that wallet is not posted. The same name on another wallet is a different category, and a parent and a sub-category can share a name, so a collision asks for `categoryId`. Lookup does not use another wallet’s id, and it does not fall back to a category named Others or Other expense.
- `list_categories` includes `systemLabel` when the API sends built-in metadata (Other expense, Other income, Debt, Loan, Repayment, and the transfer categories), plus `parentId` and `walletId`. Some wallets have no Other expense category. `adjust_balance` and a transfer fee then need an explicit `categoryId` from that wallet. Those writes also send the list-all id.
- `add_category` takes `parentId` for a sub-category. `type` 1 is income and `type` 2 is expense.
- Australian dollars are currency id **20**. `edit_wallet` reads the wallet first and sends `account_type` (4 is a credit wallet), `exclude_total`, and `archived` back so a rename does not drop them.
- A transfer between your own wallets is `transfer_money` (`/transaction/add-multi` with a from leg, a to leg, and an optional fee). Recording both sides as normal expenses double-counts a card payment.
- `add_transactions` and `import_transactions_csv` append `ml-batch:<id>` to each note and store the created ids under the token cache. `undo_import` deletes that batch and requires `confirm: true`.
- Duplicate checks call `/transaction/search` with `accounts`, `startDate`, and `endDate`. The batch marker is ignored when comparing notes.

## Safety

- `delete_transaction`, `delete_wallet`, `delete_category`, `delete_budget`, `merge_categories`, and `undo_import` do nothing unless `confirm` is `true`.
- `delete_transaction` posts `{_id, delRelated}`. `delRelated` is false unless `deleteRelated` is true, which removes both legs of a transfer. The server assigns the transaction id when it is created (often prefixed `web`). This client does not invent that id.
- Write tools accept `dryRun: true`. They validate and return the payload without posting it.
- `add_transactions` and `import_transactions_csv` default to skipping duplicates: same wallet, same calendar date, same absolute amount, and a similar note (case and punctuation ignored; a note of 8+ characters may match when one contains the other). Blank notes match other blank notes.
- Each import row returns its own status (`created`, `skipped_duplicate`, `dry_run`, or `error`). One bad row does not roll back rows that already succeeded. Run again with `skipDuplicates: true` after a partial import.
- Batches are limited to 200 rows.

## Tools

The server registers 48 tools. Authentication is read from the environment. Tools do not take a token argument, and `login` does not return the JWT.

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
| `whoami`                               | Check the session: email, wallet counts, and the `user_category_v2` tag. No token.                                                                                                          |
| `edit_wallet`                          | Update a wallet. Keeps credit type, exclude-from-total, and archived. AUD is currency id 20.                                                                                                |
| `delete_wallet`                        | Delete a wallet. Requires `confirm: true`.                                                                                                                                                  |
| `get_categories`                       | Categories for one wallet, with `typeName`, `systemLabel`, parent, and wallet. Use these ids for that wallet only.                                                                          |
| `list_categories`                      | Compact income and expense lists for mapping a statement.                                                                                                                                   |
| `get_all_categories`                   | Categories across your wallets, paged. Records tied to another wallet id are left out.                                                                                                      |
| `add_category`                         | Create a category. `type` 1 income, 2 expense. Optional `parentId` for a sub-category.                                                                                                      |
| `edit_category`                        | Rename a category. `icon` is required even when unchanged.                                                                                                                                  |
| `delete_category`                      | Delete a category. Requires `confirm: true`.                                                                                                                                                |
| `merge_categories`                     | Merge `fromCategoryId` into `toCategoryId` (`/category/merge`). Requires `confirm: true`.                                                                                                   |
| `get_transactions`                     | Transactions between two dates. `displayDate` is `YYYY-MM-DD`. Default page size 500. `truncated` and `nextOffset` say when to continue.                                                    |
| `add_transaction`                      | Create one transaction. Optional note, with, reminder, location, event, photo reference, exclude from report, `dryRun`, and `skipDuplicates`.                                               |
| `add_transactions`                     | Create up to 200 transactions. Per-row results, a batch marker, and a local id log. `skipDuplicates` defaults to true.                                                                      |
| `import_transactions_csv`              | Parse a bank CSV (date, amount and/or debit/credit, description). Australian `DD/MM/YYYY` when the order is ambiguous. Returns parsed rows instead of writing when no category is supplied. |
| `edit_transaction`                     | Read the row, merge your changes, write the full record.                                                                                                                                    |
| `delete_transaction`                   | Delete one transaction. Requires `confirm: true`. `deleteRelated` removes the other transfer leg.                                                                                           |
| `transfer_money`                       | Move money between two wallets, with an optional fee leg.                                                                                                                                   |
| `search_transactions`                  | Search with `accounts`, `categoryIDs`, dates, `note`, `with`, and `amount`. `limit` and `offset` go to the API.                                                                             |
| `search_transaction_totals`            | Totals for that filter (`/transaction/search/balance`).                                                                                                                                     |
| `adjust_balance`                       | Post the difference so the wallet matches a balance. Uses Other income or Other expense only when that category exists on this wallet.                                                      |
| `get_balance_as_of`                    | Balance at the end of a date, from the current balance minus later transactions.                                                                                                            |
| `undo_import`                          | Delete one import batch. Requires `confirm: true`.                                                                                                                                          |
| `get_budgets`                          | Budgets for one wallet or all wallets.                                                                                                                                                      |
| `add_budget`                           | Create a budget. Optional `dryRun`.                                                                                                                                                         |
| `edit_budget`                          | Update a budget. Optional `dryRun`.                                                                                                                                                         |
| `delete_budget`                        | Delete a budget (`only` or `all`). Requires `confirm: true`.                                                                                                                                |
| `get_report`                           | Period report for a wallet (`/report/{walletId}`).                                                                                                                                          |
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

## This account

Observed in the owner’s browser on 8 October 2026, on `web.moneylover.me`, not through this server:

- The account is Premium.
- The wallets are Australian dollars, except possibly one. AUD is currency id 20. Confirm with `get_currencies`.
- Each wallet has its own category tree, on the order of 100 categories, with parent and sub-categories. Some wallets have no Other expense category.
- The transaction form offers wallet, category, amount, date, note, with, reminder, location, event, a photo under 2MB, and exclude from report.
- Adding a transaction and deleting it both succeeded. There was no read-only notice and no error.

`add_transaction` and `edit_transaction` can send note, with, reminder, location, event, exclude from report, and an existing photo reference. This server does not upload a photo file. The website limit is under 2MB.

## Known limits of the web API

These are properties of Money Lover, not something this server can turn off:

- A browser session on this account could add and delete transactions on 8 October 2026. An August 2024 support note said the website was read-only for adding transactions; that notice was not shown in this browser session. A response that still says the API is read-only is returned as code `READ_ONLY`.
- Headless reads on this account work (login, whoami, categories, search, search totals, and offset paging). A headless `POST /transaction/add` still did not answer: the 20 second fail-fast fired and nothing was written. That run posted the stored category id from `list_categories`. The browser add on the same account posted a different id from `POST /category/list-all` and returned in about a second. Writes still fail within 20 seconds and are not retried. HTTP 520–527 and a client timeout are returned as `CLOUDFLARE` or `TIMEOUT`, including on `add_transaction`.
- `/transaction/search` ignores `limit` and returns 50 rows. A full page sets `nextOffset`. `/transaction/search/balance` returns every matching transaction; `search_transaction_totals` adds those up and does not return the rows.
- The site sits behind Cloudflare. A challenge (HTTP 403, “Just a moment”, or a Cloudflare interstitial) is returned as code `CLOUDFLARE`. Writes from a non-browser client may need the browser `cf_clearance` cookie and a matching User-Agent. This server does not send a browser cookie.
- Accounts tagged `user_category_v2` have category and budget changes disabled in the web app. A failed category or budget write on such an account is returned as code `USER_CATEGORY_V2`. `whoami` reports the tag. Transaction import is not blocked by that tag.
- Expired sessions come back as JSON `e: 706` (“Not authorized error”). The server calls `/user/refresh-token` with the stored refresh token when it has one, then logs in again with email and password. `e: 717` is device not found and `e: 718` is device blocked. Those two are not refreshed; the message says to fix the device in the Money Lover app. The archived web bundle compares the numbers and does not include those English labels, so the 717/718 wording follows that review.
- There is no separate balance-as-of endpoint. `get_balance_as_of` derives the figure from the current balance and later transactions.
- `/transaction/search/balance` was checked headless: it returns the matching transactions (7,976 rows, about 10.6 MB, for one wallet from 2018 to 2026), including `tokenDevice`. This server totals them and does not return the rows. Transfer, budget, and report payloads still come from the August 2025 bundle and were not replayed.

## What could not be checked against a live account

The owner added and deleted one transaction in the browser on 8 October 2026. The captured add was `POST https://web.moneylover.me/api/transaction/add` and returned in about 0.9 seconds. The category the user picked, Bank fees, was sent as `B012AA1D774D42B6A4C68A84B5977C4C`. The saved transaction’s category was `FBD2B817A8DE4AE0B8BF8261006DCEC5`, which is the id `list_categories` returns for Bank fees on that wallet. The archived web bundle loads add-dialog categories from `POST /category/list-all` (`category/listAllCategory`), keeps `account === wallet`, and posts that row’s `_id`. This server now does the same. The delete was `POST /api/transaction/delete` with `{_id, delRelated:false}`. The id on that row (`web…`) is the id the add response assigned; the client does not generate it.

A headless retest of this branch on the same account (Node 22, real credentials) passed `npm test` 108/108 with the real environment set. Reads, `search_transaction_totals`, and offset paging worked. `POST /transaction/add` still did not answer (the 20 second fail-fast fired twice, and nothing was written). That run sent the stored category id. It has not been repeated after this list-all mapping. A failed add used to surface as `{error:'Error', message}` because the tool rethrew `new Error(message)` and dropped `TIMEOUT` / `CLOUDFLARE`. The code is now kept. No credentials are stored in this repository.

Still unchecked:

- Whether a headless `POST /transaction/add` that sends the `/category/list-all` id completes. The browser add did. The previous headless add sent the stored id and did not.
- Whether `/category/list-all` returns only the signed-in user's categories or a much larger catalogue. `get_all_categories` drops rows whose `account` is another wallet, but it still has to download the response. The add path uses the rows for the target wallet.
- Whether `/transaction/list` silently caps rows. `/transaction/search` ignores `limit` and returns 50 per page; `nextOffset` follows that. `/transaction/search/balance` does not page: it returned every match.
- Whether any account stores expense amounts as negative numbers. The sample responses in ferdhika31/moneylover-client-go and the add calls in leMaik/moneylover-cli and allexxis/moneylover-client use a positive magnitude plus category type. This server does the same.
- Whether a live account returns `e: 706` in the body, or only HTTP 401, and whether the OAuth login response includes `refresh_token` as well as `access_token`. The refresh call matches the web client (`POST /user/refresh-token` with `{ refreshToken }`).
- The fields inside `/wallet/balance`’s `balance[0]`. The balance helpers accept a number or an `amount` / `balance` field.
- Whether `/transaction/search` with `note` finds an `ml-batch:` marker as a substring, which `undo_import` uses in addition to the local id log.
- Whether `/report/{walletId}` and `/budget/*` succeed for this account, including a `user_category_v2` account where the web app hides those buttons.
- Whether AUD remains currency id 20. That id is the one named in review; `get_currencies` is the check.
