import { z } from 'zod';
import { formatProductPricing, SERVICE_BILLING_CYCLES, slimProducts } from '../products.js';
import {
  applyRepricing,
  findUnpaidServiceLines,
  planRepricing,
  pricingSchema,
  updateUnpaidLines,
  type InvoiceLine,
  type InvoiceUpdate,
} from '../repricing.js';
import { countByProductAndCycle, findServices, productSelectorShape, SERVICE_STATUSES, serviceFilterShape } from '../services.js';
import { defineTool, type ToolHost, paginate, READ_ONLY, WRITE, type Table } from '../tool.js';
import { listOf, money } from '../util.js';
import type { Params, WhmcsClient } from '../whmcs-client.js';
import { zId, zLimit, zOffset, zText } from './schemas.js';

const productsTable = (products: Array<{ pid: number; name: string; module: string }>): Table & { title: string } => ({
  title: 'Matched products',
  headers: ['PID', 'Product', 'Module'],
  rows: products.map((p) => [p.pid, p.name, p.module]),
});

const invoiceCells = (line: InvoiceLine) => [line.invoicenum, line.clientid, line.serviceid, line.duedate, money(line.amount)];

export function registerServiceTools(host: ToolHost, whmcs: WhmcsClient): void {
  defineTool(
    host,
    'whmcs_get_products',
    {
      title: 'List Products',
      description:
        'List products in the catalogue with module, pay type and the price of every enabled billing cycle. ' +
        'Use this to find product IDs before listing or re-pricing their services.',
      input: {
        pid: z.union([zId, zText]).optional().describe('Product ID or comma-separated list of IDs'),
        gid: zId.optional().describe('Product group ID'),
        module: zText.optional().describe('Exact module name'),
        include_full_details: z
          .boolean()
          .optional()
          .describe(
            'Include the description HTML, config options and custom fields. Off by default because the full catalogue runs to hundreds of KB; pricing is always returned.',
          ),
      },
      annotations: READ_ONLY,
    },
    async ({ include_full_details: full = false, ...args }) => {
      const result = slimProducts(await whmcs.call('GetProducts', args), full);
      const products = listOf<any>(result.products, 'product');
      return {
        data: result,
        pagination: paginate(result, products.length),
        tables: [
          {
            headers: ['ID', 'Group', 'Name', 'Type', 'Pay Type', 'Module', 'Pricing'],
            rows: products.map((p) => [
              p.pid,
              p.gid,
              String(p.name ?? '').trim(),
              p.type,
              p.paytype,
              p.module,
              formatProductPricing(p.pricing),
            ]),
          },
        ],
      };
    },
  );

  defineTool(
    host,
    'whmcs_get_clients_products',
    {
      title: 'Get Client Services',
      description:
        'Raw page of client services (products) filtered by client, service, single product ID or domain. ' +
        'To find every service of a set of products across all clients, use whmcs_list_services instead.',
      input: {
        limitstart: zOffset,
        limitnum: zLimit(25),
        clientid: zId.optional(),
        serviceid: zId.optional(),
        pid: zId.optional().describe('Product ID'),
        domain: zText.optional(),
        username2: zText.optional().describe('Service username'),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      const result = await whmcs.call('GetClientsProducts', args);
      const services = listOf<any>(result.products, 'product');
      return {
        data: result,
        pagination: paginate(result, services.length, args.limitstart),
        tables: [
          {
            headers: ['Service ID', 'Client ID', 'Product', 'Domain', 'Billing Cycle', 'Recurring', 'Next Due', 'Status'],
            rows: services.map((s) => [
              s.id,
              s.clientid,
              String(s.name ?? '').trim(),
              s.domain,
              s.billingcycle,
              s.recurringamount,
              s.nextduedate,
              s.status,
            ]),
          },
        ],
      };
    },
  );

  defineTool(
    host,
    'whmcs_list_services',
    {
      title: 'List Services by Product',
      description:
        'Find every client service of a set of products across all clients, e.g. "all cPanel licences": pick the ' +
        'products by IDs, group, module substring or name, then filter services by status, billing cycle and next due date. ' +
        'Returns the matched products, per-product/cycle counts, and one row per service with client, amount and next due date. ' +
        'Check the matched products: a broad name or module filter can catch products you did not mean.',
      input: { ...productSelectorShape, ...serviceFilterShape },
      annotations: READ_ONLY,
    },
    async (selector) => {
      const { products, services } = await findServices(whmcs, selector);
      const counts = countByProductAndCycle(services);
      const statuses = (selector.statuses ?? ['Active', 'Suspended']).join(', ');
      return {
        data: { products, counts, services },
        summary: [
          `${services.length} service(s) across ${new Set(services.map((s) => s.clientid)).size} client(s) ` +
            `in ${products.length} matched product(s); statuses: ${statuses}.`,
        ],
        tables: [
          productsTable(products),
          {
            title: 'Services per product, cycle and currency',
            headers: ['Product', 'Billing Cycle', 'Currency', 'Services', 'Recurring Total'],
            rows: counts.map((c) => [c.product, c.billingcycle, c.currency, c.services, c.recurring_total]),
          },
          {
            title: 'Services',
            headers: ['Service ID', 'Client ID', 'Client', 'Product', 'Domain', 'Cycle', 'Recurring', 'Currency', 'Next Due', 'Status'],
            rows: services.map((s) => [
              s.serviceid,
              s.clientid,
              s.client,
              s.product,
              s.domain,
              s.billingcycle,
              money(s.recurringamount),
              s.currency,
              s.nextduedate,
              s.status,
            ]),
          },
        ],
      };
    },
  );

  defineTool(
    host,
    'whmcs_reprice_services',
    {
      title: 'Re-price Services',
      description:
        'Change the recurring amount of existing client services in bulk, selected the same way as whmcs_list_services. ' +
        'Catalogue price changes in WHMCS only affect new orders; existing services keep their own amount, and WHMCS ' +
        'bills renewals from that amount when it generates the invoice (the configured number of days before the due date). ' +
        'Pricing modes: "catalog" (product\'s current catalogue price for the cycle and client currency, so update the ' +
        'catalogue first), "percent" (scale the current amount) or "table" (explicit amount per product and cycle). ' +
        'Always runs as a dry run first: it returns the plan and lists unpaid invoices that already bill these services at ' +
        'the old amount. To apply, call again with apply: true and confirm_changes set to the number of planned updates. ' +
        'With update_unpaid_invoices: true it also re-prices those unpaid invoice lines when they bill exactly the old amount.',
      input: {
        ...productSelectorShape,
        ...serviceFilterShape,
        pricing: pricingSchema,
        check_unpaid_invoices: z
          .boolean()
          .default(true)
          .describe('Look for unpaid invoices already billing these services (default: true)'),
        apply: z.boolean().default(false).describe('Write the changes. Default false: dry run only.'),
        confirm_changes: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Required with apply: the number of updates the dry run planned. The call aborts if it differs.'),
        update_unpaid_invoices: z
          .boolean()
          .default(false)
          .describe('With apply: also set unpaid invoice lines of re-priced services to the new amount'),
      },
      annotations: WRITE({ destructive: true, idempotent: true }),
      // The dry run is a read; only the apply step is confirmed, once the plan is known.
      confirm: 'manual',
    },
    async ({ pricing, check_unpaid_invoices: checkInvoices, apply, confirm_changes: confirm, update_unpaid_invoices: fixInvoices, ...selector }, ctx) => {
      const { products, services, catalogue, multipleCurrencies } = await findServices(whmcs, selector);
      const plan = planRepricing(services, catalogue, pricing, multipleCurrencies);
      const updates = plan.filter((change) => change.action === 'update');
      const skipped = plan.filter((change) => change.action === 'skip');

      if (apply && confirm !== updates.length) {
        throw new Error(
          `Refusing to apply: the plan now has ${updates.length} update(s) but confirm_changes is ${confirm ?? 'missing'}. ` +
            'Run a dry run, review it, and pass its update count as confirm_changes.',
        );
      }

      let lines: InvoiceLine[] = [];
      if (checkInvoices || fixInvoices) {
        lines = await findUnpaidServiceLines(
          whmcs,
          [...new Set(updates.map((u) => u.clientid))],
          new Set(updates.map((u) => u.serviceid)),
        );
      }

      if (apply) {
        const fixable = fixInvoices ? lines.length : 0;
        await ctx.confirm(
          `Re-price ${updates.length} service(s) (${pricing.mode} mode)` +
            (fixable ? ` and up to ${fixable} unpaid invoice line(s)` : '') +
            `:\n${updates
              .slice(0, 20)
              .map((u) => `- #${u.serviceid} ${u.client} — ${u.product} (${u.billingcycle}): ${money(u.recurringamount)} → ${money(u.new_amount ?? 0)}${u.currency ? ` ${u.currency}` : ''}`)
              .join('\n')}${updates.length > 20 ? `\n- …and ${updates.length - 20} more` : ''}`,
        );
      }

      const results = apply ? await applyRepricing(whmcs, updates) : [];
      const failed = new Set(results.filter((r) => !r.ok).map((r) => r.serviceid));
      let invoiceUpdates: InvoiceUpdate[] = [];
      if (apply && fixInvoices && lines.length) {
        const succeeded = new Map(updates.filter((u) => !failed.has(u.serviceid)).map((u) => [u.serviceid, u]));
        invoiceUpdates = await updateUnpaidLines(whmcs, lines, succeeded);
      }

      const summary = [
        `Mode: ${pricing.mode}. ${plan.length} service(s) matched in ${products.length} product(s): ` +
          `${updates.length} to update, ${skipped.length} skipped.`,
      ];
      if (!apply) {
        summary.push(
          `**Dry run — nothing was changed.** To apply, call again with the same selection, apply: true and confirm_changes: ${updates.length}.`,
        );
      } else {
        summary.push(`Applied: ${results.length - failed.size} updated, ${failed.size} failed.`);
      }
      if (lines.length && !invoiceUpdates.length) {
        summary.push(
          `${lines.length} unpaid invoice line(s) already bill these services at the old amount; ` +
            (apply ? 'they were left unchanged.' : 'pass update_unpaid_invoices: true when applying to re-price them.'),
        );
      }

      const errors = new Map(results.filter((r) => !r.ok).map((r) => [r.serviceid, r.error]));
      return {
        data: {
          mode: pricing.mode,
          applied: apply,
          products,
          plan,
          unpaid_invoice_lines: invoiceUpdates.length ? invoiceUpdates : lines,
          ...(apply ? { results } : {}),
        },
        summary,
        tables: [
          productsTable(products),
          {
            title: apply ? 'Updates' : 'Planned updates',
            headers: ['Service ID', 'Client', 'Product', 'Cycle', 'Next Due', 'Current', 'New', 'Change', ...(apply ? ['Result'] : []), 'Note'],
            rows: updates.map((u) => [
              u.serviceid,
              u.client,
              u.product,
              u.billingcycle,
              u.nextduedate,
              `${money(u.recurringamount)}${u.currency ? ` ${u.currency}` : ''}`,
              money(u.new_amount ?? 0),
              u.change_percent === null ? '' : `${u.change_percent > 0 ? '+' : ''}${u.change_percent}%`,
              ...(apply ? [errors.has(u.serviceid) ? `failed: ${errors.get(u.serviceid)}` : 'updated'] : []),
              u.warning ?? '',
            ]),
          },
          {
            title: 'Skipped',
            headers: ['Service ID', 'Client', 'Product', 'Cycle', 'Current', 'Currency', 'Reason'],
            rows: skipped.map((s) => [s.serviceid, s.client, s.product, s.billingcycle, money(s.recurringamount), s.currency, s.reason]),
          },
          {
            title: 'Unpaid invoices billing these services',
            headers: ['Invoice', 'Client ID', 'Service ID', 'Due', 'Line Amount', ...(invoiceUpdates.length ? ['New', 'Result'] : [])],
            rows: invoiceUpdates.length
              ? invoiceUpdates.map((line) => [
                  ...invoiceCells(line),
                  line.new_amount === null ? '' : money(line.new_amount),
                  line.reason ? `${line.action}: ${line.reason}` : line.action,
                ])
              : lines.map(invoiceCells),
          },
        ],
      };
    },
  );

  defineTool(
    host,
    'whmcs_update_client_product',
    {
      title: 'Update Client Service',
      description:
        'Update one client service: recurring amount, billing cycle, next due date, status or admin notes. ' +
        'autorecalc recalculates the recurring amount from current product pricing (ignoring recurringamount).',
      input: {
        serviceid: zId,
        recurringamount: z.number().min(0).optional(),
        billingcycle: z.enum(SERVICE_BILLING_CYCLES).optional(),
        nextduedate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD'),
        status: z.enum(SERVICE_STATUSES).optional(),
        notes: z.string().optional().describe('Admin notes (replaces the existing notes)'),
        autorecalc: z.boolean().optional(),
      },
      annotations: WRITE({ destructive: true, idempotent: true }),
    },
    async ({ recurringamount, ...args }) => ({
      data: await whmcs.call('UpdateClientProduct', {
        ...args,
        ...(recurringamount === undefined ? {} : { recurringamount: money(recurringamount) }),
      }),
    }),
  );

  const moduleCommand = (
    name: string,
    action: string,
    title: string,
    description: string,
    annotations: ReturnType<typeof WRITE>,
    extra: { suspendreason?: z.ZodOptional<z.ZodString> } = {},
  ) =>
    defineTool(
      host,
      name,
      { title, description, input: { serviceid: zId, ...extra }, annotations },
      async (args) => ({ data: await whmcs.call(action, args as Params) }),
    );

  moduleCommand(
    'whmcs_module_suspend',
    'ModuleSuspend',
    'Suspend Service',
    'Run the module suspend action on a service and mark it Suspended. Affects the client\'s access.',
    WRITE({ destructive: true, idempotent: true }),
    { suspendreason: zText.optional().describe('Reason shown on the service, e.g. "Non-payment"') },
  );
  moduleCommand(
    'whmcs_module_unsuspend',
    'ModuleUnsuspend',
    'Unsuspend Service',
    'Run the module unsuspend action on a suspended service and mark it Active.',
    WRITE({ destructive: false, idempotent: true }),
  );
  moduleCommand(
    'whmcs_module_terminate',
    'ModuleTerminate',
    'Terminate Service',
    'Run the module terminate action. IRREVERSIBLE: removes the account or licence on the remote system.',
    WRITE({ destructive: true, idempotent: false }),
  );
  moduleCommand(
    'whmcs_module_create',
    'ModuleCreate',
    'Create/Provision Service',
    'Run the module create action to provision a service (hosting account, licence, VPS...).',
    WRITE({ destructive: false, idempotent: false }),
  );

  defineTool(
    host,
    'whmcs_get_module_queue',
    {
      title: 'Failed Module Actions',
      description:
        "WHMCS's module queue: provisioning commands (create, suspend, renew, register...) that failed and are waiting for a retry, " +
        'with the last error. Retry one with whmcs_retry_module_action.',
      input: {
        service_type: z.enum(['service', 'domain', 'addon']).optional(),
        related_id: zId.optional().describe('Service, domain or addon ID'),
        module_name: zText.optional().describe('e.g. "cpanelmanage2"'),
        module_action: zText.optional().describe('e.g. "create"'),
        since: zText.optional().describe('Only entries since this date (YYYY-MM-DD)'),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      const queue = await getModuleQueue(whmcs, args);
      return {
        data: { queue },
        summary: [`${queue.length} failed module action(s) in the queue.`],
        tables: [
          {
            headers: ['Queue ID', 'Type', 'Related ID', 'Module', 'Action', 'Retries', 'Last Attempt', 'Last Error'],
            rows: queue.map((q) => [
              q.id,
              q.service_type,
              q.related_id,
              q.module_name,
              q.module_action,
              q.num_retries,
              q.last_attempt,
              String(q.last_attempt_error ?? '').slice(0, 200),
            ]),
          },
        ],
      };
    },
  );

  defineTool(
    host,
    'whmcs_retry_module_action',
    {
      title: 'Retry Module Action',
      description:
        'Re-run one failed module action from the module queue (see whmcs_get_module_queue) through the matching API ' +
        'command, e.g. ModuleCreate for a failed service create or DomainRenew for a failed renewal. Addon actions are not supported.',
      input: { queue_id: zId.describe('Queue ID from whmcs_get_module_queue') },
      annotations: WRITE({ destructive: false, idempotent: false }),
      // Confirmed once the queue entry is known, so the prompt can say what will run.
      confirm: 'manual',
    },
    async ({ queue_id: queueId }, ctx) => {
      const entry = (await getModuleQueue(whmcs, {})).find((q) => Number(q.id) === queueId);
      if (!entry) throw new Error(`No module queue entry ${queueId}; it may already have been resolved`);

      const type = String(entry.service_type).toLowerCase();
      const command = RETRY_COMMANDS[type]?.[String(entry.module_action).toLowerCase()];
      if (!command) {
        throw new Error(
          `Cannot retry "${entry.module_action}" on a ${type} through the API; retry it from the WHMCS admin area (Utilities > Module Queue).`,
        );
      }

      const params = { [command.idParam]: Number(entry.related_id) };
      await ctx.confirm(
        `Retry the failed "${entry.module_action}" (${entry.module_name}) on ${type} #${entry.related_id} by running ${command.action}. ` +
          `Last error: ${entry.last_attempt_error || 'none recorded'}`,
      );
      const result = await whmcs.call(command.action, params);
      return {
        data: { queue_entry: entry, action: command.action, params, result },
        summary: [
          `${command.action} ran for ${type} #${entry.related_id}. Check whmcs_get_module_queue to see whether WHMCS cleared the queue entry.`,
        ],
        tables: [],
      };
    },
  );
}

type ModuleQueueEntry = {
  id: number;
  service_type: string;
  related_id: number;
  module_name: string;
  module_action: string;
  last_attempt: string;
  last_attempt_error: string;
  num_retries: number;
  completed?: number | boolean;
};

const RETRY_COMMANDS: Record<string, Record<string, { action: string; idParam: string }>> = {
  service: {
    create: { action: 'ModuleCreate', idParam: 'serviceid' },
    suspend: { action: 'ModuleSuspend', idParam: 'serviceid' },
    unsuspend: { action: 'ModuleUnsuspend', idParam: 'serviceid' },
    terminate: { action: 'ModuleTerminate', idParam: 'serviceid' },
    changepackage: { action: 'ModuleChangePackage', idParam: 'serviceid' },
  },
  domain: {
    register: { action: 'DomainRegister', idParam: 'domainid' },
    transfer: { action: 'DomainTransfer', idParam: 'domainid' },
    renew: { action: 'DomainRenew', idParam: 'domainid' },
  },
};

async function getModuleQueue(
  whmcs: WhmcsClient,
  filters: { service_type?: string; related_id?: number; module_name?: string; module_action?: string; since?: string },
): Promise<ModuleQueueEntry[]> {
  const result = await whmcs.call<any>('GetModuleQueue', {
    serviceType: filters.service_type,
    relatedId: filters.related_id,
    moduleName: filters.module_name,
    moduleAction: filters.module_action,
    since: filters.since,
  });
  // Documented as a plain array; tolerate the usual `{ item: [...] }` wrapping too.
  const queue: ModuleQueueEntry[] = Array.isArray(result.queue) ? result.queue : listOf(result.queue, 'item');
  return queue.filter((entry) => !Number(entry.completed));
}
