import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activeFilterChips,
  activeFilterCount,
  matchesFilters,
  matchesQuery,
  normalizeUserRole,
  PANEL_DEFAULTS,
  PANEL_KEYS,
  normalizeFilters,
  severityMismatch,
} from './public/filters.js';

const NOW = new Date('2026-10-26T12:00:00Z').getTime();
const daysAgo = (d) => new Date(NOW - d * 864e5).toISOString();

const issue = (over = {}) => ({
  type: 'issue',
  number: 101,
  title: 'Camera crashes on Android',
  state: 'OPEN',
  author: { login: 'reporter' },
  createdAt: daysAgo(10),
  updatedAt: daysAgo(2),
  labels: [],
  assignees: [],
  severity: 0,
  bot: { lastCommand: null, botRepliedAfterCommand: false },
  triage: null,
  conversation: { waitingOn: 'team', teamReplied: false, since: daysAgo(4) },
  ...over,
});
const pr = (over = {}) => ({
  ...issue({ number: 202, title: 'Fix camera crash', author: { login: 'contributor' } }),
  type: 'pr',
  isDraft: false,
  checks: 'SUCCESS',
  mergeable: 'MERGEABLE',
  reviewDecision: 'REVIEW_REQUIRED',
  linkedIssues: [],
  ...over,
});
const label = (name) => ({ name, color: 'ededed' });
const person = (login) => ({ login, avatarUrl: '' });
const filters = (over = {}) => ({ ...PANEL_DEFAULTS, ...over });
const opts = { now: NOW, me: 'viewer' };
const kept = (items, over, options = opts) => items.filter((item) => matchesFilters(item, filters(over), options)).map((item) => item.number);

test('default filters match every item: issue, PR, draft PR and closed item', () => {
  const items = [issue(), pr(), pr({ number: 203, isDraft: true }), issue({ number: 104, state: 'CLOSED', closedAt: daysAgo(1) })];
  assert.deepEqual(kept(items, {}), [101, 202, 203, 104]);
});

test('default filters match an item with no conversation, triage or linked issues', () => {
  assert.deepEqual(kept([issue({ conversation: null }), pr({ linkedIssues: undefined })], {}), [101, 202]);
});

test('PR-only filters never drop issues', () => {
  const items = [issue(), pr({ checks: 'FAILURE', reviewDecision: 'APPROVED', mergeable: 'CONFLICTING', linkedIssues: [{ number: 1 }], isDraft: true })];
  for (const over of [{ hideDrafts: true }, { checks: 'SUCCESS' }, { review: 'CHANGES_REQUESTED' }, { mergeable: 'MERGEABLE' }, { linked: 'none' }]) {
    assert.deepEqual(kept(items, over), [101], JSON.stringify(over));
  }
});

test('PR filters keep the PRs that match', () => {
  const failing = pr({ number: 210, checks: 'FAILURE' });
  const approved = pr({ number: 211, reviewDecision: 'APPROVED' });
  const conflicting = pr({ number: 212, mergeable: 'CONFLICTING' });
  const linked = pr({ number: 213, linkedIssues: [{ number: 1 }] });
  const items = [failing, approved, conflicting, linked];
  assert.deepEqual(kept(items, { checks: 'FAILURE' }), [210]);
  assert.deepEqual(kept(items, { review: 'APPROVED' }), [211]);
  assert.deepEqual(kept(items, { mergeable: 'CONFLICTING' }), [212]);
  assert.deepEqual(kept(items, { linked: 'some' }), [213]);
  assert.deepEqual(kept(items, { linked: 'none' }), [210, 211, 212]);
});

test('hideDrafts drops a draft PR', () => {
  assert.deepEqual(kept([pr(), pr({ number: 203, isDraft: true })], { hideDrafts: true }), [202]);
});

test('label include needs every label; exclude drops any', () => {
  const both = issue({ number: 1, labels: [label('bug'), label('📦 expo-camera')] });
  const bugOnly = issue({ number: 2, labels: [label('bug')] });
  const none = issue({ number: 3 });
  const items = [both, bugOnly, none];
  assert.deepEqual(kept(items, { include: ['bug'] }), [1, 2]);
  assert.deepEqual(kept(items, { include: ['bug', '📦 expo-camera'] }), [1]);
  assert.deepEqual(kept(items, { exclude: ['📦 expo-camera'] }), [2, 3]);
  assert.deepEqual(kept(items, { include: ['bug'], exclude: ['📦 expo-camera'] }), [2]);
});

test('ignoreLabels skips the label filters only', () => {
  const items = [issue({ number: 1, labels: [label('docs')] }), pr({ number: 2, isDraft: true, labels: [label('bug')] })];
  const over = { include: ['bug'], exclude: ['docs'], hideDrafts: true };
  assert.deepEqual(kept(items, over), []);
  assert.deepEqual(kept(items, over, { ...opts, ignoreLabels: true }), [1]);
});

test('severity threshold, with and without unrated items, and "no severity label"', () => {
  const items = [issue({ number: 0, severity: 0 }), issue({ number: 2, severity: 2 }), issue({ number: 4, severity: 4 })];
  assert.deepEqual(kept(items, { minSeverity: 3 }), [4]);
  assert.deepEqual(kept(items, { minSeverity: 3, includeUnrated: true }), [0, 4]);
  assert.deepEqual(kept(items, { minSeverity: -1 }), [0]);
  assert.deepEqual(kept(items, { includeUnrated: true }), [0, 2, 4]);
});

test('assignee: none, any, a user and @me', () => {
  const free = issue({ number: 1 });
  const alice = issue({ number: 2, assignees: [person('alice')] });
  const viewer = issue({ number: 3, assignees: [person('bob'), person('viewer')] });
  const items = [free, alice, viewer];
  assert.deepEqual(kept(items, { assignee: 'none' }), [1]);
  assert.deepEqual(kept(items, { assignee: 'any' }), [2, 3]);
  assert.deepEqual(kept(items, { assignee: 'user:alice' }), [2]);
  assert.deepEqual(kept(items, { assignee: 'user:@me' }), [3]);
  assert.deepEqual(kept(items, { assignee: 'user:@me' }, { now: NOW, me: null }), []);
});

test('assignee user match is case-insensitive', () => {
  const items = [issue({ number: 1, assignees: [person('Alice')] }), issue({ number: 2, assignees: [person('viewer')] })];
  assert.deepEqual(kept(items, { assignee: 'user:alice' }), [1]);
  assert.deepEqual(kept(items, { assignee: 'user:ALICE' }), [1]);
  assert.deepEqual(kept(items, { assignee: 'user:@me' }, { now: NOW, me: 'Viewer' }), [2]);
});

test('blank user and non-finite numbers do not filter', () => {
  const items = [issue({ severity: 0 }), pr({ severity: 4 })];
  for (const over of [{ user: ' ' }, { user: '@' }, { minSeverity: NaN }, { idleDays: NaN }]) {
    assert.deepEqual(kept(items, over), [101, 202], JSON.stringify(over));
  }
});

test('user filter: author, assignee or either, case-insensitive', () => {
  const authored = issue({ number: 1, author: { login: 'Alice' } });
  const assigned = pr({ number: 2, assignees: [person('alice')] });
  const other = issue({ number: 3, author: { login: 'bob' }, assignees: [person('carol')] });
  const items = [authored, assigned, other];
  assert.deepEqual(kept(items, { user: 'alice' }), [1, 2]);
  assert.deepEqual(kept(items, { user: 'ALICE', userRole: 'either' }), [1, 2]);
  assert.deepEqual(kept(items, { user: 'alice', userRole: 'author' }), [1]);
  assert.deepEqual(kept(items, { user: 'alice', userRole: 'assignee' }), [2]);
  assert.deepEqual(kept(items, { user: 'dave' }), []);
});

test('user filter ignores surrounding spaces and a leading @', () => {
  assert.deepEqual(kept([issue({ author: { login: 'alice' } })], { user: ' @alice ' }), [101]);
});

test('userRole alone does not filter', () => {
  assert.deepEqual(kept([issue(), pr()], { userRole: 'assignee' }), [101, 202]);
});

test('search: #number, every word of the title, author login', () => {
  const camera = issue({ number: 101, title: 'Camera crashes on Android', author: { login: 'reporter' } });
  const router = issue({ number: 55, title: 'Router loses params', author: { login: 'someone' } });
  const items = [camera, router];
  assert.deepEqual(kept(items, { q: '#55' }), [55]);
  assert.deepEqual(kept(items, { q: '101' }), [101]);
  assert.deepEqual(kept(items, { q: 'android CAMERA' }), [101]);
  assert.deepEqual(kept(items, { q: 'camera router' }), []);
  assert.deepEqual(kept(items, { q: 'someone' }), [55]);
  assert.equal(matchesQuery(camera, ''), true);
  assert.equal(matchesQuery(camera, '  crashes  '), true);
});

test('waiting on: team, never replied, owe a reply, reporter', () => {
  const never = issue({ number: 1, conversation: { waitingOn: 'team', teamReplied: false, since: daysAgo(1) } });
  const owe = issue({ number: 2, conversation: { waitingOn: 'team', teamReplied: true, since: daysAgo(1) } });
  const reporter = issue({ number: 3, conversation: { waitingOn: 'reporter', teamReplied: true, since: daysAgo(1) } });
  const items = [never, owe, reporter];
  assert.deepEqual(kept(items, { waiting: 'team' }), [1, 2]);
  assert.deepEqual(kept(items, { waiting: 'never' }), [1]);
  assert.deepEqual(kept(items, { waiting: 'owe' }), [2]);
  assert.deepEqual(kept(items, { waiting: 'reporter' }), [3]);
});

test('idle days count from conversation.since at `now`', () => {
  const recent = issue({ number: 1, conversation: { waitingOn: 'team', teamReplied: false, since: daysAgo(2) } });
  const idle = issue({ number: 2, conversation: { waitingOn: 'team', teamReplied: false, since: daysAgo(8) } });
  assert.deepEqual(kept([recent, idle], { idleDays: 7 }), [2]);
  assert.deepEqual(kept([recent, idle], { idleDays: 7 }, { now: NOW - 5 * 864e5 }), []);
});

test('created and stale windows use `now`', () => {
  const fresh = issue({ number: 1, createdAt: daysAgo(1), updatedAt: daysAgo(1) });
  const old = issue({ number: 2, createdAt: daysAgo(40), updatedAt: daysAgo(30) });
  assert.deepEqual(kept([fresh, old], { newerThanDays: 7 }), [1]);
  assert.deepEqual(kept([fresh, old], { staleDays: 14 }), [2]);
});

test('bot verdict: outcome, unverified, severity mismatch, fix PR', () => {
  const reproduced = issue({ number: 1, triage: { verification: { outcome: 'problem' }, fixPrs: [] } });
  const unverified = issue({ number: 2, triage: { assessment: { severity: { label: 'severity: high' } }, fixPrs: [9] } });
  const plain = issue({ number: 3 });
  const items = [reproduced, unverified, plain];
  assert.deepEqual(kept(items, { verdict: 'problem' }), [1]);
  assert.deepEqual(kept(items, { verdict: 'unverified' }), [2, 3]);
  assert.deepEqual(kept(items, { verdict: 'mismatch' }), [2]);
  assert.deepEqual(kept(items, { verdict: 'fixpr' }), [2]);
});

test('severityMismatch compares the bot severity with the labels', () => {
  const assessed = (labels) => issue({ labels, triage: { assessment: { severity: { label: 'severity: high' } }, fixPrs: [] } });
  assert.equal(severityMismatch(assessed([])), true);
  assert.equal(severityMismatch(assessed([label('severity: high')])), false);
  assert.equal(severityMismatch(issue()), false);
});

test('@expo-bot: never requested, requested, no reply yet', () => {
  const never = issue({ number: 1 });
  const replied = issue({ number: 2, bot: { lastCommand: { command: 'verify' }, botRepliedAfterCommand: true } });
  const pending = issue({ number: 3, bot: { lastCommand: { command: 'verify' }, botRepliedAfterCommand: false } });
  const items = [never, replied, pending];
  assert.deepEqual(kept(items, { bot: 'never' }), [1]);
  assert.deepEqual(kept(items, { bot: 'requested' }), [2, 3]);
  assert.deepEqual(kept(items, { bot: 'pending' }), [3]);
});

test('the panel keys are the keys of the defaults, with the new user filter', () => {
  assert.deepEqual(PANEL_KEYS, Object.keys(PANEL_DEFAULTS));
  assert.equal(PANEL_DEFAULTS.user, '');
  assert.equal(PANEL_DEFAULTS.userRole, 'either');
  assert.equal(PANEL_DEFAULTS.hideDrafts, false);
  for (const key of ['tab', 'state', 'cleanup', 'inboxMode', 'sort', 'view', 'filtersOpen']) assert.equal(PANEL_KEYS.includes(key), false, key);
});

test('active count is 0 for the defaults and ignores keys outside the panel', () => {
  assert.equal(activeFilterCount(filters()), 0);
  assert.equal(activeFilterCount(filters({ state: 'P3', cleanup: 'C1', filtersOpen: true, sort: 'updated' })), 0);
});

test('active count counts each set key once', () => {
  assert.equal(activeFilterCount(filters({ include: ['a', 'b', 'c'] })), 1);
  assert.equal(activeFilterCount(filters({ include: ['a'], exclude: ['b'], q: 'camera', checks: 'FAILURE' })), 4);
  assert.equal(activeFilterCount(filters({ minSeverity: 3, includeUnrated: true })), 1);
  assert.equal(activeFilterCount(filters({ user: 'alice', userRole: 'assignee' })), 1);
  assert.equal(activeFilterCount(filters({ hideDrafts: true })), 1);
});

test('active count skips modifiers that do nothing alone', () => {
  assert.equal(activeFilterCount(filters({ userRole: 'author' })), 0);
  assert.equal(activeFilterCount(filters({ includeUnrated: true })), 0);
});

test('active count skips values that do not filter', () => {
  for (const over of [{ user: ' ' }, { user: '@' }, { minSeverity: NaN }, { idleDays: NaN }, { staleDays: NaN }]) {
    assert.equal(activeFilterCount(filters(over)), 0, JSON.stringify(over));
  }
});

test('active count is the number of keys that have a chip', () => {
  const f = filters({ include: ['a', 'b'], exclude: ['c'], user: '@alice', minSeverity: 2, includeUnrated: true, q: ' ' });
  const keys = new Set(activeFilterChips(f).map((chip) => chip.key));
  assert.equal(activeFilterCount(f), keys.size);
  assert.equal(activeFilterCount(f), 4);
});

test('normalizeFilters turns non-finite numbers and unknown roles into the defaults', () => {
  const f = normalizeFilters({ ...filters({ minSeverity: NaN, idleDays: Infinity, staleDays: 14, newerThanDays: NaN, userRole: 'owner' }), state: 'P3' });
  assert.equal(f.minSeverity, 0);
  assert.equal(f.idleDays, 0);
  assert.equal(f.staleDays, 14);
  assert.equal(f.newerThanDays, 0);
  assert.equal(f.userRole, 'either');
  assert.equal(f.state, 'P3');
  assert.equal(normalizeFilters(filters({ minSeverity: -1, userRole: 'author' })).minSeverity, -1);
  assert.equal(normalizeFilters(filters({ userRole: 'author' })).userRole, 'author');
});

const chips = (over) => activeFilterChips(filters(over));
const texts = (over) => chips(over).map((chip) => chip.text);

test('no chips for the defaults or for modifiers alone', () => {
  assert.deepEqual(chips({}), []);
  assert.deepEqual(chips({ userRole: 'author', includeUnrated: true, state: 'P3' }), []);
});

test('one chip for every active panel key', () => {
  assert.deepEqual(
    texts({
      q: 'camera',
      minSeverity: 3,
      hideDrafts: true,
      checks: 'FAILURE',
      review: 'CHANGES_REQUESTED',
      mergeable: 'CONFLICTING',
      linked: 'none',
      waiting: 'owe',
      idleDays: 7,
      verdict: 'problem',
      bot: 'pending',
      assignee: 'none',
      newerThanDays: 3,
      staleDays: 30,
    }),
    [
      'Search: camera',
      'Severity ≥ medium',
      'Drafts hidden',
      'Checks failing',
      'Changes requested',
      'Has conflicts',
      'No linked issue',
      'We owe a reply',
      'Idle ≥ 7 days',
      'Bot verdict: reproduced',
      '@expo-bot: no reply yet',
      'Unassigned',
      'Created in last 3d',
      'No activity for 30d+',
    ],
  );
});

test('every chip has a unique id and resets only its own keys', () => {
  const list = chips({ q: 'camera', checks: 'FAILURE', verdict: 'fixpr' });
  assert.equal(new Set(list.map((chip) => chip.id)).size, list.length);
  assert.deepEqual(list.find((chip) => chip.id === 'checks').reset, { checks: '' });
  assert.deepEqual(list.find((chip) => chip.id === 'q').reset, { q: '' });
});

test('the severity chip includes unrated items and resets both keys', () => {
  const [chip] = chips({ minSeverity: 4, includeUnrated: true });
  assert.equal(chip.text, 'Severity ≥ high, incl. unrated');
  assert.deepEqual(chip.reset, { minSeverity: 0, includeUnrated: false });
  assert.deepEqual(texts({ minSeverity: -1 }), ['No severity label']);
});

test('the user chip names the role and resets the role too', () => {
  assert.deepEqual(texts({ user: ' @alice ' }), ['User: alice (author or assignee)']);
  assert.deepEqual(texts({ user: 'alice', userRole: 'author' }), ['User: alice (author)']);
  const [chip] = chips({ user: 'alice', userRole: 'assignee' });
  assert.equal(chip.text, 'User: alice (assignee)');
  assert.deepEqual(chip.reset, { user: '', userRole: 'either' });
});

test('assignee chips name the person or the viewer', () => {
  assert.deepEqual(texts({ assignee: 'user:alice' }), ['Assigned to alice']);
  assert.deepEqual(texts({ assignee: 'user:@me' }), ['Assigned to me']);
  assert.deepEqual(texts({ assignee: 'any' }), ['Assigned']);
});

test('one chip per label, which removes only that label', () => {
  const list = chips({ include: ['bug', 'docs'], exclude: ['stale'] });
  assert.deepEqual(list.map((chip) => chip.label), [{ name: 'bug', excluded: false }, { name: 'docs', excluded: false }, { name: 'stale', excluded: true }]);
  assert.deepEqual(list[0].reset, { include: ['docs'] });
  assert.deepEqual(list[2].reset, { exclude: [] });
  assert.notEqual(list[0].id, list[1].id);
});

test('an unknown value still gets a chip with the raw value', () => {
  assert.deepEqual(texts({ checks: 'NEUTRAL' }), ['Checks: NEUTRAL']);
});

test('normalizeUserRole keeps known roles and turns anything else into either', () => {
  for (const role of ['either', 'author', 'assignee']) assert.equal(normalizeUserRole(role), role);
  for (const role of ['', 'owner', 'AUTHOR', undefined]) assert.equal(normalizeUserRole(role), 'either');
});
