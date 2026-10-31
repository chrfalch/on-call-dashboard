import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastPushAt } from './commits.mjs';

const COMMITTED = '2026-10-20T10:00:00Z';
const commit = (...createdAts) => ({
  committedDate: COMMITTED,
  checkSuites: { nodes: createdAts.map((createdAt) => ({ createdAt })) },
});

test('lastPushAt is the commit date without check suites', () => {
  assert.equal(lastPushAt({ committedDate: COMMITTED }), COMMITTED);
  assert.equal(lastPushAt(commit()), COMMITTED);
});

test('lastPushAt is the suite time when the suite was created after the commit', () => {
  assert.equal(lastPushAt(commit('2026-10-22T09:00:00Z')), '2026-10-22T09:00:00Z');
});

test('lastPushAt takes the earliest of several suites', () => {
  assert.equal(lastPushAt(commit('2026-10-24T09:00:00Z', '2026-10-22T09:00:00Z', '2026-10-23T09:00:00Z')), '2026-10-22T09:00:00Z');
});

test('lastPushAt keeps the commit date when the suite is older', () => {
  assert.equal(lastPushAt(commit('2026-10-19T09:00:00Z')), COMMITTED);
});

test('lastPushAt is null without a commit', () => {
  assert.equal(lastPushAt(null), null);
  assert.equal(lastPushAt(undefined), null);
});

test('lastPushAt ignores null suites and suites without createdAt', () => {
  const c = { committedDate: COMMITTED, checkSuites: { nodes: [null, {}, { createdAt: null }, { createdAt: '2026-10-22T09:00:00Z' }] } };
  assert.equal(lastPushAt(c), '2026-10-22T09:00:00Z');
  assert.equal(lastPushAt({ committedDate: COMMITTED, checkSuites: { nodes: [null, {}] } }), COMMITTED);
});

test('lastPushAt uses the suite time when the commit date is missing', () => {
  assert.equal(lastPushAt({ checkSuites: { nodes: [{ createdAt: '2026-10-22T09:00:00Z' }] } }), '2026-10-22T09:00:00Z');
});
