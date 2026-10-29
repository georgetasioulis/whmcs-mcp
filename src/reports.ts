/**
 * Billing reports that combine several WHMCS calls.
 *
 * Note on statuses: WHMCS's "Overdue" invoice status is a pseudo-status, the
 * subset of Unpaid invoices past their due date. Querying both Unpaid and
 * Overdue therefore returns overdue invoices twice; these reports query Unpaid
 * and work out overdue-ness from the due date.
 */
import type { Client, ClientProduct, Invoice, InvoiceItem } from './types.js';
import { clientName, datePart, daysBetween, isoDate, listOf, mapLimit, money, recentMonths } from './util.js';
import type { WhmcsClient } from './whmcs-client.js';

type ContactInfo = { name: string; email: string; phone: string };

/** Fetches contact details once per client, a few at a time. */
async function contactsFor(whmcs: WhmcsClient, clientIds: Iterable<number>): Promise<Map<number, ContactInfo>> {
  const ids = [...new Set(clientIds)];
  const contacts = new Map<number, ContactInfo>();
  await mapLimit(ids, 5, async (clientid) => {
    try {
      const details = await whmcs.call<any>('GetClientsDetails', { clientid });
      const client = (details.client ?? details) as Client;
      contacts.set(clientid, { name: clientName(client), email: client.email ?? '', phone: client.phonenumber ?? '' });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      contacts.set(clientid, { name: `(lookup failed: ${reason})`, email: '', phone: '' });
    }
  });
  return contacts;
}

/** Invoices with the given status dated on or after `since`, newest first. */
async function invoicesSince(whmcs: WhmcsClient, status: string, since: string): Promise<Invoice[]> {
  const invoices: Invoice[] = [];
  const pageSize = 100;
  for (let offset = 0; ; offset += pageSize) {
    const page = await whmcs.call('GetInvoices', {
      status,
      limitstart: offset,
      limitnum: pageSize,
      orderby: 'date',
      order: 'desc',
    });
    const batch = listOf<Invoice>(page.invoices, 'invoice');
    for (const invoice of batch) {
      const date = datePart(invoice.date);
      if (date && date < since) return invoices;
      invoices.push(invoice);
    }
    if (batch.length < pageSize) return invoices;
  }
}

export async function findInvoiceGaps(
  whmcs: WhmcsClient,
  params: { months?: number; only_monthly_active?: boolean; include_statuses?: string[]; exclude_statuses?: string[] },
) {
  const months = params.months ?? 6;
  const expectedMonths = recentMonths(months);
  const windowStart = `${expectedMonths[0]}-01`;
  const today = isoDate();
  const excluded = new Set((params.exclude_statuses ?? ['Cancelled']).map((s) => s.toLowerCase()));
  // Overdue is a subset of Unpaid; asking for both would only fetch duplicates.
  const statuses = [...new Set(params.include_statuses ?? ['Paid', 'Unpaid'])];

  const seen = new Set<number>();
  const monthsByClient = new Map<number, { months: Set<string>; last: string | null }>();
  for (const status of statuses) {
    for (const invoice of await invoicesSince(whmcs, status, windowStart)) {
      const id = Number(invoice.id);
      const date = datePart(invoice.date);
      if (seen.has(id) || !date || excluded.has(String(invoice.status).toLowerCase())) continue;
      seen.add(id);
      const entry = monthsByClient.get(Number(invoice.userid)) ?? { months: new Set<string>(), last: null };
      entry.months.add(date.slice(0, 7));
      if (!entry.last || date > entry.last) entry.last = date;
      monthsByClient.set(Number(invoice.userid), entry);
    }
  }

  // With only_monthly_active, the clients to check are those with an active
  // monthly service, and months before their first such service don't count.
  let eligible = [...monthsByClient.keys()];
  const firstMonth = new Map<number, string>();
  if (params.only_monthly_active) {
    const services = await whmcs.fetchAll<ClientProduct>('GetClientsProducts', (page) => listOf(page.products, 'product'));
    for (const service of services) {
      if (service.status !== 'Active' || service.billingcycle !== 'Monthly') continue;
      const clientId = Number(service.clientid);
      const month = datePart(service.regdate)?.slice(0, 7) ?? expectedMonths[0];
      const current = firstMonth.get(clientId);
      if (!current || month < current) firstMonth.set(clientId, month);
    }
    eligible = [...firstMonth.keys()];
  }

  const gaps = eligible
    .map((clientId) => {
      const entry = monthsByClient.get(clientId);
      const from = firstMonth.get(clientId) ?? expectedMonths[0];
      const missing = expectedMonths.filter((month) => month >= from && !entry?.months.has(month));
      return { clientId, missing, last: entry?.last ?? null };
    })
    .filter((gap) => gap.missing.length);

  const contacts = await contactsFor(whmcs, gaps.map((gap) => gap.clientId));
  const clients = gaps.map((gap) => ({
    client_id: gap.clientId,
    ...contacts.get(gap.clientId),
    missing_months: gap.missing,
    last_invoice_date: gap.last,
  }));

  return {
    summary: {
      months,
      window_start: windowStart,
      window_end: today,
      clients_checked: eligible.length,
      clients_with_gaps: clients.length,
    },
    clients,
  };
}

export async function listClientsWithPendingInvoices(whmcs: WhmcsClient, params: { months?: number }) {
  const months = params.months ?? 6;
  const windowStart = `${recentMonths(months)[0]}-01`;
  const invoices = await invoicesSince(whmcs, 'Unpaid', windowStart);

  type Pending = { pending_invoices: number; due: number; currency: string; last_invoice_date: string | null };
  const byClient = new Map<number, Pending>();
  const totals = new Map<string, number>();

  for (const invoice of invoices) {
    const clientId = Number(invoice.userid);
    const amount = Number(invoice.balance ?? invoice.total) || 0;
    const currency = invoice.currencycode ?? '';
    const date = datePart(invoice.date);

    const entry = byClient.get(clientId) ?? { pending_invoices: 0, due: 0, currency, last_invoice_date: null };
    entry.pending_invoices += 1;
    entry.due += amount;
    if (date && (!entry.last_invoice_date || date > entry.last_invoice_date)) entry.last_invoice_date = date;
    byClient.set(clientId, entry);
    totals.set(currency, (totals.get(currency) ?? 0) + amount);
  }

  const contacts = await contactsFor(whmcs, byClient.keys());
  const clients = [...byClient].map(([clientId, entry]) => ({
    client_id: clientId,
    ...contacts.get(clientId),
    pending_invoices: entry.pending_invoices,
    total_due: money(entry.due),
    currency: entry.currency,
    last_invoice_date: entry.last_invoice_date,
  }));

  return {
    summary: {
      months,
      window_start: windowStart,
      window_end: isoDate(),
      clients_with_pending: clients.length,
      pending_invoices: invoices.length,
      total_due: Object.fromEntries([...totals].map(([currency, total]) => [currency || 'default', money(total)])),
    },
    clients: clients.sort((a, b) => Number(b.total_due) - Number(a.total_due)),
  };
}

export async function getUnpaidInvoicesDetailed(
  whmcs: WhmcsClient,
  params: { limitstart?: number; limitnum?: number; include_items?: boolean },
) {
  const limitstart = params.limitstart ?? 0;
  const page = await whmcs.call('GetInvoices', {
    status: 'Unpaid',
    orderby: 'duedate',
    order: 'asc',
    limitstart,
    limitnum: params.limitnum ?? 25,
  });
  const invoices = listOf<Invoice>(page.invoices, 'invoice');
  const contacts = await contactsFor(whmcs, invoices.map((invoice) => Number(invoice.userid)));
  const today = isoDate();

  const detailed = await mapLimit(invoices, 5, async (invoice) => {
    const clientId = Number(invoice.userid);
    const due = datePart(invoice.duedate);
    let items: Array<{ type: string; service_id: number | null; description: string; amount: string }> | undefined;
    let itemsError: string | undefined;

    if (params.include_items !== false) {
      try {
        const full = await whmcs.call<any>('GetInvoice', { invoiceid: invoice.id });
        items = listOf<InvoiceItem>(full.items, 'item').map((item) => ({
          type: item.type,
          service_id: item.type === 'Hosting' ? Number(item.relid) : null,
          description: item.description,
          amount: item.amount,
        }));
      } catch (error) {
        itemsError = error instanceof Error ? error.message : String(error);
      }
    }

    return {
      invoice_id: Number(invoice.id),
      invoice_number: invoice.invoicenum || String(invoice.id),
      client_id: clientId,
      client_name: contacts.get(clientId)?.name ?? '',
      client_email: contacts.get(clientId)?.email ?? '',
      client_phone: contacts.get(clientId)?.phone ?? '',
      date: datePart(invoice.date),
      due_date: due,
      days_overdue: due ? Math.max(0, daysBetween(due, today)) : 0,
      total: invoice.total,
      balance: invoice.balance ?? invoice.total,
      currency: invoice.currencycode ?? '',
      payment_method: invoice.paymentmethod ?? '',
      ...(items ? { items } : {}),
      ...(itemsError ? { items_error: itemsError } : {}),
    };
  });

  return { page, invoices: detailed, limitstart };
}
