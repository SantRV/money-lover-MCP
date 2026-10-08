# Tool Usage Examples

Each section shows: the natural-language prompt that triggers the tool, the tool call that results, and a trimmed example response. For write tools, required vs optional fields and known API constraints are called out explicitly.

---

## Auth

### `login`

Retrieve a JWT token manually (most tools authenticate automatically via `EMAIL`/`PASSWORD` env vars).

```
Prompt: "Log in to Money Lover with email user@example.com and password secret123."
```

```json
Tool call: login({ email: "user@example.com", password: "secret123" })
Response:  { "authenticated": true, "email": "user@example.com", "cached": true }
```

> **Note:** The server caches the JWT under `~/.moneylover-mcp/` and does not return it. Later tools use that cache. You only need `login` when the process was not started with `MONEYLOVER_EMAIL` and `MONEYLOVER_PASSWORD`.

---

## User

### `get_user_info`

```
Prompt: "Show me my Money Lover account information."
```

```json
Tool call: get_user_info()
Response:  { "email": "user@example.com", "name": "Juan", "currency": { "id": 30, "name": "COP" }, ... }
```

### `get_user_account`

```
Prompt: "List every device logged into my Money Lover account."
```

```json
Tool call: get_user_account()
Response:  { "devices": [{ "device": "iPhone", "lastLogin": "2026-04-18T..." }, ...] }
```

### `get_user_profile`

```
Prompt: "Fetch my extended Money Lover user profile."
```

```json
Tool call: get_user_profile()
Response:  { "avatar": "...", "country": "CO", "timezone": "America/Bogota", ... }
```

---

## Wallets

### `get_wallets`

```
Prompt: "Show me all my Money Lover wallets."
```

```json
Tool call: get_wallets()
Response:  { "wallets": [{ "_id": "590f65b...", "name": "Main", "balance": 1500000, ... }] }
```

### `get_wallet_balance`

```
Prompt: "What is the current balance of wallet 590f65bec16649948da1f4cfb94870c6?"
```

```json
Tool call: get_wallet_balance({ walletId: "590f65bec16649948da1f4cfb94870c6" })
Response:  { "balance": 1500000, "income": 3000000, "expense": 1500000, "currency": { "name": "COP" } }
```

### `get_shared_wallets`

```
Prompt: "List the wallets I'm sharing with other users."
```

```json
Tool call: get_shared_wallets()
Response:  { "wallets": [] }
```

### `get_awaiting_shared_wallets`

```
Prompt: "Do I have any pending wallet share invitations?"
```

```json
Tool call: get_awaiting_shared_wallets()
Response:  { "wallets": [] }
```

### `add_wallet`

Creates a new wallet. `currencyId` is required and must be an integer (use `get_currencies` to browse valid IDs, e.g. `30` for COP, `1` for USD).

**Required:** `name`, `currencyId`  
**Optional:** `icon` (defaults to `icon_7`)

```
Prompt: "Create a new Money Lover wallet named 'Savings' with currency ID 30 (COP)."
```

```json
Tool call: add_wallet({ name: "Savings", currencyId: 30 })
Response:  { "_id": "web1a2b3c...", "name": "Savings", "currency_id": 30 }
```

### `edit_wallet`

Updates a wallet. `currencyId` is **always required by the API** even when only renaming — pass the wallet's current currency ID if you are not changing it.

**Required:** `walletId`, `currencyId`  
**Optional:** `name`, `icon`

```
Prompt: "Rename wallet 590f65bec16649948da1f4cfb94870c6 to 'Expenses' (keep currency 30)."
```

```json
Tool call: edit_wallet({ walletId: "590f65bec16649948da1f4cfb94870c6", currencyId: 30, name: "Expenses" })
Response:  { "_id": "590f65b...", "name": "Expenses", ... }
```

> **Tip:** Call `get_wallets` first to retrieve the wallet's current `currencyId` if you don't have it on hand.

### `delete_wallet`

Permanently deletes a wallet and all of its transactions.

**Required:** `walletId`, `confirm: true`

```
Prompt: "Delete wallet web1a2b3c..."
```

```json
Tool call: delete_wallet({ walletId: "web1a2b3c...", confirm: true })
Response:  {}
```

---

## Categories

### `get_categories`

Returns categories scoped to a single wallet (wallet-specific IDs). Use these IDs with `add_transaction` and `edit_transaction` — the server resolves them to global IDs automatically.

```
Prompt: "List the categories in wallet 590f65bec16649948da1f4cfb94870c6."
```

```json
Tool call: get_categories({ walletId: "590f65bec16649948da1f4cfb94870c6" })
Response:  { "categories": [{ "_id": "225c6924...", "name": "Food & Drink", "type": 2, "typeName": "expense" }, ...] }
```

### `get_all_categories`

Returns all categories across every wallet, using global IDs. Use these IDs when calling `edit_transaction` directly without the auto-resolve path.

```
Prompt: "Give me all my Money Lover categories."
```

```json
Tool call: get_all_categories({ limit: 50 })
Response:  { "categories": [{ "_id": "9c0aee57...", "name": "Food & Drink", "account": "590f65b...", ... }, ...] }
```

### `add_category`

Creates a category inside a wallet. Use `get_icons` to browse valid icon names (format: `icon_N`, e.g. `icon_3`).

**Required:** `walletId`, `name`, `icon`, `type`  
**type:** `1` = income, `2` = expense

```
Prompt: "In wallet 590f65bec16649948da1f4cfb94870c6, create an expense category named 'Gym' using icon 'icon_3'."
```

```json
Tool call: add_category({ walletId: "590f65bec16649948da1f4cfb94870c6", name: "Gym", icon: "icon_3", type: 2 })
Response:  { "_id": "web4f5a6b...", "name": "Gym", "type": 2 }
```

### `edit_category`

Renames a category or changes its icon. `icon` is **always required by the API** even when only renaming — pass the category's current icon if you are not changing it.

**Required:** `categoryId`, `icon`  
**Optional:** `name`

```
Prompt: "Rename category web4f5a6b... to 'Fitness'. Keep icon icon_3."
```

```json
Tool call: edit_category({ categoryId: "web4f5a6b...", icon: "icon_3", name: "Fitness" })
Response:  { "_id": "web4f5a6b...", "name": "Fitness" }
```

> **Tip:** Call `get_categories` first to retrieve the category's current `icon` if you don't have it on hand.

### `delete_category`

**Required:** `categoryId`, `confirm: true`

```
Prompt: "Delete category web4f5a6b..."
```

```json
Tool call: delete_category({ categoryId: "web4f5a6b...", confirm: true })
Response:  {}
```

---

## Transactions

### `get_transactions`

Returns all transactions in a wallet within a date range.

**Required:** `walletId`, `startDate`, `endDate` (YYYY-MM-DD)

```
Prompt: "List transactions for wallet 590f65bec16649948da1f4cfb94870c6 from 2026-04-01 to 2026-04-18."
```

```json
Tool call: get_transactions({ walletId: "590f65bec16649948da1f4cfb94870c6", startDate: "2026-04-01", endDate: "2026-04-18" })
Response:  { "transactions": [{ "_id": "bfa8b033...", "amount": 50000, "note": "Lunch", "displayDate": "2026-04-15", "category": { "_id": "9c0aee57...", "name": "Food & Drink" } }, ...] }
```

### `add_transaction`

Creates a transaction. `categoryId` can be a wallet-specific ID (from `get_categories`) or a global ID (from `get_all_categories`) — the server resolves wallet-specific IDs to global IDs automatically before posting.

**Required:** `walletId`, `categoryId`, `amount` (string), `date` (YYYY-MM-DD)  
**Optional:** `note`, `with` (array of party names)

```
Prompt: "In wallet 590f65bec16649948da1f4cfb94870c6, add a 50000 COP food expense for today (2026-04-18) with note 'Lunch', category 225c6924c4f143909851daeb75627928."
```

```json
Tool call: add_transaction({
  walletId:   "590f65bec16649948da1f4cfb94870c6",
  categoryId: "225c6924c4f143909851daeb75627928",
  amount:     "50000",
  date:       "2026-04-18",
  note:       "Lunch"
})
Response:  { "_id": "webXXX...", "amount": 50000, "note": "Lunch", "displayDate": "2026-04-18" }
```

> **Category ID resolution:** Passing a wallet-specific category ID is safe — `add_transaction` resolves it internally. If resolution fails (category not found in either list), the original ID is used as a fallback.

### `edit_transaction`

Updates a transaction. The API replaces the stored row, so the server loads the current transaction first and sends back `exclude_report`, `event`, image, reminder, location, parties, and any debt parent along with your changes.

**Required:** `transactionId`  
**Needed to find the row:** `walletId` and `currentDate` (the day it is on now)  
**Optional:** `categoryId`, `amount`, `date`, `note`, `with`, `excludeReport`, `eventId`

```
Prompt: "Update transaction bfa8b03330b24579849acdf50db11304 — change note to 'Team lunch'. Keep all other fields."
```

```json
Tool call: edit_transaction({
  transactionId: "bfa8b03330b24579849acdf50db11304",
  walletId:      "590f65bec16649948da1f4cfb94870c6",
  currentDate:   "2026-04-15",
  note:          "Team lunch"
})
Response:  {}
```

> Pass `walletId` and `currentDate` so the lookup can find the row. Omit a field to keep it. A `null` or `{}` response means the update was accepted.

### `delete_transaction`

**Required:** `transactionId`, `confirm: true`

```
Prompt: "Delete transaction bfa8b03330b24579849acdf50db11304."
```

```json
Tool call: delete_transaction({ transactionId: "bfa8b03330b24579849acdf50db11304", confirm: true })
Response:  {}
```

### `search_transactions`

Free-form search with optional filters. Use `get_transaction_search_config` to discover available filter keys.

**Optional:** `filters` (object), `limit` (default 20)

```
Prompt: "Search my Money Lover transactions for wallet 590f65bec16649948da1f4cfb94870c6."
```

```json
Tool call: search_transactions({ filters: { walletId: "590f65bec16649948da1f4cfb94870c6" }, limit: 20 })
Response:  { "transactions": [...] }
```

### `get_debt_transactions`

Returns all transactions flagged as debts or loans (no parameters required).

```
Prompt: "Show all transactions Money Lover has marked as debts or loans."
```

```json
Tool call: get_debt_transactions()
Response:  { "transactions": [...] }
```

### `get_related_transactions`

Returns transactions related to a given list of transaction IDs.

**Required:** `ids` (array of strings)

```
Prompt: "Find transactions related to IDs bfa8b033... and c1d2e3f4..."
```

```json
Tool call: get_related_transactions({ ids: ["bfa8b033...", "c1d2e3f4..."] })
Response:  { "transactions": [...] }
```

### `get_related_transactions_by_category`

**Required:** `categoryId`

```
Prompt: "Show transactions related to category 9c0aee5796c345d087c91c0ed5bcc689."
```

```json
Tool call: get_related_transactions_by_category({ categoryId: "9c0aee5796c345d087c91c0ed5bcc689" })
Response:  { "transactions": [...] }
```

### `get_related_transactions_by_wallet`

**Required:** `walletId`

```
Prompt: "Show transactions related to wallet 590f65bec16649948da1f4cfb94870c6."
```

```json
Tool call: get_related_transactions_by_wallet({ walletId: "590f65bec16649948da1f4cfb94870c6" })
Response:  { "transactions": [...] }
```

### `get_transaction_search_config`

Returns the available filter options (labels, parties, etc.) for `search_transactions`.

**Optional:** `limit` (default 20)

```
Prompt: "Fetch the configuration used for searching transactions in Money Lover."
```

```json
Tool call: get_transaction_search_config()
Response:  { "config": { "labels": [...], "with": [...] } }
```

---

## Static & Config

### `get_events`

Returns saving goals and events attached to a wallet.

**Required:** `walletId`  
**Optional:** `limit` (default 50)

```
Prompt: "Show all saving goals for wallet 590f65bec16649948da1f4cfb94870c6."
```

```json
Tool call: get_events({ walletId: "590f65bec16649948da1f4cfb94870c6" })
Response:  { "events": [...] }
```

### `get_debts`

Returns open debts tracked in a wallet.

**Required:** `walletId`

```
Prompt: "List the open debts in wallet 590f65bec16649948da1f4cfb94870c6."
```

```json
Tool call: get_debts({ walletId: "590f65bec16649948da1f4cfb94870c6" })
Response:  { "debts": [...] }
```

### `get_icons`

Returns the icon pack metadata. Icon names follow the format `icon_N` (e.g. `icon_3`). Pass one of these names to `add_category` or `edit_category`.

**Optional:** `pack` (default `"default"`)

```
Prompt: "Show me the available Money Lover icons."
```

```json
Tool call: get_icons({ pack: "default" })
Response:  { "icons": [{ "name": "icon_1", "url": "..." }, { "name": "icon_3", ... }, ...] }
```

### `get_linked_providers`

Returns supported bank providers for account linking.

```
Prompt: "What bank providers does Money Lover support for account linking?"
```

```json
Tool call: get_linked_providers()
Response:  { "providers": [{ "name": "Bancolombia", ... }, ...] }
```

### `get_currencies`

Returns the full currency catalogue. Use the `id` field as `currencyId` in `add_wallet` and `edit_wallet`.

**Optional:** `limit` (default 100)

```
Prompt: "What currencies does Money Lover support?"
```

```json
Tool call: get_currencies({ limit: 10 })
Response:  { "currencies": [{ "id": 1, "name": "USD", "symbol": "$" }, { "id": 30, "name": "COP", "symbol": "$" }, ...] }
```

### `get_exchange_rates`

Returns a USD-based exchange rate snapshot.

```
Prompt: "Show me the current exchange rates in Money Lover."
```

```json
Tool call: get_exchange_rates()
Response:  { "USD": 1, "EUR": 0.92, "COP": 4150, ... }
```

### `get_other_config`

Returns miscellaneous runtime configuration from the Money Lover API.

```
Prompt: "Fetch the Money Lover runtime configuration."
```

```json
Tool call: get_other_config()
Response:  { "config": { ... } }
```

---

## Common Patterns

### Look up a category ID before creating a transaction

```
1. get_categories({ walletId: "590f65b..." })
   → find "Food & Drink" → _id "225c6924..."

2. add_transaction({ walletId: "590f65b...", categoryId: "225c6924...", amount: "35000", date: "2026-04-18", note: "Groceries" })
```

### Edit a transaction without wiping the other fields

```
1. edit_transaction({
     transactionId: "bfa8b...",
     walletId: "590f65b...",
     currentDate: "2026-04-15",
     note: "Updated note"
   })
```

The server reads the row and writes the other fields back.

### Australian dollars

`get_currencies` is the catalogue. AUD is currency id 20.

### Create a wallet with the correct currency ID

```
1. get_currencies({ limit: 100 })
   → find "COP" → id 30

2. add_wallet({ name: "My Savings", currencyId: 30 })
```

### Rename a category without changing its icon

```
1. get_categories({ walletId: "590f65b..." })
   → find "Gym" → _id "web4f5a6b...", icon "icon_3"

2. edit_category({ categoryId: "web4f5a6b...", icon: "icon_3", name: "Fitness" })
   (icon is required by the API even when not changing it)
```
