# Money Lover MCP Server

Node.js implementation of a Model Context Protocol (MCP) server that wraps the unofficial Money Lover REST API. The server exposes 27 MCP tools covering authentication, wallets, categories, transactions, events, debts, and static configuration — enabling AI assistants or MCP-compatible clients to query and manage personal finance data.

<a href="https://glama.ai/mcp/servers/@ferdhika31/moneylover-mcp">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@ferdhika31/moneylover-mcp/badge" alt="Money Lover Server MCP server" />
</a>

## Features

- Auto-authentication via `EMAIL`/`PASSWORD` environment variables — no token passing required for most tools.
- 23 read tools covering user info, wallets, categories, transactions, events, debts, icons, providers, and static config.
- 4 write tools: create, update, and delete transactions, wallets, and categories.
- Large responses truncated automatically to keep LLM context manageable (configurable via `limit` parameter).
- Stdio-based server compatible with Claude Code, Claude Desktop, Cursor, and any MCP host.
- Token caching per email under `~/.moneylover-mcp/` with automatic refresh on auth errors.

## Prerequisites

- Node.js 22 or newer.
- Money Lover account credentials.

## Installation

```bash
npm install
```

## Usage

Launch the MCP server over stdio:

```bash
npm start
```

### Project-scoped Configuration (Claude Code)

Add `.mcp.json` at the project root:

```json
{
  "mcpServers": {
    "mcp-moneylover": {
      "command": "node",
      "args": ["/absolute/path/to/moneylover-mcp/src/server.js"],
      "env": {
        "EMAIL": "your@email.com",
        "PASSWORD": "your-password"
      }
    }
  }
}
```

And enable it in `.claude/settings.json`:

```json
{ "enabledMcpjsonServers": ["mcp-moneylover"] }
```

### Global Configuration (Claude Desktop / Cursor)

```json
{
  "mcpServers": {
    "mcp-moneylover": {
      "command": "npx",
      "args": ["@ferdhika31/moneylover-mcp@latest"],
      "env": {
        "EMAIL": "your@email.com",
        "PASSWORD": "your-password"
      }
    }
  }
}
```

## Available Tools

### Auth

| Tool | Description | Arguments |
|------|-------------|-----------|
| `login` | Retrieve a JWT token. | `email`, `password` |

### User

| Tool | Description | Arguments |
|------|-------------|-----------|
| `get_user_info` | Profile associated with the session. | — |
| `get_user_account` | Devices and active sessions. | — |
| `get_user_profile` | Extended profile data. | — |

### Wallets

| Tool | Description | Arguments |
|------|-------------|-----------|
| `get_wallets` | List all wallets. | — |
| `get_wallet_balance` | Balance summary for a wallet. | `walletId` |
| `get_shared_wallets` | Wallets shared with other users. | — |
| `get_awaiting_shared_wallets` | Pending share invitations. | — |
| `add_wallet` | Create a new wallet. | `name`, `currencyId`; optional `icon` |
| `edit_wallet` | Update wallet name, icon, or currency. | `walletId`, `currencyId` (required by API); optional `name`, `icon` |
| `delete_wallet` | Delete a wallet permanently. | `walletId` |

### Categories

| Tool | Description | Arguments |
|------|-------------|-----------|
| `get_categories` | Categories for a specific wallet. | `walletId` |
| `get_all_categories` | All categories across every wallet. | optional `limit` (default 50) |
| `add_category` | Create a category in a wallet. | `walletId`, `name`, `icon` (use `get_icons` to get valid names, e.g. `icon_3`), `type` (1=income, 2=expense) |
| `edit_category` | Rename a category or change its icon. | `categoryId`, `icon` (required by API even when only renaming); optional `name` |
| `delete_category` | Delete a category. | `categoryId` |


### Transactions

| Tool | Description | Arguments |
|------|-------------|-----------|
| `get_transactions` | Transactions in a date range. | `walletId`, `startDate`, `endDate` (YYYY-MM-DD) |
| `add_transaction` | Create a transaction. Category IDs from `get_categories` are resolved to global IDs automatically. | `walletId`, `categoryId`, `amount`, `date`; optional `note`, `with` |
| `edit_transaction` | Update a transaction. The API requires the full payload on every edit — fetch the transaction first if you need current values. `categoryId` is resolved to global automatically. | `transactionId`, `walletId`, `categoryId`, `amount`, `date`; optional `note`, `with` |
| `delete_transaction` | Delete a transaction. | `transactionId` |
| `search_transactions` | Free-form search with optional filters. | optional `filters`, `limit` (default 20) |
| `get_debt_transactions` | Transactions flagged as debts/loans. | — |
| `get_related_transactions` | Related transactions by ID list. | `ids` (array) |
| `get_related_transactions_by_category` | Related transactions for a category. | `categoryId` |
| `get_related_transactions_by_wallet` | Related transactions for a wallet. | `walletId` |
| `get_transaction_search_config` | Available search filter options. | optional `limit` (default 20) |



### Static & Config

| Tool | Description | Arguments |
|------|-------------|-----------|
| `get_events` | Saving goals/events for a wallet. | `walletId`; optional `limit` (default 50) |
| `get_debts` | Open debts in a wallet. | `walletId` |
| `get_icons` | Icon pack metadata. | optional `pack` (default "default") |
| `get_linked_providers` | Supported bank providers. | — |
| `get_currencies` | Currency catalogue. | optional `limit` (default 100) |
| `get_exchange_rates` | USD-based exchange rate snapshot. | — |
| `get_other_config` | Miscellaneous runtime configuration. | — |

## Tool Usage Examples

Prompt examples, required vs optional fields, gotchas, and common multi-step patterns for every tool: **[docs/examples.md](docs/examples.md)**.

## Library Usage

```javascript
import { MoneyloverClient } from './src/moneyloverClient.js';

const token = await MoneyloverClient.getToken(email, password);
const client = new MoneyloverClient(token);

const wallets = await client.getWallets();
const txns = await client.getTransactions(walletId, '2026-01-01', '2026-04-30');
await client.addTransaction({ walletId, categoryId, amount: '50000', date: '2026-04-18' });
await client.editTransaction('txn-id', { amount: '60000', note: 'updated' });
await client.deleteTransaction('txn-id');
```

## Testing

### Unit Tests

Mocked unit tests — no live API calls required:

```bash
npm test
```

### Integration Tests (mcp-tester)

[mcp-tester](https://furydocs.io/mcp-tester/latest/guide/) is a ReAct-agent-based MCP testing framework. It starts the server, drives an LLM to call tools in response to natural-language prompts, and asserts the correct tools were called with correct arguments.

#### Install

```bash
pipx install --index-url https://pypi.artifacts.furycloud.io/simple/ mcp-tester
```

#### Configure

`tests/mcp-tester/mcps.json` — point at the local server with your credentials:

```json
{
  "mcp-moneylover": {
    "command": "node",
    "args": ["/absolute/path/to/src/server.js"],
    "transport": "stdio",
    "env": {
      "EMAIL": "your@email.com",
      "PASSWORD": "your-password"
    }
  }
}
```

#### Run

```bash
mcp-tester run-tests \
  --mcps tests/mcp-tester/mcps.json \
  --model gpt-4o-mini \
  --concurrent-runs 3 \
  tests/mcp-tester/read-tools.yaml
```

#### Results

`tests/mcp-tester/read-tools.yaml` contains 25 integration tests covering every read tool:

```
total 25, success 25, failures 0
```

Key decisions that make the tests stable:

- **No token parameter on read tools** — exposing an optional `token` field caused LLMs to inject wallet IDs into it. The server authenticates automatically via env vars.
- **Response truncation** — several endpoints return hundreds of thousands of records from the shared MoneyLover database. Tools accept a `limit` parameter (default: 20–100) to keep LLM context under control.
- **Dict wrapping** — all tool responses return a JSON object (never a bare array) so MCP framework validation passes.

#### Write-Tool Tests (mcp-tester)

Three additional YAML files test the full CRUD lifecycle for wallets, categories, and transactions across three sequential phases. Each phase runs all three resource types concurrently.

| File | Phase | Tests |
|------|-------|-------|
| `write-create.yaml` | Create | `add_wallet`, `add_category`, `add_transaction` |
| `write-edit.yaml` | Edit | `edit_wallet`, `edit_category`, `edit_transaction` |
| `write-delete.yaml` | Delete | `delete_wallet`, `delete_category`, `delete_transaction` |

Run phases in order — each depends on the previous:

```bash
# Phase 1: Create
mcp-tester run-tests --mcps tests/mcp-tester/mcps.json --model gpt-4o-mini --concurrent-runs 3 tests/mcp-tester/write-create.yaml

# Phase 2: Edit (after Phase 1 passes)
mcp-tester run-tests --mcps tests/mcp-tester/mcps.json --model gpt-4o-mini --concurrent-runs 3 tests/mcp-tester/write-edit.yaml

# Phase 3: Delete (after Phase 2 passes)
mcp-tester run-tests --mcps tests/mcp-tester/mcps.json --model gpt-4o-mini --concurrent-runs 3 tests/mcp-tester/write-delete.yaml
```

Results across all three phases:

```
Phase 1 (Create): total 3, success 3, failures 0
Phase 2 (Edit):   total 3, success 3, failures 0
Phase 3 (Delete): total 3, success 3, failures 0
```

Key design decisions for write-tool tests:

- **Discovery before mutation** — Edit and delete tests instruct the agent to first call a read tool (`get_wallets`, `get_categories`, `get_transactions`) to locate the target by name, then call the mutation tool. This mirrors real-world agent behaviour where IDs are not known in advance.
- **`args: !any` for write tool assertions** — The framework requires exact arg matching. Write tools accept optional fields (`icon`, `with`, etc.) that the agent may include at its discretion; `!any` verifies the tool was called and succeeded without failing on harmless extras. Read-tool assertions can use exact arg matching because their schemas have no optional fields the LLM would add spontaneously.
- **Predictable identifiers** — Test resources use fixed names (`MCP-Test-Wallet`, `MCP-Test-Category`) and a fixed note (`MCP test transaction`) so the agent can locate them by name during the edit and delete phases without needing to share state between test runs.
- **Full-payload edit assertions** — `edit_transaction` is a full-replace operation; the test prompt instructs the agent to fetch the existing transaction first (`get_transactions`) and carry forward all current field values, only changing the note. This validates the multi-step reasoning the tool description requires.

## Security Notes

- Never commit real credentials or tokens.
- Cached tokens live in `~/.moneylover-mcp/` restricted to the current user.
- Delete that directory to revoke all cached sessions.
