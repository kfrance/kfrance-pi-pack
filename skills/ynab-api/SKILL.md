---
name: ynab-api
description: Query and manage YNAB (You Need A Budget) data. Use when the user asks about their budget, transactions, accounts, spending, categories, or anything YNAB-related. Can list accounts, pull transactions by month or account, search for payees, check balances, and analyze spending. Uses the ynab-cli tool and direct YNAB API v1 calls.
---

# YNAB API

Query and manage YNAB budget data via the CLI tool and direct API calls.

## Prerequisites

### CLI Tool (preferred for common operations)

The `ynab` wrapper must be on PATH. It loads credentials from `~/.config/ynab-cli/env` automatically.

```bash
ynab --help
```

### Credentials

Stored in `~/.config/ynab-cli/env`:

```bash
YNAB_CLI_ACCESS_TOKEN=<token>
YNAB_CLI_BUDGET_ID=<budget-id>
```

To load credentials for direct API calls:

```bash
source <(grep -v '^#' ~/.config/ynab-cli/env | sed 's/^/export /')
```

## CLI Commands

The `ynab` wrapper auto-injects the access token and expects subcommand groups.

### Accounts

```bash
# List all accounts (name, type, balance)
ynab accounts list-all
```

### Transactions

```bash
# List transactions for a month (YYYY-MM format)
ynab transactions list-by-month 2026-02

# Filter by account name (case-insensitive substring match)
ynab transactions list-by-month 2026-02 --account "AF Checking"

# Show only unapproved transactions
ynab transactions list-by-month 2026-02 --unapproved

# Combine filters
ynab transactions list-by-month 2026-02 --account "Costco" --unapproved
```

### Budgets

```bash
# List all budgets
ynab budgets list-all
```

### Categories

```bash
# List all categories
ynab categories list-all
```

### Payees

```bash
# List all payees
ynab payees list-all
```

## Direct API Access

For operations not covered by the CLI, use curl against the YNAB API v1 directly.

**Base URL:** `https://api.ynab.com/v1`

### Authentication

```bash
source <(grep -v '^#' ~/.config/ynab-cli/env | sed 's/^/export /')
# Then use: -H "Authorization: Bearer $YNAB_CLI_ACCESS_TOKEN"
# Budget ID is: $YNAB_CLI_BUDGET_ID
```

### API Endpoints Reference

All endpoints below are relative to `https://api.ynab.com/v1`. Replace `{budget_id}` with `$YNAB_CLI_BUDGET_ID`.

#### User
| Method | Path | Description |
|--------|------|-------------|
| GET | `/user` | Get authenticated user info |

#### Budgets
| Method | Path | Description |
|--------|------|-------------|
| GET | `/budgets` | List all budgets (optional `?include_accounts=true`) |
| GET | `/budgets/{budget_id}` | Get full budget export |
| GET | `/budgets/{budget_id}/settings` | Get budget settings |

#### Accounts
| Method | Path | Description |
|--------|------|-------------|
| GET | `/budgets/{budget_id}/accounts` | List all accounts |
| GET | `/budgets/{budget_id}/accounts/{account_id}` | Get single account |
| POST | `/budgets/{budget_id}/accounts` | Create account |

#### Transactions
| Method | Path | Description |
|--------|------|-------------|
| GET | `/budgets/{budget_id}/transactions` | List all transactions (optional `?since_date=YYYY-MM-DD&type=unapproved`) |
| GET | `/budgets/{budget_id}/transactions/{transaction_id}` | Get single transaction |
| GET | `/budgets/{budget_id}/accounts/{account_id}/transactions` | List transactions by account |
| GET | `/budgets/{budget_id}/months/{month}/transactions` | List transactions by month (`month` = YYYY-MM-01) |
| GET | `/budgets/{budget_id}/categories/{category_id}/transactions` | List transactions by category |
| GET | `/budgets/{budget_id}/payees/{payee_id}/transactions` | List transactions by payee |
| POST | `/budgets/{budget_id}/transactions` | Create transaction(s) |
| PUT | `/budgets/{budget_id}/transactions/{transaction_id}` | Update single transaction |
| PATCH | `/budgets/{budget_id}/transactions` | Update multiple transactions (by id or import_id) |
| DELETE | `/budgets/{budget_id}/transactions/{transaction_id}` | Delete transaction |
| POST | `/budgets/{budget_id}/transactions/import` | Import linked account transactions |

#### Categories
| Method | Path | Description |
|--------|------|-------------|
| GET | `/budgets/{budget_id}/categories` | List all categories (grouped by category group) |
| GET | `/budgets/{budget_id}/categories/{category_id}` | Get single category |
| GET | `/budgets/{budget_id}/months/{month}/categories/{category_id}` | Get category for specific month |
| PATCH | `/budgets/{budget_id}/categories/{category_id}` | Update category |
| PATCH | `/budgets/{budget_id}/months/{month}/categories/{category_id}` | Update category budgeted amount for month |

#### Payees
| Method | Path | Description |
|--------|------|-------------|
| GET | `/budgets/{budget_id}/payees` | List all payees |
| GET | `/budgets/{budget_id}/payees/{payee_id}` | Get single payee |
| PATCH | `/budgets/{budget_id}/payees/{payee_id}` | Update payee |

#### Payee Locations
| Method | Path | Description |
|--------|------|-------------|
| GET | `/budgets/{budget_id}/payee_locations` | List all payee locations |
| GET | `/budgets/{budget_id}/payee_locations/{payee_location_id}` | Get single payee location |
| GET | `/budgets/{budget_id}/payees/{payee_id}/payee_locations` | List locations for a payee |

#### Months
| Method | Path | Description |
|--------|------|-------------|
| GET | `/budgets/{budget_id}/months` | List all budget months |
| GET | `/budgets/{budget_id}/months/{month}` | Get single budget month detail |

#### Scheduled Transactions
| Method | Path | Description |
|--------|------|-------------|
| GET | `/budgets/{budget_id}/scheduled_transactions` | List all scheduled transactions |
| GET | `/budgets/{budget_id}/scheduled_transactions/{id}` | Get single scheduled transaction |
| POST | `/budgets/{budget_id}/scheduled_transactions` | Create scheduled transaction |
| PUT | `/budgets/{budget_id}/scheduled_transactions/{id}` | Update scheduled transaction |
| DELETE | `/budgets/{budget_id}/scheduled_transactions/{id}` | Delete scheduled transaction |

### Common Query Parameters

- `since_date` (YYYY-MM-DD) — filter transactions after this date
- `type` — `unapproved` or `uncategorized` to filter transaction type
- `last_knowledge_of_server` (int) — for delta requests (only return changes since this knowledge value)

### Example curl Calls

```bash
source <(grep -v '^#' ~/.config/ynab-cli/env | sed 's/^/export /')

# List accounts
curl -s -H "Authorization: Bearer $YNAB_CLI_ACCESS_TOKEN" \
  "https://api.ynab.com/v1/budgets/$YNAB_CLI_BUDGET_ID/accounts" | jq '.data.accounts[] | select(.deleted == false) | {name, type, balance}'

# Get transactions for a month
curl -s -H "Authorization: Bearer $YNAB_CLI_ACCESS_TOKEN" \
  "https://api.ynab.com/v1/budgets/$YNAB_CLI_BUDGET_ID/months/2026-02-01/transactions" | jq '.data.transactions | length'

# Get transactions for a specific account (replace ACCOUNT_ID)
curl -s -H "Authorization: Bearer $YNAB_CLI_ACCESS_TOKEN" \
  "https://api.ynab.com/v1/budgets/$YNAB_CLI_BUDGET_ID/accounts/ACCOUNT_ID/transactions?since_date=2026-01-01" | jq '.data.transactions[] | select(.deleted == false) | {date, payee_name, amount}'

# Search for a payee (case-insensitive)
curl -s -H "Authorization: Bearer $YNAB_CLI_ACCESS_TOKEN" \
  "https://api.ynab.com/v1/budgets/$YNAB_CLI_BUDGET_ID/payees" | jq '.data.payees[] | select(.name | test("search_term"; "i"))'

# Get budget month summary
curl -s -H "Authorization: Bearer $YNAB_CLI_ACCESS_TOKEN" \
  "https://api.ynab.com/v1/budgets/$YNAB_CLI_BUDGET_ID/months/2026-02-01" | jq '.data.month | {month, income, budgeted, activity}'
```

## Important Notes

### Amounts

All amounts in the YNAB API are in **milliunits** (1/1000 of a currency unit). To convert:
- API amount `-47094000` = `-$47,094.00`
- Divide by 1000 to get dollars: `amount / 1000`
- Negative = outflow (expense), Positive = inflow (income/refund)

### Rate Limiting

The YNAB API has a rate limit of **200 requests per hour** per access token. Be mindful when making multiple calls. Prefer:
- The CLI tool for standard operations (it handles pagination internally)
- `since_date` filters to limit data volume
- `last_knowledge_of_server` for incremental/delta updates
- Batch operations where possible

### Months Format

When using the API directly, months must be in **YYYY-MM-01** format (first day of month). The CLI accepts **YYYY-MM** and normalizes automatically.

### Deleted Records

API responses include soft-deleted records (with `deleted: true`). Filter these out in results. The CLI does this automatically.

### User's Account Structure

The user's current accounts (for reference when they ask about specific accounts):
- **AF Checking** — Primary checking account (type: checking)
- **Blue Cash Amex** — American Express credit card (type: creditCard)
- **Capital One Visa** — Capital One credit card (type: creditCard)
- **Chase Travel** — Chase credit card (type: creditCard)
- **Costco Citi Card** — Citi credit card (type: creditCard)

### Spending Analysis Tips

When analyzing spending from the **AF Checking** account:
- Transfers to credit cards (e.g., "Transfer : Costco Citi Card") represent the total spent on that card — no double-counting
- Direct debits (utilities, subscriptions) are direct expenses
- Inflows (positive amounts) are income/deposits — exclude from spending totals
- Common exclusions for "regular spending" analysis: house remodel checks, one-time large payoffs
