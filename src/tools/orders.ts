import { z } from 'zod';
import { defineTool, type ToolHost, paginate, READ_ONLY, WRITE } from '../tool.js';
import { listOf } from '../util.js';
import type { WhmcsClient } from '../whmcs-client.js';
import { zId, zLimit, zOffset, zText } from './schemas.js';

export function registerOrderTools(host: ToolHost, whmcs: WhmcsClient): void {
  defineTool(
    host,
    'whmcs_get_orders',
    {
      title: 'List Orders',
      description: 'List orders, optionally filtered by ID, client or status. Paginated.',
      input: {
        limitstart: zOffset,
        limitnum: zLimit(25),
        id: zId.optional().describe('Order ID'),
        userid: zId.optional().describe('Client ID'),
        requestor_id: zId.optional(),
        status: zText.optional().describe('Order status, e.g. Pending, Active, Fraud, Cancelled'),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      const result = await whmcs.call('GetOrders', args);
      const orders = listOf<any>(result.orders, 'order');
      return {
        data: result,
        pagination: paginate(result, orders.length, args.limitstart),
        tables: [
          {
            headers: ['ID', 'Order #', 'Client ID', 'Client', 'Status', 'Amount', 'Date'],
            rows: orders.map((o) => [o.id, o.ordernum, o.userid, o.name, o.status, o.amount, o.date]),
          },
        ],
      };
    },
  );

  defineTool(
    host,
    'whmcs_accept_order',
    {
      title: 'Accept Order',
      description: 'Accept a pending order: provisions its services, registers domains and sends welcome emails as configured.',
      input: {
        orderid: zId,
        serverid: zId.optional().describe('Server to provision on (overrides the product default)'),
        serviceusername: zText.optional(),
        servicepassword: zText.optional(),
        registrar: zText.optional().describe('Registrar module for domain registration'),
        autosetup: z.boolean().optional().describe('Run module provisioning (default: true)'),
        sendemail: z.boolean().optional().describe('Send the order confirmation email (default: true)'),
      },
      annotations: WRITE({ destructive: false, idempotent: false }),
    },
    async (args) => ({ data: await whmcs.call('AcceptOrder', args) }),
  );

  defineTool(
    host,
    'whmcs_cancel_order',
    {
      title: 'Cancel Order',
      description: 'Cancel an order and its services and domains.',
      input: {
        orderid: zId,
        cancelsub: z.boolean().optional().describe('Also cancel linked payment subscriptions'),
        noemail: z.boolean().optional().describe('Do not email the client'),
      },
      annotations: WRITE({ destructive: true, idempotent: true }),
    },
    async (args) => ({ data: await whmcs.call('CancelOrder', args) }),
  );

  defineTool(
    host,
    'whmcs_delete_order',
    {
      title: 'Delete Order',
      description: 'Permanently delete an order. IRREVERSIBLE: removes every record of it.',
      input: { orderid: zId },
      annotations: WRITE({ destructive: true, idempotent: false }),
    },
    async (args) => ({ data: await whmcs.call('DeleteOrder', args) }),
  );

  defineTool(
    host,
    'whmcs_pending_order',
    {
      title: 'Set Order Pending',
      description: 'Put an order back to Pending, e.g. for review.',
      input: { orderid: zId },
      annotations: WRITE({ destructive: false, idempotent: true }),
    },
    async (args) => ({ data: await whmcs.call('PendingOrder', args) }),
  );
}
