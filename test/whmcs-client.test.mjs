import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WhmcsClient } from '../build/whmcs-client.js';
import { config, fakeWhmcs, page } from './fake-whmcs.mjs';

test('call sends an authenticated form POST and returns the API data', async () => {
  const api = fakeWhmcs({ GetTickets: () => ({ tickets: { ticket: [{ id: '42' }] } }) });
  const seen = [];
  const client = new WhmcsClient(config, {
    fetch: (url, init) => {
      seen.push({ url, init });
      return api.fetch(url, init);
    },
  });

  const response = await client.call('GetTickets', { status: 'Open', limitnum: 10, deptid: undefined });

  assert.equal(response.tickets.ticket[0].id, '42');
  assert.equal(seen[0].url, config.apiUrl);
  assert.equal(seen[0].init.method, 'POST');
  assert.equal(seen[0].init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.deepEqual(api.calls[0], {
    action: 'GetTickets',
    identifier: 'test-identifier',
    secret: 'test-secret',
    responsetype: 'json',
    status: 'Open',
    limitnum: '10',
  });
});

test('booleans are sent as 1/0 because PHP reads "false" as true', async () => {
  const api = fakeWhmcs({ AcceptOrder: () => ({}) });
  await new WhmcsClient(config, { fetch: api.fetch }).call('AcceptOrder', { orderid: 1, autosetup: false, sendemail: true });

  assert.equal(api.calls[0].autosetup, '0');
  assert.equal(api.calls[0].sendemail, '1');
});

test('admin credentials are sent as username and MD5 password', async () => {
  const api = fakeWhmcs({ GetSupportDepartments: () => ({}) });
  await new WhmcsClient({ username: 'admin-user', password: 'plain-password', apiUrl: config.apiUrl }, { fetch: api.fetch }).call(
    'GetSupportDepartments',
  );

  assert.equal(api.calls[0].username, 'admin-user');
  assert.equal(api.calls[0].password, '9a0ef3ecf101a8b0856f98eb6b2e2c24');
  assert.equal(api.calls[0].identifier, undefined);
});

test('a pre-hashed admin password is sent unchanged', async () => {
  const api = fakeWhmcs({ GetSupportDepartments: () => ({}) });
  const hash = '0123456789abcdef0123456789abcdef';
  await new WhmcsClient({ username: 'a', password: hash, apiUrl: config.apiUrl }, { fetch: api.fetch }).call('GetSupportDepartments');

  assert.equal(api.calls[0].password, hash);
});

test('a WHMCS error result is thrown with its message', async () => {
  const api = fakeWhmcs({ GetClients: () => '{"result":"error","message":"Authentication failed"}' });
  await assert.rejects(() => new WhmcsClient(config, { fetch: api.fetch }).call('GetClients'), /Authentication failed/);
  assert.equal(api.calls.length, 1, 'ordinary errors are not retried as XML');
});

test('an HTTP error surfaces the status and the WHMCS message', async () => {
  const api = fakeWhmcs({
    WhmcsDetails: () => new Response('{"result":"error","message":"Invalid IP 203.0.113.9"}', { status: 403 }),
  });
  const client = new WhmcsClient(config, { fetch: api.fetch });

  await assert.rejects(() => client.call('WhmcsDetails'), /HTTP 403 — Invalid IP 203\.0\.113\.9/);
  await assert.rejects(() => client.checkConnection(), /Your IP 203\.0\.113\.9 is not whitelisted/);
});

test('a non-JSON body is reported rather than crashing the parser', async () => {
  const api = fakeWhmcs({ GetClients: () => '<html>maintenance</html>' });
  await assert.rejects(() => new WhmcsClient(config, { fetch: api.fetch }).call('GetClients'), /non-JSON response to GetClients/);
});

test('retries as XML when the WHMCS JSON encoder fails', async () => {
  const api = fakeWhmcs({
    GetClientsProducts: (params) =>
      params.responsetype === 'json'
        ? '{"result":"error","message":"Error generating JSON encoded response: Malformed UTF-8 characters, possibly incorrectly encoded"}'
        : `<?xml version="1.0" encoding="utf-8"?>
<whmcsapi version="8.13.1">
<result>success</result>
<totalresults>1</totalresults>
<products><product><id>42</id><billingcycle>Monthly</billingcycle><recurringamount>49.90</recurringamount></product></products>
</whmcsapi>`,
  });

  const response = await new WhmcsClient(config, { fetch: api.fetch }).call('GetClientsProducts', { limitnum: 1 });

  assert.deepEqual(api.calls.map((c) => c.responsetype), ['json', 'xml']);
  assert.equal(api.calls[1].limitnum, '1');
  assert.equal(response.products.product.length, 1);
  assert.equal(response.products.product[0].recurringamount, '49.90');
});

test('surfaces a real API error from the XML retry', async () => {
  const api = fakeWhmcs({
    GetClientsProducts: (params) =>
      params.responsetype === 'json'
        ? '{"result":"error","message":"Malformed UTF-8 characters"}'
        : '<whmcsapi><result>error</result><message>Invalid IP 1.2.3.4</message></whmcsapi>',
  });
  await assert.rejects(() => new WhmcsClient(config, { fetch: api.fetch }).call('GetClientsProducts'), /Invalid IP 1\.2\.3\.4/);
});

test('fetchAll walks every page', async () => {
  const items = Array.from({ length: 5 }, (_, i) => ({ id: i + 1 }));
  const api = fakeWhmcs({ GetClients: (params) => page(items, params, 'clients', 'client') });

  const all = await new WhmcsClient(config, { fetch: api.fetch }).fetchAll('GetClients', (p) => p.clients.client, {}, 2);

  assert.deepEqual(all.map((c) => c.id), [1, 2, 3, 4, 5]);
  assert.deepEqual(api.calls.map((c) => c.limitstart), ['0', '2', '4']);
});
