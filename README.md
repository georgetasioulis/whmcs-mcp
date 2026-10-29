# WHMCS MCP Server

MCP (Model Context Protocol) server for full integration with the WHMCS API.

## Features

### Tickets and Support
- List tickets with advanced filters, including several departments or statuses at once
- View full ticket details (including replies and notes)
- Create new tickets
- Add replies to tickets
- Update ticket properties
- List support departments
- View ticket statuses with counts
- Full ticket statistics

### Clients
- List clients with filters and pagination
- View full client details (with stats)
- Find a client by email, name, company, service domain, service username or registered domain in one search

### Products and Services
- List available products/services, with pay type and the price of every enabled billing cycle
- Find every service of a set of products across all clients ("all cPanel licences"), filtered by status, billing cycle and next due date
- Re-price existing services in bulk (catalogue price, percentage, or explicit table), with a mandatory dry run and a check for unpaid invoices already issued at the old price
- Multi-currency aware: services carry their client's currency, products show every currency's prices, re-pricing matches prices to the client's currency
- Update a single service (amount, cycle, next due date, status)
- See failed module actions (the module queue) with their last error, and retry one
- List orders with filters

### Invoices
- List invoices with filters and sorting, and view one invoice with its line items
- Unpaid invoices with client contact details, days overdue and line items
- Clients with pending invoices; months with no invoice per client
- Quotes, and payment transactions per invoice, client or gateway transaction ID

### General
- Read-only mode, backup confirmation before every write, and a local audit log (see [Safety](#safety-protecting-a-live-whmcs))
- Secure authentication via API credentials
- Fully typed with TypeScript
- 43 MCP tools, each with a single Zod schema that drives validation and the advertised JSON schema
- Automatic XML retry when WHMCS cannot encode a JSON response (see below)

### WHMCS JSON encoder workaround

Some installations hold records with bytes that are not valid UTF-8. WHMCS then
answers any call touching those records with:

```
Error generating JSON encoded response: Malformed UTF-8 characters, possibly incorrectly encoded
```

This makes endpoints like `GetClientsProducts` permanently unusable. WHMCS has
no such problem serving XML, so this server retries the same call as XML and
parses it into the same shape — the tool succeeds and the caller sees no
difference.

## Available Tools (43)

### Tickets and Support
- **whmcs_get_tickets** - List tickets with filters
- **whmcs_get_ticket** - View a ticket with all replies and notes
- **whmcs_get_ticket_counts** - Ticket statistics and counts
- **whmcs_open_ticket** - Create a ticket
- **whmcs_add_ticket_reply** - Reply to a ticket
- **whmcs_update_ticket** - Update ticket properties
- **whmcs_get_support_departments** - List departments
- **whmcs_get_support_statuses** - Statuses with counts

### Clients
- **whmcs_get_clients** - List clients
- **whmcs_find_client** - Find clients by email, name, company, domain or service username
- **whmcs_get_clients_details** - Full client details
- **whmcs_get_clients_domains** - Client domains
- **whmcs_get_contacts** - Client contacts
- **whmcs_get_emails** - Email history

### Products and Services
- **whmcs_get_products** - Product catalogue with pay type and per-cycle pricing
- **whmcs_get_clients_products** - Raw page of client services by client, service, product or domain
- **whmcs_list_services** - Every service of a set of products across all clients
- **whmcs_reprice_services** - Bulk re-price services (dry run first, then apply with a confirmed count)
- **whmcs_update_client_product** - Update one service
- **whmcs_module_suspend** / **whmcs_module_unsuspend** / **whmcs_module_terminate** / **whmcs_module_create** - Module commands
- **whmcs_get_module_queue** - Failed module actions waiting for a retry
- **whmcs_retry_module_action** - Retry one failed module action

### Orders
- **whmcs_get_orders** - List orders
- **whmcs_accept_order** / **whmcs_cancel_order** / **whmcs_delete_order** / **whmcs_pending_order**

### Billing
- **whmcs_get_invoices** - List invoices
- **whmcs_get_invoice** - One invoice with line items
- **whmcs_get_unpaid_invoices_detailed** - Unpaid invoices with contacts, days overdue and line items
- **whmcs_find_invoice_gaps** - Months with no invoice per client
- **whmcs_list_clients_with_pending_invoices** - Clients with unpaid invoices and amount due
- **whmcs_get_quotes** - List quotes or get one
- **whmcs_get_transactions** - Payment transactions by invoice, client or transaction ID

### System
- **whmcs_check_connection** - Check credentials and IP whitelisting
- **whmcs_get_activity_log** - Activity log
- **whmcs_get_stats** - Revenue, orders and ticket statistics
- **whmcs_get_currencies** - Configured currencies
- **whmcs_get_payment_methods** - Active payment gateways
- **whmcs_get_admin_users** - Admin users

## Quick Install

### Claude Code (one command)

```bash
claude mcp add whmcs \
  -e WHMCS_API_URL=https://your-whmcs.com/includes/api.php \
  -e WHMCS_IDENTIFIER=your_identifier \
  -e WHMCS_SECRET=your_secret \
  -- npx -y whmcs-mcp
```

Or with admin credentials instead of API keys:

```bash
claude mcp add whmcs \
  -e WHMCS_API_URL=https://your-whmcs.com/includes/api.php \
  -e WHMCS_USERNAME=your_admin_user \
  -e WHMCS_PASSWORD=your_admin_password \
  -- npx -y whmcs-mcp
```

That's it. Run `claude mcp list` to verify.

### Claude Desktop

Add to your `claude_desktop_config.json` ([location by OS](https://modelcontextprotocol.io/quickstart/user)):

```json
{
  "mcpServers": {
    "whmcs": {
      "command": "npx",
      "args": ["-y", "whmcs-mcp"],
      "env": {
        "WHMCS_API_URL": "https://your-whmcs.com/includes/api.php",
        "WHMCS_IDENTIFIER": "your_identifier",
        "WHMCS_SECRET": "your_secret"
      }
    }
  }
}
```

Restart Claude Desktop and the 34 tools will be available.

### Alternative: mcp.json file

If you prefer a config file instead of env vars, create `mcp.json` in the project root:

```bash
cp mcp.example.json mcp.json
# edit mcp.json with your credentials
```

When using admin credentials with `username`/`password`, the server automatically hashes the password with MD5 (WHMCS requirement). You can also provide an already MD5-hashed password.

### Adding credentials later

If you already added the MCP server but didn't have the credentials yet:

**Claude Code:** run `claude mcp add whmcs ...` again with the `-e` flags -- it overwrites the previous entry.

**Claude Desktop:** open `claude_desktop_config.json` and add the `env` block to the existing `whmcs` entry:

```json
"env": {
  "WHMCS_API_URL": "https://your-whmcs.com/includes/api.php",
  "WHMCS_IDENTIFIER": "your_identifier",
  "WHMCS_SECRET": "your_secret"
}
```

Then restart Claude Desktop.

## Safety: protecting a live WHMCS

Reading is always allowed. Every tool that changes something asks the user to
confirm they have a backup before it runs; and three settings control how far
the server can go. Set them as env vars (or the camelCase keys in the `whmcs`
block of `mcp.json`):

| Env var | Default | Effect |
| --- | --- | --- |
| `WHMCS_READ_ONLY` | `false` | `true`: write tools are not offered at all, and the HTTP client refuses any API action that is not a `Get*` read. The re-pricing dry run stays available. |
| `WHMCS_CONFIRM_WRITES` | `true` | `false`: writes run without asking. Only for unattended use. |
| `WHMCS_AUDIT_LOG` | `~/.whmcs-mcp/audit.jsonl` | Where every confirmed write is recorded (tool, arguments with passwords redacted, how it was confirmed, outcome). `off` disables it. |

**How a write is confirmed**, strongest first:

1. **Elicitation.** If the MCP client supports it, the server asks *you*
   directly in the client UI: "This is going to change data in your WHMCS
   installation. Please confirm you have a current backup", with what will
   change. The model never sees or answers this prompt.
2. **Two-step token.** Otherwise the first call changes nothing and returns
   the warning plus a single-use token, bound to those exact arguments and
   valid for 10 minutes. The change runs only when the call is repeated with
   it. This relies on the model stopping to ask you, so treat it as a speed
   bump, not a lock.

**Credentials stay out of the chat.** WHMCS returns each service's account
password in `GetClientsProducts`; every tool replaces password fields with
`[hidden]` before the response reaches the model.

For a hard guarantee, also limit what the credentials can do on the WHMCS side:
give the API credential a role with only the read permissions you need
(Configuration > System Settings > Manage API Credentials > API Roles), and keep
a second, write-capable credential for the occasional change. Run with
`WHMCS_READ_ONLY=true` by default and switch it off only for a change session.

## Usage Examples

In Claude Code, you can ask questions like:

**Tickets:**
- "List the last 10 open tickets"
- "Show details for ticket #123456"
- "How many tickets are awaiting response?"
- "Which support departments are available?"

**Clients:**
- "List the last 5 active clients"
- "Show details for client ID 123"
- "How many clients do we have total?"

**Products:**
- "List all available products"
- "Which products are in group 5?"
- "How much does product 42 cost per month and per year?"
- "Which services of client 123 renew monthly, and for how much?"

Responses are markdown tables by default, with every field also available in
`structuredContent`. Ask for `response_format: "json"` when you need those
fields inline, and `include_full_details: true` on `whmcs_get_products` when you
need the description HTML, config options, and custom fields.

**Orders and Invoices:**
- "List the last 10 orders"
- "Show overdue invoices"

**Services and re-pricing:**
- "List all cPanel licence services" (selects products by module, e.g. `module: "manage2"`, or by name)
- "Which customers pay yearly for CloudLinux, and when do they renew?"
- "Set every annual cPanel licence to the current catalogue price" — runs a dry run, shows the old and new amount per service and any unpaid invoice already issued at the old price; nothing changes until you confirm
- "Raise all monthly cPanel licences by 8%, rounded to 0.50"

### How re-pricing works

Changing a product's price in the WHMCS catalogue only affects new orders.
Every existing service keeps its own recurring amount, and the cron bills each
renewal from that amount when it generates the invoice (the configured number
of days before the due date). `whmcs_reprice_services` updates those amounts:

1. **Select** services like `whmcs_list_services` does: products by `pids`,
   `gid`, `module` or `name_contains`, then `statuses` (default Active and
   Suspended), `billing_cycles`, `next_due_from`/`next_due_to`, client
   includes/excludes.
2. **Price** them with one of three modes:
   - `catalog`: the product's current catalogue price for the service's cycle
     and the client's currency. Update the catalogue first. Overwrites custom
     per-client prices; configurable option prices are not added.
   - `percent`: scale the current amount (keeps discounts proportional), with
     optional `round_to`.
   - `table`: explicit `{ pid, billing_cycle, amount, currency? }` rows.
3. **Dry run** (the default) returns the plan, the skipped services with
   reasons, and unpaid invoices that already bill those services.
4. **Apply** with `apply: true` and `confirm_changes` set to the number of
   planned updates; the call aborts if the plan changed in between. Add
   `update_unpaid_invoices: true` to also re-price unpaid invoice lines that
   bill exactly the old amount (others are reported, not touched).

## Technologies

- TypeScript
- MCP SDK (@modelcontextprotocol/sdk) with Zod schemas
- Native `fetch` (no HTTP client dependency)
- WHMCS API v1

## Project Structure

```
whmcs-mcp/
├── src/
│   ├── index.ts        # Entry point: config, client, stdio transport
│   ├── server.ts       # Builds the McpServer and registers every tool
│   ├── tool.ts         # defineTool(): response_format, markdown/JSON rendering, write gating, errors
│   ├── safety.ts       # Read-only mode, write confirmation (elicitation / token), audit log
│   ├── tools/          # Tool definitions per area (tickets, clients, services, orders, billing, system)
│   ├── whmcs-client.ts # Transport: auth, form POST, pagination, XML retry
│   ├── services.ts     # Product selection and cross-client service lookup
│   ├── repricing.ts    # Re-pricing plan, apply, and unpaid invoice handling
│   ├── reports.ts      # Invoice gap, pending client and unpaid invoice reports
│   ├── products.ts     # Pricing formatting, billing cycles, payload slimming
│   ├── config.ts       # Config loader (env vars → mcp.json)
│   ├── xml.ts          # XML fallback parser for the WHMCS JSON encoder bug
│   ├── util.ts         # Dates, concurrency, list helpers
│   └── types.ts        # The WHMCS fields the code reads
├── test/               # node:test suites, including end-to-end MCP calls against a fake WHMCS
└── package.json
```

## Development

```bash
# Watch mode (auto rebuild)
npm run dev

# Manual build
npm run build

# Run the MCP server with the default mcp.json
node build/index.js

# Run with a custom config path
node build/index.js --config /absolute/path/mcp.json

# Build and run the tests
npm test

# Call the API directly
node -e "import('./build/whmcs-client.js').then(async ({WhmcsClient}) => { ... })"
```

## Requirements

- Node.js >= 20
- WHMCS account with API enabled
- WHMCS API Identifier and Secret
- IP authorized in the WHMCS API

## License

MIT

## Author

Built for WHMCS integration via Model Context Protocol.
