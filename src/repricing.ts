/**
 * Bulk re-pricing of existing client services.
 *
 * Changing a product's catalogue price in WHMCS only affects new orders: every
 * existing service keeps its own recurring amount, which is what the next
 * renewal invoice bills. This module plans a new recurring amount per service,
 * applies it with UpdateClientProduct, and finds unpaid invoices that were
 * already generated at the old amount.
 */
import { z } from 'zod';
import { catalogPrice, pricingKeyForCycle, SERVICE_BILLING_CYCLES } from './products.js';
import type { ServiceRow } from './services.js';
import type { Invoice, InvoiceItem, Product } from './types.js';
import { listOf, mapLimit, money } from './util.js';
import type { WhmcsClient } from './whmcs-client.js';

export const pricingSchema = z.discriminatedUnion('mode', [
  z
    .object({ mode: z.literal('catalog') })
    .describe(
      "Set each service to its product's current catalogue price for the service's billing cycle and the client's currency. " +
        'Overwrites per-client custom prices; configurable option prices are not added.',
    ),
  z
    .object({
      mode: z.literal('percent'),
      percent: z.number().gt(-100).describe('Change in percent, e.g. 12.5 for +12.5% or -10 for a 10% cut'),
      round_to: z.number().positive().default(0.01).describe('Round the result to a multiple of this (default 0.01)'),
    })
    .describe("Scale each service's current recurring amount. Keeps per-client discounts proportional."),
  z
    .object({
      mode: z.literal('table'),
      prices: z
        .array(
          z.object({
            pid: z.number().int().positive(),
            billing_cycle: z.enum(SERVICE_BILLING_CYCLES),
            amount: z.number().min(0),
            currency: z
              .string()
              .min(1)
              .optional()
              .describe('Currency code; required when WHMCS has more than one currency'),
          }),
        )
        .min(1),
    })
    .describe('Set explicit new amounts per product and billing cycle. Services with no matching row are skipped.'),
]);

export type PricingRule = z.infer<typeof pricingSchema>;

export type PlannedChange = ServiceRow & {
  new_amount: number | null;
  change_percent: number | null;
  action: 'update' | 'skip';
  reason?: string;
  warning?: string;
};

function roundTo(value: number, step: number): number {
  return Number((Math.round(value / step) * step).toFixed(2));
}

/** Decides the new recurring amount for each service. Pure, so it can be previewed and tested. */
export function planRepricing(
  services: ServiceRow[],
  catalogue: Map<number, Product>,
  pricing: PricingRule,
  multipleCurrencies: boolean,
): PlannedChange[] {
  return services.map((service) => {
    const { currency } = service;
    const skip = (reason: string): PlannedChange => ({
      ...service,
      currency,
      new_amount: null,
      change_percent: null,
      action: 'skip',
      reason,
    });

    if (!pricingKeyForCycle(service.billingcycle)) {
      return skip(`billing cycle "${service.billingcycle}" does not recur`);
    }

    let target: number | undefined;
    let warning: string | undefined;

    switch (pricing.mode) {
      case 'percent': {
        if (service.recurringamount <= 0) return skip('free service (recurring amount 0)');
        target = roundTo(service.recurringamount * (1 + pricing.percent / 100), pricing.round_to);
        break;
      }
      case 'catalog': {
        if (!currency) return skip('client currency unknown');
        target = catalogPrice(catalogue.get(service.pid)?.pricing, currency, service.billingcycle);
        if (target === undefined) return skip(`product has no ${service.billingcycle} price in ${currency}`);
        if (service.has_config_options) warning = 'has configurable options; their prices are not included';
        break;
      }
      case 'table': {
        const cycle = service.billingcycle.toLowerCase();
        const candidates = pricing.prices.filter(
          (row) => row.pid === service.pid && row.billing_cycle.toLowerCase() === cycle,
        );
        if (!candidates.length) return skip(`no price given for this product on ${service.billingcycle}`);
        const rule =
          candidates.find((row) => row.currency && row.currency.toUpperCase() === currency?.toUpperCase()) ??
          (multipleCurrencies ? undefined : candidates.find((row) => !row.currency));
        if (!rule) {
          return skip(
            multipleCurrencies
              ? `no price given in the client's currency (${currency ?? 'unknown'})`
              : `no price given in ${currency}`,
          );
        }
        target = rule.amount;
        break;
      }
    }

    if (Math.abs(target - service.recurringamount) < 0.005) {
      return { ...skip('already at the target price'), new_amount: target, change_percent: 0 };
    }

    return {
      ...service,
      currency,
      new_amount: target,
      change_percent:
        service.recurringamount > 0
          ? Number((((target - service.recurringamount) / service.recurringamount) * 100).toFixed(2))
          : null,
      action: 'update',
      ...(warning ? { warning } : {}),
    };
  });
}

export type InvoiceLine = {
  invoiceid: number;
  invoicenum: string;
  clientid: number;
  serviceid: number;
  itemid: number;
  description: string;
  amount: number;
  taxed: boolean;
  duedate: string;
};

/**
 * Unpaid invoice lines that bill any of `serviceIds`. These were generated
 * before the price change and still carry the old amount.
 */
export async function findUnpaidServiceLines(
  whmcs: WhmcsClient,
  clientIds: number[],
  serviceIds: Set<number>,
): Promise<InvoiceLine[]> {
  const perClient = await mapLimit(clientIds, 4, async (userid) => {
    const invoices = await whmcs.fetchAll<Invoice>(
      'GetInvoices',
      (page) => listOf(page.invoices, 'invoice'),
      { userid, status: 'Unpaid' },
      100,
    );
    const lines: InvoiceLine[] = [];
    for (const invoice of invoices) {
      const full = await whmcs.call<any>('GetInvoice', { invoiceid: invoice.id });
      for (const item of listOf<InvoiceItem>(full.items, 'item')) {
        if (item.type !== 'Hosting' || !serviceIds.has(Number(item.relid))) continue;
        lines.push({
          invoiceid: Number(invoice.id),
          invoicenum: String(invoice.invoicenum || invoice.id),
          clientid: userid,
          serviceid: Number(item.relid),
          itemid: Number(item.id),
          description: String(item.description ?? ''),
          amount: Number(item.amount) || 0,
          taxed: Number(item.taxed) === 1,
          duedate: String(invoice.duedate ?? ''),
        });
      }
    }
    return lines;
  });
  return perClient.flat();
}

export type ApplyResult = {
  serviceid: number;
  ok: boolean;
  error?: string;
};

export async function applyRepricing(whmcs: WhmcsClient, changes: PlannedChange[]): Promise<ApplyResult[]> {
  // Sequential on purpose: these are billing writes, and a failure part-way
  // should leave a short, ordered trail rather than a burst of parallel errors.
  const results: ApplyResult[] = [];
  for (const change of changes) {
    try {
      await whmcs.call('UpdateClientProduct', {
        serviceid: change.serviceid,
        recurringamount: money(change.new_amount ?? change.recurringamount),
      });
      results.push({ serviceid: change.serviceid, ok: true });
    } catch (error) {
      results.push({ serviceid: change.serviceid, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

export type InvoiceUpdate = InvoiceLine & {
  new_amount: number | null;
  action: 'updated' | 'left unchanged' | 'failed';
  reason?: string;
};

/**
 * Re-prices unpaid invoice lines of services that were just re-priced. A line
 * is only touched when it bills exactly the old recurring amount; anything else
 * (prorated, discounted, bundled options) is reported for a manual look.
 */
export async function updateUnpaidLines(
  whmcs: WhmcsClient,
  lines: InvoiceLine[],
  changes: Map<number, PlannedChange>,
): Promise<InvoiceUpdate[]> {
  const outcomes: InvoiceUpdate[] = [];
  const byInvoice = new Map<number, InvoiceUpdate[]>();

  for (const line of lines) {
    const change = changes.get(line.serviceid);
    if (!change || change.new_amount === null) {
      outcomes.push({ ...line, new_amount: null, action: 'left unchanged', reason: 'service was not re-priced' });
      continue;
    }
    if (Math.abs(line.amount - change.recurringamount) >= 0.005) {
      outcomes.push({
        ...line,
        new_amount: change.new_amount,
        action: 'left unchanged',
        reason: `line amount ${money(line.amount)} is not the old recurring amount ${money(change.recurringamount)}`,
      });
      continue;
    }
    const outcome: InvoiceUpdate = { ...line, new_amount: change.new_amount, action: 'updated' };
    outcomes.push(outcome);
    byInvoice.set(line.invoiceid, [...(byInvoice.get(line.invoiceid) ?? []), outcome]);
  }

  for (const [invoiceid, items] of byInvoice) {
    // UpdateInvoice rewrites description, amount and taxed together for every
    // line it is given, so all three are sent back for each edited line.
    const params: Record<string, string | number> = { invoiceid };
    for (const item of items) {
      params[`itemdescription[${item.itemid}]`] = item.description;
      params[`itemamount[${item.itemid}]`] = money(item.new_amount ?? item.amount);
      params[`itemtaxed[${item.itemid}]`] = item.taxed ? 1 : 0;
    }
    try {
      await whmcs.call('UpdateInvoice', params);
    } catch (error) {
      for (const item of items) {
        item.action = 'failed';
        item.reason = error instanceof Error ? error.message : String(error);
      }
    }
  }

  return outcomes;
}
