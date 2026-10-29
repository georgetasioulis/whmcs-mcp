/**
 * Finding client services across every client by the product they belong to.
 *
 * WHMCS can only filter GetClientsProducts by one product id at a time, and
 * "all my cPanel licences" is usually a dozen products (monthly, yearly,
 * fixed, legacy hidden ones...). So products are selected from the catalogue
 * first, then each product's services are fetched and filtered locally.
 */
import { z } from 'zod';
import { SERVICE_BILLING_CYCLES } from './products.js';
import type { Client, ClientProduct, Product } from './types.js';
import { clientName, datePart, listOf, mapLimit } from './util.js';
import type { WhmcsClient } from './whmcs-client.js';

export const SERVICE_STATUSES = [
  'Pending',
  'Active',
  'Suspended',
  'Terminated',
  'Cancelled',
  'Fraud',
  'Completed',
] as const;

const DEFAULT_STATUSES = ['Active', 'Suspended'];

const zId = z.number().int().positive();
const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

export const productSelectorShape = {
  pids: z.array(zId).optional().describe('Product IDs to include'),
  gid: zId.optional().describe('Only products in this product group ID'),
  module: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Case-insensitive substring of the product\'s provisioning module, e.g. "manage2" for cPanel Manage2 licences. ' +
        'Note that "cpanel" alone also matches cPanel hosting products.',
    ),
  name_contains: z
    .array(z.string().min(1))
    .optional()
    .describe('Keep products whose name contains any of these (case-insensitive), e.g. ["cPanel", "CloudLinux"]'),
  exclude_pids: z.array(zId).optional().describe('Product IDs to leave out even if they match'),
};

export const serviceFilterShape = {
  statuses: z
    .array(z.enum(SERVICE_STATUSES))
    .optional()
    .describe('Service statuses to include (default: Active, Suspended)'),
  billing_cycles: z
    .array(z.enum(SERVICE_BILLING_CYCLES))
    .optional()
    .describe('Only services on these billing cycles, e.g. ["Annually"]'),
  next_due_from: zDate.optional().describe('Only services whose next due date is on or after this date (YYYY-MM-DD)'),
  next_due_to: zDate.optional().describe('Only services whose next due date is on or before this date (YYYY-MM-DD)'),
  clientids: z.array(zId).optional().describe('Only services of these clients'),
  exclude_clientids: z.array(zId).optional().describe('Leave out services of these clients'),
  exclude_serviceids: z.array(zId).optional().describe('Leave out these services'),
};

const selectorSchema = z.object({ ...productSelectorShape, ...serviceFilterShape });
export type ServiceSelector = z.infer<typeof selectorSchema>;

export type ProductSummary = { pid: number; name: string; group_id: number; module: string; paytype: string };

export type ServiceRow = {
  serviceid: number;
  clientid: number;
  client: string;
  pid: number;
  product: string;
  domain: string;
  billingcycle: string;
  recurringamount: number;
  nextduedate: string | null;
  status: string;
  regdate: string | null;
  paymentmethod: string;
  has_config_options: boolean;
  /** The client's currency code; null if it could not be looked up. */
  currency: string | null;
};

/**
 * Resolves client currencies. With a single currency configured every client
 * uses it, so no per-client lookups are needed.
 */
export async function lookupCurrencies(
  whmcs: WhmcsClient,
  clientIds: number[],
): Promise<{ of(clientId: number): string | undefined; multiple: boolean }> {
  const configured = listOf<{ code: string }>((await whmcs.call('GetCurrencies')).currencies, 'currency');
  if (configured.length <= 1) {
    const code = configured[0]?.code;
    return { of: () => code, multiple: false };
  }

  const codes = new Map<number, string>();
  await mapLimit(clientIds, 5, async (clientid) => {
    const details = await whmcs.call<any>('GetClientsDetails', { clientid });
    const code = (details.client as Client | undefined)?.currency_code ?? details.currency_code;
    if (code) codes.set(clientid, String(code));
  });
  return { of: (clientId) => codes.get(clientId), multiple: true };
}

export function matchProducts(products: Product[], selector: ServiceSelector): Product[] {
  const { pids, gid, module, name_contains: names, exclude_pids: excluded } = selector;
  if (!pids?.length && gid === undefined && !module && !names?.length) {
    throw new Error('Select products with at least one of: pids, gid, module, name_contains');
  }

  return products.filter((product) => {
    const pid = Number(product.pid);
    if (excluded?.includes(pid)) return false;
    if (pids?.length && !pids.includes(pid)) return false;
    if (gid !== undefined && Number(product.gid) !== gid) return false;
    if (module && !String(product.module ?? '').toLowerCase().includes(module.toLowerCase())) return false;
    if (names?.length) {
      const name = String(product.name ?? '').toLowerCase();
      if (!names.some((needle) => name.includes(needle.toLowerCase()))) return false;
    }
    return true;
  });
}

export function filterServices(services: ClientProduct[], pids: Set<number>, selector: ServiceSelector): ClientProduct[] {
  const statuses = new Set((selector.statuses ?? DEFAULT_STATUSES).map((s) => s.toLowerCase()));
  const cycles = selector.billing_cycles && new Set(selector.billing_cycles.map((c) => c.toLowerCase()));

  return services.filter((service) => {
    const clientId = Number(service.clientid);
    const due = datePart(service.nextduedate);
    if (!pids.has(Number(service.pid))) return false;
    if (!statuses.has(String(service.status).toLowerCase())) return false;
    if (cycles && !cycles.has(String(service.billingcycle).toLowerCase())) return false;
    if (selector.next_due_from && (!due || due < selector.next_due_from)) return false;
    if (selector.next_due_to && (!due || due > selector.next_due_to)) return false;
    if (selector.clientids?.length && !selector.clientids.includes(clientId)) return false;
    if (selector.exclude_clientids?.includes(clientId)) return false;
    if (selector.exclude_serviceids?.includes(Number(service.id))) return false;
    return true;
  });
}

export async function findServices(
  whmcs: WhmcsClient,
  selector: ServiceSelector,
): Promise<{
  products: ProductSummary[];
  services: ServiceRow[];
  catalogue: Map<number, Product>;
  multipleCurrencies: boolean;
}> {
  const catalogue = listOf<Product>((await whmcs.call('GetProducts')).products, 'product');
  const matched = matchProducts(catalogue, selector);
  const pids = new Set(matched.map((product) => Number(product.pid)));

  const perProduct = await mapLimit([...pids], 4, (pid) =>
    whmcs.fetchAll<ClientProduct>('GetClientsProducts', (page) => listOf(page.products, 'product'), { pid }),
  );
  const services = filterServices(perProduct.flat(), pids, selector);

  const names = new Map<number, string>();
  let currencies: Awaited<ReturnType<typeof lookupCurrencies>> = { of: () => undefined, multiple: false };
  if (services.length) {
    const clients = await whmcs.fetchAll<Client>('GetClients', (page) => listOf(page.clients, 'client'));
    for (const client of clients) names.set(Number(client.id), clientName(client));
    currencies = await lookupCurrencies(whmcs, [...new Set(services.map((s) => Number(s.clientid)))]);
  }

  const rows = services
    .map((service): ServiceRow => ({
      serviceid: Number(service.id),
      clientid: Number(service.clientid),
      client: names.get(Number(service.clientid)) ?? '',
      pid: Number(service.pid),
      product: String(service.name ?? '').trim(),
      domain: String(service.domain ?? ''),
      billingcycle: String(service.billingcycle),
      recurringamount: Number(service.recurringamount) || 0,
      nextduedate: datePart(service.nextduedate),
      status: String(service.status),
      regdate: datePart(service.regdate),
      paymentmethod: String(service.paymentmethod ?? ''),
      has_config_options: listOf(service.configoptions, 'configoption').length > 0,
      currency: currencies.of(Number(service.clientid)) ?? null,
    }))
    .sort((a, b) => a.product.localeCompare(b.product) || a.client.localeCompare(b.client) || a.serviceid - b.serviceid);

  return {
    products: matched.map((product) => ({
      pid: Number(product.pid),
      name: String(product.name ?? '').trim(),
      group_id: Number(product.gid),
      module: String(product.module ?? ''),
      paytype: String(product.paytype ?? ''),
    })),
    services: rows,
    catalogue: new Map(matched.map((product) => [Number(product.pid), product])),
    multipleCurrencies: currencies.multiple,
  };
}

export type ServiceCount = { product: string; billingcycle: string; currency: string | null; services: number; recurring_total: string };

/** Service counts and recurring totals per product, billing cycle and currency. */
export function countByProductAndCycle(services: ServiceRow[]): ServiceCount[] {
  const counts = new Map<string, { product: string; billingcycle: string; currency: string | null; services: number; total: number }>();
  for (const service of services) {
    const key = `${service.pid}|${service.billingcycle}|${service.currency}`;
    const entry = counts.get(key) ?? {
      product: service.product,
      billingcycle: service.billingcycle,
      currency: service.currency,
      services: 0,
      total: 0,
    };
    entry.services += 1;
    entry.total += service.recurringamount;
    counts.set(key, entry);
  }
  return [...counts.values()].map(({ total, ...entry }) => ({ ...entry, recurring_total: total.toFixed(2) }));
}
