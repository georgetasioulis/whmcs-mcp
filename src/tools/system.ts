import { z } from 'zod';
import { defineTool, type ToolHost, paginate, READ_ONLY } from '../tool.js';
import { listOf } from '../util.js';
import type { WhmcsClient } from '../whmcs-client.js';
import { zId, zLimit, zOffset, zText } from './schemas.js';

export function registerSystemTools(host: ToolHost, whmcs: WhmcsClient): void {
  defineTool(
    host,
    'whmcs_check_connection',
    {
      title: 'Check API Connection',
      description:
        'Check that the WHMCS API is reachable with the configured credentials. If this machine\'s IP is not ' +
        'whitelisted, the error names the IP to add.',
      input: {},
      annotations: READ_ONLY,
    },
    async () => {
      const { whmcsVersion } = await whmcs.checkConnection();
      return {
        data: { connected: true, whmcs_version: whmcsVersion },
        summary: [`Connected to WHMCS ${whmcsVersion}. This IP is allowed.`],
        tables: [],
      };
    },
  );

  defineTool(
    host,
    'whmcs_get_activity_log',
    {
      title: 'Get Activity Log',
      description: 'Search the system activity log. Paginated.',
      input: {
        limitstart: zOffset,
        limitnum: zLimit(25),
        clientid: zId.optional(),
        date: zText.optional().describe('Date filter (in the WHMCS date format)'),
        user: zText.optional().describe('Username or email'),
        description: zText.optional().describe('Text to search for in the description'),
        ipaddress: zText.optional(),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      const result = await whmcs.call('GetActivityLog', args);
      const entries = listOf<any>(result.activity, 'entry');
      return {
        data: result,
        pagination: paginate(result, entries.length, args.limitstart),
        tables: [
          {
            headers: ['ID', 'Date', 'User', 'Description'],
            rows: entries.map((e) => [e.id, e.date, e.username ?? e.user, String(e.description ?? '').slice(0, 160)]),
          },
        ],
      };
    },
  );

  defineTool(
    host,
    'whmcs_get_stats',
    {
      title: 'Get System Statistics',
      description: 'Income, orders, tickets and other system statistics.',
      input: { timeline_days: z.number().int().min(1).max(90).optional().describe('Days of timeline data') },
      annotations: READ_ONLY,
    },
    async (args) => ({ data: await whmcs.call('GetStats', args) }),
  );

  defineTool(
    host,
    'whmcs_get_currencies',
    {
      title: 'List Currencies',
      description: 'List configured currencies with their exchange rates.',
      input: {},
      annotations: READ_ONLY,
    },
    async () => {
      const result = await whmcs.call('GetCurrencies');
      const currencies = listOf<any>(result.currencies, 'currency');
      return {
        data: result,
        tables: [
          {
            headers: ['ID', 'Code', 'Prefix', 'Suffix', 'Rate'],
            rows: currencies.map((c) => [c.id, c.code, c.prefix, c.suffix, c.rate]),
          },
        ],
      };
    },
  );

  defineTool(
    host,
    'whmcs_get_payment_methods',
    {
      title: 'List Payment Methods',
      description: 'List active payment gateways.',
      input: {},
      annotations: READ_ONLY,
    },
    async () => {
      const result = await whmcs.call('GetPaymentMethods');
      const methods = listOf<any>(result.paymentmethods, 'paymentmethod');
      return {
        data: result,
        tables: [{ headers: ['Module', 'Name'], rows: methods.map((m) => [m.module, m.displayname]) }],
      };
    },
  );

  defineTool(
    host,
    'whmcs_get_admin_users',
    {
      title: 'List Admin Users',
      description: 'List administrator accounts.',
      input: {
        roleid: zId.optional(),
        email: zText.optional().describe('Email (partial match)'),
        include_disabled: z.boolean().optional(),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      const result = await whmcs.call('GetAdminUsers', args);
      const admins = listOf<any>(result.admin_users, 'admin_user');
      return {
        data: result,
        tables: [
          {
            headers: ['ID', 'Username', 'Name', 'Email', 'Disabled'],
            rows: admins.map((a) => [a.id, a.username, `${a.firstname ?? ''} ${a.lastname ?? ''}`.trim(), a.email, a.disabled]),
          },
        ],
      };
    },
  );
}
