import { z } from 'zod';
import { defineTool, type ToolHost, paginate, READ_ONLY, WRITE } from '../tool.js';
import { listOf } from '../util.js';
import type { WhmcsClient } from '../whmcs-client.js';
import { zId, zLimit, zOffset, zPriority, zText } from './schemas.js';

export function registerTicketTools(host: ToolHost, whmcs: WhmcsClient): void {
  defineTool(
    host,
    'whmcs_get_tickets',
    {
      title: 'List Support Tickets',
      description:
        'List support tickets with optional filters, most recent reply first. Paginated for a single department and status; ' +
        'with several departments or statuses it merges the first limitnum tickets of each and returns the newest limitnum. ' +
        'Status also takes WHMCS\'s groups: "Awaiting Reply", "All Active Tickets", "Flagged Tickets".',
      input: {
        limitstart: zOffset,
        limitnum: zLimit(25),
        deptid: zId.optional().describe('Filter by department ID'),
        deptids: z.array(zId).min(1).optional().describe('Filter by any of these department IDs'),
        clientid: zId.optional().describe('Filter by client ID'),
        email: zText.optional().describe('Filter by email address (for non-client tickets)'),
        status: zText.optional().describe('Filter by ticket status, e.g. Open, Answered, Closed'),
        statuses: z.array(zText).min(1).optional().describe('Filter by any of these statuses'),
        subject: zText.optional().describe('Search in ticket subject (approximate match)'),
        ignore_dept_assignments: z.boolean().optional().describe("Ignore the API admin's department assignments"),
      },
      annotations: READ_ONLY,
    },
    async ({ deptid, deptids, status, statuses, ...args }) => {
      const departments = deptids ?? [deptid];
      const states = statuses ?? [status];
      const combos = departments.flatMap((d) => states.map((st) => ({ deptid: d, status: st })));

      if (combos.length === 1) {
        const result = await whmcs.call('GetTickets', { ...args, ...combos[0] });
        const tickets = listOf<any>(result.tickets, 'ticket');
        return {
          data: result,
          pagination: paginate(result, tickets.length, args.limitstart),
          tables: [ticketTable(tickets)],
        };
      }

      const pages = await Promise.all(
        combos.map((combo) => whmcs.call('GetTickets', { ...args, ...combo, limitstart: 0 })),
      );
      const byId = new Map<number, any>();
      let total = 0;
      for (const page of pages) {
        total += Number(page.totalresults) || 0;
        for (const ticket of listOf<any>(page.tickets, 'ticket')) byId.set(Number(ticket.id), ticket);
      }
      const tickets = [...byId.values()]
        .sort((a, b) => String(b.lastreply ?? '').localeCompare(String(a.lastreply ?? '')))
        .slice(0, args.limitnum ?? 25);
      return {
        data: { totalresults: total, tickets },
        summary: [
          `${tickets.length} most recent of ${total} ticket(s) across ${combos.length} department/status combinations. ` +
            'Narrow the filters to page through the rest.',
        ],
        tables: [ticketTable(tickets)],
      };
    },
  );

  defineTool(
    host,
    'whmcs_get_ticket',
    {
      title: 'Get Ticket Details',
      description: 'Get one ticket with all replies and notes. Identify it by ticketid or ticketnum.',
      input: {
        ticketid: zId.optional().describe('Internal ticket ID'),
        ticketnum: zText.optional().describe('Client-facing ticket number'),
        repliessort: z.enum(['ASC', 'DESC']).optional().describe('Sort order for replies'),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      if (!args.ticketid && !args.ticketnum) {
        throw new Error('Either ticketid or ticketnum must be provided');
      }
      return { data: await whmcs.call('GetTicket', args) };
    },
  );

  defineTool(
    host,
    'whmcs_open_ticket',
    {
      title: 'Create Support Ticket',
      description:
        'Open a new support ticket. Requires department, subject and message; attach it to a client or give a name and email.',
      input: {
        deptid: zId.describe('Department ID'),
        subject: zText,
        message: zText,
        clientid: zId.optional().describe('Client ID to associate the ticket with'),
        contactid: zId.optional().describe('Contact ID (with clientid)'),
        name: zText.optional().describe('Name of the opener (when not a client)'),
        email: zText.optional().describe('Email of the opener (when not a client)'),
        priority: zPriority.optional(),
        serviceid: zId.optional().describe('Related service ID'),
        domainid: zId.optional().describe('Related domain ID'),
        markdown: z.boolean().optional().describe('Message is markdown'),
        noemail: z.boolean().optional().describe('Do not send the new-ticket email'),
      },
      annotations: WRITE({ destructive: false, idempotent: false }),
    },
    async (args) => ({ data: await whmcs.call('OpenTicket', args) }),
  );

  defineTool(
    host,
    'whmcs_add_ticket_reply',
    {
      title: 'Add Ticket Reply',
      description: 'Reply to a ticket as an admin, a client, or a given name and email.',
      input: {
        ticketid: zId,
        message: zText,
        clientid: zId.optional().describe('Client posting the reply'),
        contactid: zId.optional().describe('Contact posting the reply'),
        adminusername: zText.optional().describe('Admin posting the reply'),
        name: zText.optional().describe('Name (when not admin or client)'),
        email: zText.optional().describe('Email (when not admin or client)'),
        status: zText.optional().describe('New ticket status to set with this reply'),
        markdown: z.boolean().optional(),
        noemail: z.boolean().optional().describe('Do not send the reply email'),
      },
      annotations: WRITE({ destructive: false, idempotent: false }),
    },
    async (args) => ({ data: await whmcs.call('AddTicketReply', args) }),
  );

  defineTool(
    host,
    'whmcs_update_ticket',
    {
      title: 'Update Ticket',
      description: 'Change a ticket\'s department, subject, priority, status, owner client or flag.',
      input: {
        ticketid: zId,
        deptid: zId.optional(),
        subject: zText.optional(),
        priority: zPriority.optional(),
        status: zText.optional(),
        userid: zId.optional().describe('Client ID to move the ticket to'),
        flag: zId.optional().describe('Admin ID to flag the ticket to'),
        removeFlag: z.boolean().optional().describe('Remove the current flag'),
      },
      annotations: WRITE({ destructive: true, idempotent: true }),
    },
    async (args) => ({ data: await whmcs.call('UpdateTicket', args) }),
  );

  defineTool(
    host,
    'whmcs_get_support_departments',
    {
      title: 'List Support Departments',
      description: 'List support departments with open and awaiting-reply counts.',
      input: {
        ignore_dept_assignments: z.boolean().optional().describe("Ignore the API admin's department assignments"),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      const result = await whmcs.call('GetSupportDepartments', args);
      const departments = listOf<any>(result.departments, 'department');
      return {
        data: result,
        tables: [
          {
            headers: ['ID', 'Name', 'Awaiting', 'Open'],
            rows: departments.map((d) => [d.id, d.name, d.awaitingreply, d.opentickets]),
          },
        ],
      };
    },
  );

  defineTool(
    host,
    'whmcs_get_support_statuses',
    {
      title: 'Get Support Statuses',
      description: 'List ticket statuses with their ticket counts.',
      input: { deptid: zId.optional().describe('Count only this department') },
      annotations: READ_ONLY,
    },
    async (args) => {
      const result = await whmcs.call('GetSupportStatuses', args);
      const statuses = listOf<any>(result.statuses, 'status');
      return {
        data: result,
        tables: [{ headers: ['Status', 'Count', 'Color'], rows: statuses.map((s) => [s.title, s.count, s.color]) }],
      };
    },
  );

  defineTool(
    host,
    'whmcs_get_ticket_counts',
    {
      title: 'Get Ticket Counts',
      description: 'Ticket totals, optionally grouped by status.',
      input: {
        ignoreDepartmentAssignments: z.boolean().optional(),
        includeCountsByStatus: z.boolean().optional(),
      },
      annotations: READ_ONLY,
    },
    async (args) => ({ data: await whmcs.call('GetTicketCounts', args) }),
  );
}

function ticketTable(tickets: any[]) {
  return {
    headers: ['ID', 'Ticket #', 'Dept', 'Subject', 'From', 'Status', 'Priority', 'Last Reply'],
    rows: tickets.map((t) => [
      t.id,
      t.tid,
      t.deptname ?? t.deptid,
      t.subject,
      t.name || t.email || (t.userid ? `client ${t.userid}` : ''),
      t.status,
      t.priority,
      t.lastreply,
    ]),
  };
}
