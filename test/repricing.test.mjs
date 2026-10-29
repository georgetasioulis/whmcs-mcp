import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planRepricing } from '../build/repricing.js';
import { filterServices, matchProducts } from '../build/services.js';

const products = [
  { pid: 10, gid: 3, name: 'cPanel Cloud License', module: 'cpanelmanage2', pricing: { EUR: { monthly: '20.00', annually: '220.00' } } },
  { pid: 11, gid: 3, name: 'cPanel Cloud License (Yearly)', module: 'cpanelmanage2', pricing: { EUR: { monthly: '-1.00', annually: '200.00' } } },
  { pid: 20, gid: 3, name: 'CloudLinux', module: 'cpanelmanage2', pricing: {} },
  { pid: 30, gid: 1, name: 'Web Hosting', module: 'cpanel', pricing: {} },
];
const catalogue = new Map(products.map((p) => [p.pid, p]));

function service(overrides) {
  return {
    serviceid: 1,
    clientid: 1,
    client: 'Jane Doe',
    pid: 10,
    product: 'cPanel Cloud License',
    domain: 'example.com',
    billingcycle: 'Monthly',
    recurringamount: 18,
    nextduedate: '2026-11-20',
    status: 'Active',
    regdate: '2025-01-01',
    paymentmethod: 'stripe',
    has_config_options: false,
    currency: 'EUR',
    ...overrides,
  };
}

test('matchProducts combines filters and honours exclusions', () => {
  const pids = (selector) => matchProducts(products, selector).map((p) => p.pid);

  assert.deepEqual(pids({ module: 'Manage2' }), [10, 11, 20]);
  assert.deepEqual(pids({ module: 'cpanel' }), [10, 11, 20, 30], '"cpanel" also catches the hosting module');
  assert.deepEqual(pids({ name_contains: ['cpanel'] }), [10, 11]);
  assert.deepEqual(pids({ module: 'manage2', exclude_pids: [20] }), [10, 11]);
  assert.deepEqual(pids({ gid: 1 }), [30]);
  assert.throws(() => matchProducts(products, {}), /at least one of/);
});

test('filterServices defaults to Active and Suspended and applies date and cycle filters', () => {
  const raw = [
    { id: 1, clientid: 1, pid: 10, status: 'Active', billingcycle: 'Monthly', nextduedate: '2026-11-20' },
    { id: 2, clientid: 2, pid: 10, status: 'Cancelled', billingcycle: 'Monthly', nextduedate: '2026-11-20' },
    { id: 3, clientid: 3, pid: 11, status: 'Suspended', billingcycle: 'Annually', nextduedate: '2027-03-01' },
    { id: 4, clientid: 4, pid: 99, status: 'Active', billingcycle: 'Monthly', nextduedate: '2026-11-20' },
  ];
  const ids = (selector) => filterServices(raw, new Set([10, 11]), selector).map((s) => s.id);

  assert.deepEqual(ids({}), [1, 3]);
  assert.deepEqual(ids({ billing_cycles: ['Annually'] }), [3]);
  assert.deepEqual(ids({ next_due_to: '2026-12-31' }), [1]);
  assert.deepEqual(ids({ statuses: ['Cancelled'] }), [2]);
  assert.deepEqual(ids({ exclude_clientids: [1] }), [3]);
});

test('catalog mode uses the price for the service cycle and client currency', () => {
  const plan = planRepricing(
    [
      service({ serviceid: 1 }),
      service({ serviceid: 2, pid: 11, billingcycle: 'Annually', recurringamount: 180 }),
      service({ serviceid: 3, pid: 11, billingcycle: 'Monthly' }),
      service({ serviceid: 4, recurringamount: 20 }),
      service({ serviceid: 5, billingcycle: 'One Time' }),
      service({ serviceid: 6, has_config_options: true }),
    ],
    catalogue,
    { mode: 'catalog' },
    false,
  );
  const byId = Object.fromEntries(plan.map((c) => [c.serviceid, c]));

  assert.equal(byId[1].action, 'update');
  assert.equal(byId[1].new_amount, 20);
  assert.equal(byId[1].change_percent, 11.11);
  assert.equal(byId[2].new_amount, 200);
  assert.match(byId[3].reason, /no Monthly price in EUR/);
  assert.match(byId[4].reason, /already at the target price/);
  assert.match(byId[5].reason, /does not recur/);
  assert.match(byId[6].warning, /configurable options/);
});

test('percent mode scales, rounds, and leaves free services alone', () => {
  const plan = planRepricing(
    [service({ serviceid: 1, recurringamount: 18 }), service({ serviceid: 2, recurringamount: 0 })],
    catalogue,
    { mode: 'percent', percent: 12.5, round_to: 0.5 },
    false,
  );

  assert.equal(plan[0].new_amount, 20.5); // 20.25 rounded to the nearest 0.50
  assert.equal(plan[1].action, 'skip');
  assert.match(plan[1].reason, /free service/);
});

test('table mode matches product and cycle, and insists on a currency when there are several', () => {
  const pricing = {
    mode: 'table',
    prices: [
      { pid: 10, billing_cycle: 'Monthly', amount: 22 },
      { pid: 11, billing_cycle: 'Annually', amount: 240, currency: 'USD' },
    ],
  };
  const single = planRepricing([service({}), service({ serviceid: 2, pid: 10, billingcycle: 'Annually' })], catalogue, pricing, false);
  assert.equal(single[0].new_amount, 22);
  assert.match(single[1].reason, /no price given for this product on Annually/);

  const plan = planRepricing(
    [service({ clientid: 1 }), service({ serviceid: 2, clientid: 2, pid: 11, billingcycle: 'Annually', recurringamount: 200, currency: 'USD' })],
    catalogue,
    pricing,
    true,
  );
  assert.match(plan[0].reason, /client's currency \(EUR\)/, 'a currency-less row is ambiguous with several currencies');
  assert.equal(plan[1].new_amount, 240);
});
