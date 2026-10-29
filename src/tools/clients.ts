import { z } from 'zod';
import { defineTool, type ToolHost, paginate, READ_ONLY } from '../tool.js';
import { clientName, listOf, mapLimit } from '../util.js';
import type { WhmcsClient } from '../whmcs-client.js';
import { zId, zLimit, zOffset, zText } from './schemas.js';

type ClientMatch = { clientid: number; client: string; email: string; status: string; matched_on: string[] };

export function registerClientTools(host: ToolHost, whmcs: WhmcsClient): void {
  defineTool(
    host,
    'whmcs_find_client',
    {
      title: 'Find Client',
      description:
        'Find clients by one search term across several places at once: email, name or company (partial match), ' +
        'and, exactly, a domain or username of any of their services, or a registered domain. ' +
        'Use this when you have "something about the customer" and need their client ID. Phone numbers are not searchable via the API.',
      input: {
        query: zText.describe('Email, name, company, domain or service username'),
        limit: zLimit(25, 100),
      },
      annotations: READ_ONLY,
    },
    async ({ query, limit = 25 }) => {
      const term = query.trim();
      const [byClient, byServiceDomain, byUsername, byDomain] = await Promise.all([
        whmcs.call('GetClients', { search: term, limitnum: limit }),
        whmcs.call('GetClientsProducts', { domain: term, limitnum: limit }),
        whmcs.call('GetClientsProducts', { username2: term, limitnum: limit }),
        whmcs.call('GetClientsDomains', { domain: term, limitnum: limit }),
      ]);

      const matches = new Map<number, ClientMatch>();
      const add = (clientid: number, how: string) => {
        const match = matches.get(clientid) ?? { clientid, client: '', email: '', status: '', matched_on: [] };
        if (!match.matched_on.includes(how)) match.matched_on.push(how);
        matches.set(clientid, match);
        return match;
      };

      for (const c of listOf<any>(byClient.clients, 'client')) {
        Object.assign(add(Number(c.id), 'email/name/company'), { client: clientName(c), email: c.email ?? '', status: c.status ?? '' });
      }
      for (const s of listOf<any>(byServiceDomain.products, 'product')) add(Number(s.clientid), `service #${s.id} domain`);
      for (const s of listOf<any>(byUsername.products, 'product')) add(Number(s.clientid), `service #${s.id} username`);
      for (const d of listOf<any>(byDomain.domains, 'domain')) add(Number(d.userid), `domain #${d.id}`);

      // Clients found only through a service or domain still need a name.
      const unnamed = [...matches.values()].filter((m) => !m.client);
      await mapLimit(unnamed, 5, async (match) => {
        const { client } = await whmcs.call<any>('GetClientsDetails', { clientid: match.clientid });
        Object.assign(match, { client: clientName(client), email: client?.email ?? '', status: client?.status ?? '' });
      });

      const found = [...matches.values()].slice(0, limit);
      return {
        data: { query: term, clients: found },
        summary: [`${found.length} client(s) match "${term}".`],
        tables: [
          {
            headers: ['Client ID', 'Client', 'Email', 'Status', 'Matched On'],
            rows: found.map((m) => [m.clientid, m.client, m.email, m.status, m.matched_on.join(', ')]),
          },
        ],
      };
    },
  );

  defineTool(
    host,
    'whmcs_get_clients',
    {
      title: 'List Clients',
      description: 'List clients, optionally filtered by status or a search term over email, name and company. Paginated.',
      input: {
        limitstart: zOffset,
        limitnum: zLimit(25),
        sorting: z.enum(['ASC', 'DESC']).optional(),
        status: z.enum(['Active', 'Inactive', 'Closed']).optional(),
        search: zText.optional().describe('Search term for email, name or company'),
        orderby: z
          .enum(['id', 'firstname', 'lastname', 'companyname', 'email', 'groupid', 'datecreated', 'status'])
          .optional(),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      const result = await whmcs.call('GetClients', args);
      const clients = listOf<any>(result.clients, 'client');
      return {
        data: result,
        pagination: paginate(result, clients.length, args.limitstart),
        tables: [
          {
            headers: ['ID', 'Name', 'Email', 'Status', 'Created'],
            rows: clients.map((c) => [c.id, clientName(c), c.email, c.status, c.datecreated]),
          },
        ],
      };
    },
  );

  defineTool(
    host,
    'whmcs_get_clients_details',
    {
      title: 'Get Client Details',
      description: 'Get one client\'s full record (address, currency, credit, groups...). Identify by clientid or email.',
      input: {
        clientid: zId.optional(),
        email: z.string().email().optional(),
        stats: z.boolean().optional().describe('Include invoice, ticket and service statistics'),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      if (!args.clientid && !args.email) {
        throw new Error('Either clientid or email must be provided');
      }
      return { data: await whmcs.call('GetClientsDetails', args) };
    },
  );

  defineTool(
    host,
    'whmcs_get_clients_domains',
    {
      title: 'Get Client Domains',
      description: 'List registered domains, for one client or across all. Paginated.',
      input: {
        limitstart: zOffset,
        limitnum: zLimit(25),
        clientid: zId.optional(),
        domainid: zId.optional(),
        domain: zText.optional().describe('Domain name'),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      const result = await whmcs.call('GetClientsDomains', args);
      const domains = listOf<any>(result.domains, 'domain');
      return {
        data: result,
        pagination: paginate(result, domains.length, args.limitstart),
        tables: [
          {
            headers: ['ID', 'Client ID', 'Domain', 'Registrar', 'Expiry', 'Next Due', 'Recurring', 'Status'],
            rows: domains.map((d) => [
              d.id,
              d.userid,
              d.domainname,
              d.registrar,
              d.expirydate,
              d.nextduedate,
              d.recurringamount,
              d.status,
            ]),
          },
        ],
      };
    },
  );

  defineTool(
    host,
    'whmcs_get_contacts',
    {
      title: 'List Contacts',
      description: 'List client sub-contacts with filters. Paginated.',
      input: {
        limitstart: zOffset,
        limitnum: zLimit(25),
        userid: zId.optional().describe('Client ID'),
        firstname: zText.optional(),
        lastname: zText.optional(),
        companyname: zText.optional(),
        email: z.string().email().optional(),
        phonenumber: zText.optional(),
        address1: zText.optional(),
        city: zText.optional(),
        state: zText.optional(),
        country: zText.optional(),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      const result = await whmcs.call('GetContacts', args);
      const contacts = listOf<any>(result.contacts, 'contact');
      return {
        data: result,
        pagination: paginate(result, contacts.length, args.limitstart),
        tables: [
          {
            headers: ['ID', 'Name', 'Email', 'Client ID'],
            rows: contacts.map((c) => [c.id, clientName(c), c.email, c.userid]),
          },
        ],
      };
    },
  );

  defineTool(
    host,
    'whmcs_get_emails',
    {
      title: 'Get Client Emails',
      description: 'List the emails WHMCS sent to a client. Paginated.',
      input: {
        clientid: zId,
        limitstart: zOffset,
        limitnum: zLimit(25),
        date: zText.optional().describe('Date filter'),
        subject: zText.optional().describe('Subject search'),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      const result = await whmcs.call('GetEmails', args);
      const emails = listOf<any>(result.emails, 'email');
      return {
        data: result,
        pagination: paginate(result, emails.length, args.limitstart),
        tables: [
          {
            headers: ['ID', 'Subject', 'Date', 'Failed'],
            rows: emails.map((e) => [e.id, e.subject, e.date, e.failed]),
          },
        ],
      };
    },
  );
}
