import { z } from 'zod';
import { findInvoiceGaps, getUnpaidInvoicesDetailed, listClientsWithPendingInvoices } from '../reports.js';
import { defineTool, type ToolHost, paginate, READ_ONLY } from '../tool.js';
import { listOf } from '../util.js';
import type { WhmcsClient } from '../whmcs-client.js';
import { zId, zLimit, zOffset, zText } from './schemas.js';

const zMonths = z.number().int().min(1).max(24).optional().describe('Months to look back, including this one (default: 6)');

export function registerBillingTools(host: ToolHost, whmcs: WhmcsClient): void {
  defineTool(
    host,
    'whmcs_get_invoices',
    {
      title: 'List Invoices',
      description:
        'List invoices with filters and sorting. Paginated. Status "Overdue" is the subset of Unpaid past its due date.',
      input: {
        limitstart: zOffset,
        limitnum: zLimit(25),
        userid: zId.optional().describe('Client ID'),
        status: zText.optional().describe('Paid, Unpaid, Overdue, Cancelled, Refunded, Collections, Draft...'),
        orderby: z.enum(['id', 'invoicenumber', 'date', 'duedate', 'total', 'status']).optional(),
        order: z.enum(['asc', 'desc']).optional(),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      const result = await whmcs.call('GetInvoices', args);
      const invoices = listOf<any>(result.invoices, 'invoice');
      return {
        data: result,
        pagination: paginate(result, invoices.length, args.limitstart),
        tables: [
          {
            headers: ['ID', 'Number', 'Client ID', 'Status', 'Total', 'Currency', 'Date', 'Due Date'],
            rows: invoices.map((i) => [i.id, i.invoicenum, i.userid, i.status, i.total, i.currencycode, i.date, i.duedate]),
          },
        ],
      };
    },
  );

  defineTool(
    host,
    'whmcs_get_invoice',
    {
      title: 'Get Invoice',
      description: 'Get one invoice with its line items, transactions and totals.',
      input: { invoiceid: zId },
      annotations: READ_ONLY,
    },
    async (args) => {
      const result = await whmcs.call('GetInvoice', args);
      const items = listOf<any>(result.items, 'item');
      return {
        data: result,
        summary: [
          `Invoice ${result.invoicenum || result.invoiceid} for client ${result.userid}: ${result.status}, ` +
            `total ${result.total}, balance ${result.balance}, due ${result.duedate}.`,
        ],
        tables: [
          {
            headers: ['Item ID', 'Type', 'Related ID', 'Description', 'Amount', 'Taxed'],
            rows: items.map((i) => [i.id, i.type, i.relid, i.description, i.amount, i.taxed]),
          },
        ],
      };
    },
  );

  defineTool(
    host,
    'whmcs_get_unpaid_invoices_detailed',
    {
      title: 'Unpaid Invoices (Detailed)',
      description:
        'Unpaid invoices (overdue included), oldest due first, with client name, email, phone, days overdue and ' +
        'the invoice line items. Paginated.',
      input: {
        limitstart: zOffset,
        limitnum: zLimit(25, 100),
        include_items: z.boolean().optional().describe('Fetch line items for each invoice (default: true)'),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      const { page, invoices, limitstart } = await getUnpaidInvoicesDetailed(whmcs, args);
      return {
        data: { invoices },
        pagination: paginate(page, invoices.length, limitstart),
        tables: [
          {
            headers: ['Invoice', 'Client', 'Email', 'Phone', 'Due', 'Days Overdue', 'Balance', 'Items'],
            rows: invoices.map((i) => [
              i.invoice_number,
              i.client_name,
              i.client_email,
              i.client_phone,
              i.due_date,
              i.days_overdue,
              `${i.balance} ${i.currency}`.trim(),
              i.items?.map((item) => item.description.split('\n')[0]).join('; ') ?? i.items_error ?? '',
            ]),
          },
        ],
      };
    },
  );

  defineTool(
    host,
    'whmcs_find_invoice_gaps',
    {
      title: 'Find Invoice Gaps',
      description:
        'Find months with no invoice per client over a recent window. With only_monthly_active, checks clients with an ' +
        'active monthly service, from the month that service started.',
      input: {
        months: zMonths,
        only_monthly_active: z.boolean().optional(),
        include_statuses: z.array(zText).optional().describe('Invoice statuses that count (default: Paid, Unpaid)'),
        exclude_statuses: z.array(zText).optional().describe('Invoice statuses that do not count (default: Cancelled)'),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      const result = await findInvoiceGaps(whmcs, args);
      const { summary } = result;
      return {
        data: result,
        summary: [
          `Window ${summary.window_start} to ${summary.window_end} (${summary.months} months). ` +
            `${summary.clients_with_gaps} of ${summary.clients_checked} clients have gaps.`,
        ],
        tables: [
          {
            headers: ['Client ID', 'Name', 'Email', 'Phone', 'Missing Months', 'Last Invoice'],
            rows: result.clients.map((c) => [c.client_id, c.name, c.email, c.phone, c.missing_months.join(', '), c.last_invoice_date]),
          },
        ],
      };
    },
  );

  defineTool(
    host,
    'whmcs_list_clients_with_pending_invoices',
    {
      title: 'Clients With Pending Invoices',
      description: 'Clients with unpaid invoices dated within a recent window, with contact info and amount due.',
      input: { months: zMonths },
      annotations: READ_ONLY,
    },
    async (args) => {
      const result = await listClientsWithPendingInvoices(whmcs, args);
      const { summary } = result;
      const totals = Object.entries(summary.total_due).map(([currency, total]) => `${total} ${currency}`);
      return {
        data: result,
        summary: [
          `Window ${summary.window_start} to ${summary.window_end}. ${summary.clients_with_pending} client(s), ` +
            `${summary.pending_invoices} unpaid invoice(s), due: ${totals.join(', ') || '0.00'}.`,
        ],
        tables: [
          {
            headers: ['Client ID', 'Name', 'Email', 'Phone', 'Pending', 'Total Due', 'Last Invoice'],
            rows: result.clients.map((c) => [
              c.client_id,
              c.name,
              c.email,
              c.phone,
              c.pending_invoices,
              `${c.total_due} ${c.currency}`.trim(),
              c.last_invoice_date,
            ]),
          },
        ],
      };
    },
  );

  defineTool(
    host,
    'whmcs_get_quotes',
    {
      title: 'List Quotes',
      description: 'List quotes, or get one by quoteid with its line items. Filter by client, stage or subject. Paginated.',
      input: {
        limitstart: zOffset,
        limitnum: zLimit(25),
        quoteid: zId.optional(),
        userid: zId.optional().describe('Client ID'),
        stage: z.enum(['Draft', 'Delivered', 'On Hold', 'Accepted', 'Lost', 'Dead']).optional(),
        subject: zText.optional(),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      const result = await whmcs.call('GetQuotes', args);
      const quotes = listOf<any>(result.quotes, 'quote');
      return {
        data: result,
        pagination: paginate(result, quotes.length, args.limitstart),
        tables: [
          {
            headers: ['ID', 'Client ID', 'Subject', 'Stage', 'Total', 'Created', 'Valid Until'],
            rows: quotes.map((q) => [q.id, q.userid, q.subject, q.stage, q.total, q.datecreated, q.validuntil]),
          },
        ],
      };
    },
  );

  defineTool(
    host,
    'whmcs_get_transactions',
    {
      title: 'List Transactions',
      description:
        'Payment transactions (money in, fees, refunds) for an invoice, a client, or one gateway transaction ID. Give at least one filter.',
      input: {
        invoiceid: zId.optional(),
        clientid: zId.optional(),
        transid: zText.optional().describe('Gateway transaction ID'),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      if (!args.invoiceid && !args.clientid && !args.transid) {
        throw new Error('Give invoiceid, clientid or transid; listing every transaction is not supported');
      }
      const result = await whmcs.call('GetTransactions', args);
      const transactions = listOf<any>(result.transactions, 'transaction');
      return {
        data: result,
        tables: [
          {
            headers: ['ID', 'Date', 'Client ID', 'Invoice', 'Gateway', 'Transaction ID', 'In', 'Fees', 'Out', 'Description'],
            rows: transactions.map((t) => [
              t.id,
              t.date,
              t.userid,
              t.invoiceid,
              t.gateway,
              t.transid,
              t.amountin,
              t.fees,
              t.amountout,
              t.description,
            ]),
          },
        ],
      };
    },
  );
}
