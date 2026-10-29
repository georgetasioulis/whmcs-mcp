import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../build/server.js';
import { WhmcsClient } from '../build/whmcs-client.js';
import { config, fakeWhmcs, page } from './fake-whmcs.mjs';

const products = [{ pid: 10, gid: 3, name: 'cPanel Cloud License', module: 'cpanelmanage2', pricing: { EUR: { monthly: '20.00' }, USD: { monthly: '22.00' } } }];
const services = [
  { id: 100, clientid: 1, pid: 10, name: 'cPanel Cloud License', billingcycle: 'Monthly', recurringamount: '18.00', nextduedate: '2026-11-20', status: 'Active' },
  { id: 101, clientid: 2, pid: 10, name: 'cPanel Cloud License', billingcycle: 'Monthly', recurringamount: '19.00', nextduedate: '2026-11-21', status: 'Active' },
];

function whmcs() {
  return fakeWhmcs({
    GetProducts: () => ({ products: { product: products } }),
    GetClientsProducts: (p) => page(services.filter((s) => String(s.pid) === p.pid), p, 'products', 'product'),
    GetClients: (p) => page([{ id: 1, firstname: 'Ana' }, { id: 2, firstname: 'Bob' }], p, 'clients', 'client'),
    GetCurrencies: () => ({ currencies: { currency: [{ id: 1, code: 'EUR' }, { id: 2, code: 'USD' }] } }),
    GetClientsDetails: (p) => ({ client: { id: Number(p.clientid), currency_code: p.clientid === '2' ? 'USD' : 'EUR' } }),
    GetInvoices: (p) => page([], p, 'invoices', 'invoice'),
    UpdateClientProduct: () => ({}),
    PendingOrder: () => ({}),
  });
}

function settings(overrides = {}) {
  return { readOnly: false, confirmWrites: true, auditLog: join(mkdtempSync(join(tmpdir(), 'whmcs-mcp-')), 'audit.jsonl'), ...overrides };
}

async function connect(api, safety, { elicit } = {}) {
  const server = createServer(new WhmcsClient({ ...config, readOnly: safety.readOnly }, { fetch: api.fetch }), safety);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '0' }, { capabilities: elicit ? { elicitation: {} } : {} });
  if (elicit) client.setRequestHandler(ElicitRequestSchema, elicit);
  await client.connect(clientSide);
  return client;
}

const call = (client, name, args) => client.callTool({ name, arguments: args });

test('a write without elicitation support returns a token and changes nothing', async () => {
  const api = whmcs();
  const safety = settings();
  const client = await connect(api, safety);

  const first = await call(client, 'whmcs_pending_order', { orderid: 7 });
  assert.match(first.content[0].text, /NOT EXECUTED/);
  assert.match(first.content[0].text, /confirm you have a current backup/);
  assert.equal(api.callsTo('PendingOrder').length, 0);

  const token = first.structuredContent.confirmation_token;
  const wrongArgs = await call(client, 'whmcs_pending_order', { orderid: 8, confirmation_token: token });
  assert.match(wrongArgs.content[0].text, /issued for different arguments/);
  assert.equal(api.callsTo('PendingOrder').length, 0);

  const second = await call(client, 'whmcs_pending_order', { orderid: 7, confirmation_token: token });
  assert.equal(second.isError, undefined);
  assert.equal(api.callsTo('PendingOrder').length, 1);

  const replay = await call(client, 'whmcs_pending_order', { orderid: 7, confirmation_token: token });
  assert.match(replay.content[0].text, /NOT EXECUTED/, 'tokens are single-use');
  assert.equal(api.callsTo('PendingOrder').length, 1);

  const [entry] = readFileSync(safety.auditLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(entry.tool, 'whmcs_pending_order');
  assert.equal(entry.confirmed_by, 'token');
  assert.equal(entry.ok, true);
  assert.deepEqual(entry.args, { orderid: 7 });
});

test('with elicitation the user is asked directly, and declining changes nothing', async () => {
  const api = whmcs();
  const prompts = [];
  let answer = { action: 'decline' };
  const client = await connect(api, settings(), {
    elicit: async (request) => {
      prompts.push(request.params.message);
      return answer;
    },
  });

  const declined = await call(client, 'whmcs_pending_order', { orderid: 7 });
  assert.match(declined.content[0].text, /Not executed: the change was declined/);
  assert.equal(api.callsTo('PendingOrder').length, 0);
  assert.match(prompts[0], /change data in your WHMCS installation/);

  answer = { action: 'accept', content: { backup_confirmed: true } };
  const accepted = await call(client, 'whmcs_pending_order', { orderid: 7 });
  assert.equal(accepted.isError, undefined);
  assert.equal(api.callsTo('PendingOrder').length, 1);
});

test('re-pricing confirms only the apply step, with the plan in the prompt', async () => {
  const api = whmcs();
  const prompts = [];
  const client = await connect(api, settings(), {
    elicit: async (request) => {
      prompts.push(request.params.message);
      return { action: 'accept', content: { backup_confirmed: true } };
    },
  });
  const args = { module: 'manage2', pricing: { mode: 'catalog' } };

  await call(client, 'whmcs_reprice_services', args);
  assert.equal(prompts.length, 0, 'the dry run is not a write');

  await call(client, 'whmcs_reprice_services', { ...args, apply: true, confirm_changes: 2 });
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /#100 Ana — cPanel Cloud License \(Monthly\): 18\.00 → 20\.00 EUR/);
  assert.match(prompts[0], /#101 Bob — cPanel Cloud License \(Monthly\): 19\.00 → 22\.00 USD/);
  assert.equal(api.callsTo('UpdateClientProduct').length, 2);
});

test('read-only mode hides writes, keeps the re-pricing dry run, and blocks writes at the client', async () => {
  const api = whmcs();
  const client = await connect(api, settings({ readOnly: true }));
  const names = (await client.listTools()).tools.map((t) => t.name);

  assert.ok(names.includes('whmcs_get_clients'));
  assert.ok(!names.includes('whmcs_pending_order'));
  assert.ok(!names.includes('whmcs_module_terminate'));
  assert.ok(names.includes('whmcs_reprice_services'));

  const dryRun = await call(client, 'whmcs_reprice_services', { module: 'manage2', pricing: { mode: 'catalog' } });
  assert.equal(dryRun.isError, undefined);

  const apply = await call(client, 'whmcs_reprice_services', { module: 'manage2', pricing: { mode: 'catalog' }, apply: true, confirm_changes: 2 });
  assert.equal(apply.isError, true);
  assert.match(apply.content[0].text, /read-only mode/);

  await assert.rejects(
    () => new WhmcsClient({ ...config, readOnly: true }, { fetch: api.fetch }).call('UpdateClientProduct', { serviceid: 1 }),
    /Refusing UpdateClientProduct/,
  );
  assert.equal(api.callsTo('UpdateClientProduct').length, 0);
});

test('list_services shows each client\'s currency and totals per currency', async () => {
  const client = await connect(whmcs(), settings());
  const result = await call(client, 'whmcs_list_services', { module: 'manage2', response_format: 'json' });
  const { data } = JSON.parse(result.content[0].text);

  assert.deepEqual(data.services.map((s) => [s.serviceid, s.currency]), [[100, 'EUR'], [101, 'USD']]);
  assert.deepEqual(
    data.counts.map((c) => [c.currency, c.services, c.recurring_total]),
    [['EUR', 1, '18.00'], ['USD', 1, '19.00']],
  );
});
