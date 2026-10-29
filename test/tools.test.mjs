// End-to-end: an MCP client calls the real server, which talks to a fake WHMCS.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../build/server.js';
import { WhmcsClient } from '../build/whmcs-client.js';
import { config, fakeWhmcs, page } from './fake-whmcs.mjs';

const products = [
  { pid: 10, gid: 3, name: 'cPanel Cloud License', module: 'cpanelmanage2', paytype: 'recurring', description: '<p>long</p>',
    pricing: { EUR: { prefix: '€', monthly: '20.00', annually: '220.00' } } },
  { pid: 11, gid: 3, name: 'cPanel Cloud License (Yearly)', module: 'cpanelmanage2', paytype: 'recurring',
    pricing: { EUR: { prefix: '€', monthly: '-1.00', annually: '200.00' } } },
  { pid: 30, gid: 1, name: 'Web Hosting', module: 'cpanel', paytype: 'recurring', pricing: { EUR: { monthly: '5.00' } } },
];

const services = [
  { id: 100, clientid: 1, pid: 10, name: 'cPanel Cloud License', domain: 'a.example', billingcycle: 'Monthly', recurringamount: '18.00', nextduedate: '2026-11-20', status: 'Active', regdate: '2025-01-01' },
  { id: 101, clientid: 2, pid: 11, name: 'cPanel Cloud License (Yearly)', domain: 'b.example', billingcycle: 'Annually', recurringamount: '180.00', nextduedate: '2026-11-05', status: 'Active', regdate: '2024-11-05' },
  { id: 102, clientid: 3, pid: 10, name: 'cPanel Cloud License', domain: 'c.example', billingcycle: 'Monthly', recurringamount: '20.00', nextduedate: '2026-11-01', status: 'Cancelled', regdate: '2024-01-01' },
  { id: 103, clientid: 1, pid: 30, name: 'Web Hosting', domain: 'a.example', billingcycle: 'Monthly', recurringamount: '5.00', nextduedate: '2026-11-20', status: 'Active', regdate: '2025-01-01' },
];

const clients = [
  { id: 1, firstname: 'Jane', lastname: 'Doe', email: 'jane@example.com' },
  { id: 2, firstname: 'John', lastname: 'Roe', companyname: 'Roe Ltd', email: 'john@example.com' },
  { id: 3, firstname: 'Gone', lastname: 'Away', email: 'gone@example.com' },
];

function whmcs() {
  return fakeWhmcs({
    GetProducts: () => ({ totalresults: products.length, products: { product: products } }),
    GetClientsProducts: (p) => page(services.filter((s) => !p.pid || String(s.pid) === p.pid), p, 'products', 'product'),
    GetClients: (p) => page(clients, p, 'clients', 'client'),
    GetCurrencies: () => ({ totalresults: 1, currencies: { currency: [{ id: 1, code: 'EUR' }] } }),
    GetInvoices: (p) =>
      page(p.userid === '2' ? [{ id: 900, invoicenum: 'INV-900', userid: 2, duedate: '2026-11-05', status: 'Unpaid' }] : [], p, 'invoices', 'invoice'),
    GetInvoice: () => ({
      invoiceid: 900,
      items: { item: [{ id: 5001, type: 'Hosting', relid: 101, description: 'cPanel Cloud License (Yearly) - b.example', amount: '180.00', taxed: 1 }] },
    }),
    UpdateClientProduct: (p) => ({ serviceid: p.serviceid }),
    UpdateInvoice: (p) => ({ invoiceid: p.invoiceid }),
  });
}

// Confirmation is exercised in safety.test.mjs; these tests are about the tools.
const unguarded = { readOnly: false, confirmWrites: false, auditLog: null };

async function connect(api) {
  const server = createServer(new WhmcsClient(config, { fetch: api.fetch }), unguarded);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientSide);
  return client;
}

const call = (client, name, args) => client.callTool({ name, arguments: args });

test('every tool advertises response_format and annotations', async () => {
  const { tools } = await (await connect(whmcs())).listTools();
  const names = tools.map((t) => t.name);

  assert.ok(names.includes('whmcs_list_services'));
  assert.ok(names.includes('whmcs_reprice_services'));
  for (const tool of tools) {
    assert.ok(tool.inputSchema.properties.response_format, `${tool.name} has response_format`);
    assert.equal(typeof tool.annotations.readOnlyHint, 'boolean', `${tool.name} has annotations`);
  }
});

test('whmcs_list_services finds licence services across clients', async () => {
  const api = whmcs();
  const result = await call(await connect(api), 'whmcs_list_services', { module: 'manage2', response_format: 'json' });
  const { data } = JSON.parse(result.content[0].text);

  assert.deepEqual(data.products.map((p) => p.pid), [10, 11]);
  assert.deepEqual(data.services.map((s) => s.serviceid), [100, 101], 'cancelled and hosting services are left out');
  assert.equal(data.services[1].client, 'John Roe (Roe Ltd)');
  assert.equal(data.services[1].recurringamount, 180);
  assert.deepEqual(api.callsTo('GetClientsProducts').map((c) => c.pid).sort(), ['10', '11']);
});

test('whmcs_list_services renders markdown tables', async () => {
  const result = await call(await connect(whmcs()), 'whmcs_list_services', { name_contains: ['cpanel'], billing_cycles: ['Annually'] });
  const text = result.content[0].text;

  assert.match(text, /1 service\(s\) across 1 client\(s\)/);
  assert.match(text, /\| 101 \| 2 \| John Roe \(Roe Ltd\) \|/);
  assert.doesNotMatch(text, /```json/);
});

test('whmcs_reprice_services dry run plans changes and finds unpaid invoices without writing', async () => {
  const api = whmcs();
  const result = await call(await connect(api), 'whmcs_reprice_services', {
    module: 'manage2',
    pricing: { mode: 'catalog' },
    response_format: 'json',
  });
  const { data } = JSON.parse(result.content[0].text);

  assert.equal(result.isError, undefined);
  assert.equal(data.applied, false);
  assert.deepEqual(
    data.plan.map((c) => [c.serviceid, c.action, c.new_amount]),
    [[100, 'update', 20], [101, 'update', 200]],
  );
  assert.equal(data.unpaid_invoice_lines.length, 1);
  assert.equal(data.unpaid_invoice_lines[0].invoiceid, 900);
  assert.equal(api.callsTo('UpdateClientProduct').length, 0);
  assert.equal(api.callsTo('UpdateInvoice').length, 0);
});

test('whmcs_reprice_services refuses to apply without the confirmed count', async () => {
  const api = whmcs();
  const result = await call(await connect(api), 'whmcs_reprice_services', {
    module: 'manage2',
    pricing: { mode: 'catalog' },
    apply: true,
    confirm_changes: 5,
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /plan now has 2 update\(s\) but confirm_changes is 5/);
  assert.equal(api.callsTo('UpdateClientProduct').length, 0);
});

test('whmcs_reprice_services applies the plan and re-prices matching unpaid invoice lines', async () => {
  const api = whmcs();
  const result = await call(await connect(api), 'whmcs_reprice_services', {
    module: 'manage2',
    billing_cycles: ['Annually'],
    pricing: { mode: 'percent', percent: 10 },
    apply: true,
    confirm_changes: 1,
    update_unpaid_invoices: true,
  });

  assert.equal(result.isError, undefined, result.content[0].text);
  assert.deepEqual(
    api.callsTo('UpdateClientProduct').map((c) => [c.serviceid, c.recurringamount]),
    [['101', '198.00']],
  );
  const [invoiceUpdate] = api.callsTo('UpdateInvoice');
  assert.equal(invoiceUpdate.invoiceid, '900');
  assert.equal(invoiceUpdate['itemamount[5001]'], '198.00');
  assert.equal(invoiceUpdate['itemdescription[5001]'], 'cPanel Cloud License (Yearly) - b.example');
  assert.equal(invoiceUpdate['itemtaxed[5001]'], '1');
  assert.match(result.content[0].text, /Applied: 1 updated, 0 failed/);
});

test('whmcs_get_products slims the payload and shows pricing', async () => {
  const result = await call(await connect(whmcs()), 'whmcs_get_products', {});

  assert.match(result.content[0].text, /€20\.00\/mo, €220\.00\/yr/);
  assert.equal(result.structuredContent.data.products.product[0].description, undefined);
});

test('a tool error comes back as an MCP error result', async () => {
  const result = await call(await connect(whmcs()), 'whmcs_get_ticket', {});

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Either ticketid or ticketnum/);
});

test('service passwords never reach the model', async () => {
  const api = fakeWhmcs({
    GetClientsProducts: (p) =>
      page([{ id: 100, clientid: 1, name: 'cPanel', username: 'jane', password: 's3cret!' }], p, 'products', 'product'),
  });
  const result = await call(await connect(api), 'whmcs_get_clients_products', { clientid: 1, response_format: 'json' });

  assert.ok(!result.content[0].text.includes('s3cret!'));
  assert.ok(!JSON.stringify(result.structuredContent).includes('s3cret!'));
  assert.equal(result.structuredContent.data.products.product[0].password, '[hidden]');
  assert.equal(result.structuredContent.data.products.product[0].username, 'jane', 'other fields are kept');
});

test('whmcs_find_client matches on email/name and on service domains', async () => {
  const api = fakeWhmcs({
    GetClients: (p) => page(p.search === 'a.example' ? [] : clients.slice(0, 1), p, 'clients', 'client'),
    GetClientsProducts: (p) =>
      page(p.domain ? services.filter((s) => s.domain === p.domain && s.clientid !== 1).concat(
        services.filter((s) => s.domain === p.domain && s.clientid === 1)) : [], p, 'products', 'product'),
    GetClientsDomains: (p) => page(p.domain === 'a.example' ? [{ id: 7, userid: 2, domainname: 'a.example' }] : [], p, 'domains', 'domain'),
    GetClientsDetails: (p) => ({ client: clients.find((c) => String(c.id) === p.clientid) }),
  });
  const result = await call(await connect(api), 'whmcs_find_client', { query: 'a.example', response_format: 'json' });
  const { data } = JSON.parse(result.content[0].text);

  assert.deepEqual(data.clients.map((c) => c.clientid).sort(), [1, 2]);
  const jane = data.clients.find((c) => c.clientid === 1);
  assert.equal(jane.client, 'Jane Doe', 'name looked up for a service-only match');
  assert.deepEqual(jane.matched_on, ['service #100 domain', 'service #103 domain']);
  assert.deepEqual(data.clients.find((c) => c.clientid === 2).matched_on, ['domain #7']);
});

test('whmcs_retry_module_action runs the API command matching the queue entry', async () => {
  const queue = [
    { id: 5, service_type: 'service', related_id: 100, module_name: 'cpanelmanage2', module_action: 'create', last_attempt_error: 'Licence server timeout', num_retries: 2, completed: 0 },
    { id: 6, service_type: 'addon', related_id: 9, module_name: 'x', module_action: 'create', completed: 0 },
  ];
  const api = fakeWhmcs({ GetModuleQueue: () => ({ count: queue.length, queue }), ModuleCreate: () => ({}) });
  const client = await connect(api);

  const listed = await call(client, 'whmcs_get_module_queue', { response_format: 'json' });
  assert.equal(JSON.parse(listed.content[0].text).data.queue.length, 2);

  await call(client, 'whmcs_retry_module_action', { queue_id: 5 });
  assert.deepEqual(api.callsTo('ModuleCreate').map((c) => c.serviceid), ['100']);

  const addon = await call(client, 'whmcs_retry_module_action', { queue_id: 6 });
  assert.equal(addon.isError, true);
  assert.match(addon.content[0].text, /admin area/);
});

test('whmcs_get_tickets merges several statuses, newest reply first', async () => {
  const tickets = {
    Open: [{ id: 1, tid: 'A', status: 'Open', lastreply: '2026-10-01 10:00:00' }],
    'Customer-Reply': [{ id: 2, tid: 'B', status: 'Customer-Reply', lastreply: '2026-10-02 10:00:00' }],
  };
  const api = fakeWhmcs({ GetTickets: (p) => page(tickets[p.status] ?? [], p, 'tickets', 'ticket') });
  const result = await call(await connect(api), 'whmcs_get_tickets', { statuses: ['Open', 'Customer-Reply'], response_format: 'json' });

  assert.deepEqual(api.callsTo('GetTickets').map((c) => c.status), ['Open', 'Customer-Reply']);
  assert.deepEqual(JSON.parse(result.content[0].text).data.tickets.map((t) => t.tid), ['B', 'A']);
});
