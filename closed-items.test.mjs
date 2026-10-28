import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropOldClosed, KEEP_CLOSED_DAYS } from './closed-items.mjs';

const NOW = new Date('2026-10-28T12:00:00Z').getTime();
const daysAgo = (days) => new Date(NOW - days * 864e5).toISOString();

test('dropOldClosed keeps an open item', () => {
  const items = new Map([[1, { state: 'OPEN', closedAt: daysAgo(8) }]]);
  assert.deepEqual(dropOldClosed(items, NOW), items);
});

test('dropOldClosed keeps a state-less item', () => {
  const items = new Map([[1, { number: 1 }]]);
  assert.deepEqual(dropOldClosed(items, NOW), items);
});

test('dropOldClosed keeps a closed item closed 6 days ago', () => {
  const items = new Map([[1, { state: 'CLOSED', closedAt: daysAgo(6) }]]);
  assert.deepEqual(dropOldClosed(items, NOW), items);
});

test('dropOldClosed keeps an item closed exactly 7 days ago', () => {
  assert.equal(KEEP_CLOSED_DAYS, 7);
  const items = new Map([[1, { state: 'CLOSED', closedAt: daysAgo(7) }]]);
  assert.deepEqual(dropOldClosed(items, NOW), items);
});

test('dropOldClosed drops a closed item closed 8 days ago', () => {
  assert.equal(dropOldClosed(new Map([[1, { state: 'CLOSED', closedAt: daysAgo(8) }]]), NOW).size, 0);
});

test('dropOldClosed drops a MERGED item closed 8 days ago', () => {
  assert.equal(dropOldClosed(new Map([[1, { state: 'MERGED', closedAt: daysAgo(8) }]]), NOW).size, 0);
});

test('dropOldClosed drops a closed item without closedAt', () => {
  assert.equal(dropOldClosed(new Map([[1, { state: 'CLOSED' }], [2, { state: 'CLOSED', closedAt: null }]]), NOW).size, 0);
});

test('dropOldClosed does not mutate its input', () => {
  const items = new Map([[1, { state: 'OPEN' }], [2, { state: 'CLOSED', closedAt: daysAgo(8) }]]);
  const before = structuredClone(items);
  const out = dropOldClosed(items, NOW);
  assert.notEqual(out, items);
  assert.equal(out.get(1), items.get(1));
  assert.deepEqual(items, before);
});

test('dropOldClosed keeps a MERGED item closed 2 days ago', () => {
  const items = new Map([[1, { state: 'MERGED', closedAt: daysAgo(2) }]]);
  assert.deepEqual(dropOldClosed(items, NOW), items);
});
