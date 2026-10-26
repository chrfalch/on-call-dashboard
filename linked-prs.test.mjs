import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkedPrs, updateLinkedPrs } from './linked-prs.mjs';

const REPO = 'expo/expo';
const prNode = (number, over = {}) => ({
  __typename: 'PullRequest',
  number,
  title: `PR ${number}`,
  state: 'MERGED',
  mergedAt: '2026-10-20T00:00:00Z',
  baseRefName: 'main',
  repository: { nameWithOwner: REPO },
  ...over,
});
const timeline = (...nodes) => ({ timelineItems: { nodes } });
const entry = (number, over = {}) => ({ number, title: `PR ${number}`, state: 'MERGED', mergedAt: '2026-10-20T00:00:00Z', baseRefName: 'main', ...over });

test('linkedPrs takes PRs from cross-references and connected events', () => {
  const node = timeline({ source: prNode(1) }, { subject: prNode(2, { state: 'OPEN', mergedAt: null, baseRefName: 'stack/feature' }) });
  assert.deepEqual(linkedPrs(node, REPO), [entry(1), entry(2, { state: 'OPEN', mergedAt: null, baseRefName: 'stack/feature' })]);
});

test('linkedPrs keeps only PRs in the same repository, compared without case', () => {
  const node = timeline({ source: prNode(1, { repository: { nameWithOwner: 'someone/fork' } }) }, { source: prNode(2, { repository: { nameWithOwner: 'Expo/Expo' } }) });
  assert.deepEqual(linkedPrs(node, REPO), [entry(2)]);
});

test('linkedPrs skips issues and events of other types', () => {
  const node = timeline({ source: { __typename: 'Issue' } }, { subject: { __typename: 'Issue' } }, {}, { source: prNode(3) });
  assert.deepEqual(linkedPrs(node, REPO), [entry(3)]);
});

test('linkedPrs skips null timeline entries', () => {
  assert.deepEqual(linkedPrs(timeline(null, { source: prNode(3) }, null), REPO), [entry(3)]);
});

test('linkedPrs skips PRs whose repository is not visible', () => {
  assert.deepEqual(linkedPrs(timeline({ source: prNode(1, { repository: null }) }, { subject: prNode(2) }), REPO), [entry(2)]);
});

test('linkedPrs lists each PR once, in timeline order', () => {
  const node = timeline({ source: prNode(5) }, { subject: prNode(4) }, { subject: prNode(5) }, { source: prNode(4) });
  assert.deepEqual(linkedPrs(node, REPO), [entry(5), entry(4)]);
});

test('linkedPrs returns an empty list for an issue without links', () => {
  assert.deepEqual(linkedPrs(timeline(), REPO), []);
});

test('updateLinkedPrs copies a PR state onto every issue that links it', () => {
  const a = { number: 10, type: 'issue', linkedPrs: [entry(1, { state: 'OPEN', mergedAt: null }), entry(2, { state: 'OPEN', mergedAt: null })] };
  const b = { number: 11, type: 'issue', linkedPrs: [entry(1, { state: 'OPEN', mergedAt: null, baseRefName: 'stack/x' })] };
  const c = { number: 12, type: 'issue', linkedPrs: [entry(3, { state: 'OPEN', mergedAt: null })] };
  const before = structuredClone([a, b, c]);
  const items = new Map([a, b, c].map((i) => [i.number, i]));
  const out = updateLinkedPrs(items, { number: 1, state: 'MERGED', mergedAt: '2026-10-25T00:00:00Z' });
  assert.deepEqual(out.get(10).linkedPrs, [entry(1, { mergedAt: '2026-10-25T00:00:00Z' }), entry(2, { state: 'OPEN', mergedAt: null })]);
  assert.deepEqual(out.get(11).linkedPrs, [entry(1, { mergedAt: '2026-10-25T00:00:00Z', baseRefName: 'stack/x' })]);
  assert.equal(out.get(12), c);
  assert.deepEqual([a, b, c], before, 'input items are not changed');
});

test('updateLinkedPrs records a PR closed without merging', () => {
  const items = new Map([[10, { number: 10, type: 'issue', linkedPrs: [entry(1, { state: 'OPEN', mergedAt: null })] }]]);
  const out = updateLinkedPrs(items, { number: 1, state: 'CLOSED', mergedAt: null });
  assert.deepEqual(out.get(10).linkedPrs, [entry(1, { state: 'CLOSED', mergedAt: null })]);
});

test('updateLinkedPrs leaves PRs and old cached issues without linkedPrs alone', () => {
  const old = { number: 10, type: 'issue' };
  const pr = { number: 11, type: 'pr', linkedIssues: [] };
  const out = updateLinkedPrs(new Map([[10, old], [11, pr]]), { number: 1, state: 'MERGED', mergedAt: '2026-10-25T00:00:00Z' });
  assert.equal(out.get(10), old);
  assert.equal(out.get(11), pr);
});
