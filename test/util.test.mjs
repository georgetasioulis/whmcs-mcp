import assert from 'node:assert/strict';
import { test } from 'node:test';
import { datePart, daysBetween, listOf, mapLimit, recentMonths } from '../build/util.js';

test('recentMonths counts back across a year boundary', () => {
  assert.deepEqual(recentMonths(3, '2026-02-15'), ['2025-12', '2026-01', '2026-02']);
  assert.deepEqual(recentMonths(1, '2026-10-29'), ['2026-10']);
});

test('datePart keeps the date of a WHMCS date or datetime and drops zero dates', () => {
  assert.equal(datePart('2026-12-16 09:30:00'), '2026-12-16');
  assert.equal(datePart('0000-00-00'), null);
  assert.equal(datePart(''), null);
  assert.equal(datePart(undefined), null);
});

test('daysBetween is whole days regardless of timezone', () => {
  assert.equal(daysBetween('2026-12-06', '2026-12-16'), 10);
  assert.equal(daysBetween('2026-03-28', '2026-03-30'), 2); // across a DST change
});

test('listOf normalises WHMCS list containers', () => {
  assert.deepEqual(listOf({ item: [1, 2] }, 'item'), [1, 2]);
  assert.deepEqual(listOf({ item: { id: 1 } }, 'item'), [{ id: 1 }]);
  assert.deepEqual(listOf('', 'item'), []);
});

test('mapLimit keeps order and caps concurrency', async () => {
  let running = 0;
  let peak = 0;
  const result = await mapLimit([30, 10, 20, 5], 2, async (ms) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, ms));
    running--;
    return ms * 2;
  });

  assert.deepEqual(result, [60, 20, 40, 10]);
  assert.equal(peak, 2);
});
