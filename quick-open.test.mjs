import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseItemNumber, findItem, quickOpenFilters } from './public/quick-open.js';

const DEFAULTS = { tab: 'inbox', inboxMode: 'oncall', inboxScope: 'all', q: '', sort: 'severity', hideDrafts: true, hideUnsupportedSdks: true, view: '', minSeverity: 0, include: [] };
const issue = { type: 'issue', number: 49630 };
const pr = { type: 'pr', number: 50001 };

test('parseItemNumber accepts digits with an optional leading #', () => {
  assert.equal(parseItemNumber('49630'), 49630);
  assert.equal(parseItemNumber(' #49630 '), 49630);
  assert.equal(parseItemNumber('#1'), 1);
});

test('parseItemNumber rejects anything that is not a positive integer', () => {
  for (const text of ['#0', '0', 'abc', '49630x', '##1', '', '   ', '#', '1.5', '-3', '# 1']) {
    assert.equal(parseItemNumber(text), null, JSON.stringify(text));
  }
});

test('findItem returns the item with that number, else null', () => {
  assert.equal(findItem([issue, pr], 50001), pr);
  assert.equal(findItem([issue, pr], 1), null);
  assert.equal(findItem([], 49630), null);
});

test('quickOpenFilters opens an issue on the Issues tab with only that number', () => {
  const filters = { ...DEFAULTS, tab: 'inbox', sort: 'updated', view: 'needs-repro', minSeverity: 3, q: 'crash', include: ['ios'] };
  assert.deepEqual(quickOpenFilters(filters, DEFAULTS, issue), {
    ...DEFAULTS,
    tab: 'issue',
    sort: 'updated',
    hideDrafts: false,
    hideUnsupportedSdks: false,
    q: '#49630',
  });
});

test('quickOpenFilters opens a PR on the PRs tab, drafts and unsupported SDKs shown', () => {
  const f = quickOpenFilters({ ...DEFAULTS, tab: 'issue', view: 'ready-for-review' }, DEFAULTS, pr);
  assert.equal(f.tab, 'pr');
  assert.equal(f.q, '#50001');
  assert.equal(f.sort, 'severity');
  assert.equal(f.hideDrafts, false);
  assert.equal(f.hideUnsupportedSdks, false);
  assert.equal(f.view, '');
});

test('quickOpenFilters keeps the Inbox mode and scope for the way back', () => {
  const f = quickOpenFilters({ ...DEFAULTS, inboxMode: 'mine', inboxScope: 'pr' }, DEFAULTS, issue);
  assert.equal(f.inboxMode, 'mine');
  assert.equal(f.inboxScope, 'pr');
});

test('quickOpenFilters does not mutate its inputs', () => {
  const filters = { ...DEFAULTS, sort: 'updated', include: ['ios'] };
  const before = structuredClone(filters);
  const defaults = structuredClone(DEFAULTS);
  const item = { ...pr };
  const f = quickOpenFilters(filters, DEFAULTS, item);
  assert.deepEqual(filters, before);
  assert.deepEqual(DEFAULTS, defaults);
  assert.deepEqual(item, pr);
  assert.notEqual(f, filters);
  assert.notEqual(f, DEFAULTS);
});
