import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDone, pruneDone, startHereRows, withDone } from './public/start-here.js';

const NOW = new Date(2026, 9, 27, 9, 0).getTime();
const hoursAgo = (h) => new Date(NOW - h * 36e5).toISOString();
const daysAgo = (d) => hoursAgo(d * 24);
const ms = (iso) => new Date(iso).getTime();

const issue = (over = {}) => ({
  type: 'issue',
  number: 1,
  title: 'Crash on launch',
  url: 'https://github.com/expo/expo/issues/1',
  state: 'OPEN',
  createdAt: daysAgo(10),
  updatedAt: hoursAgo(1),
  author: { login: 'reporter' },
  authorAssociation: 'NONE',
  labels: [],
  assignees: [],
  comments: [],
  assignedEvents: [],
  ...over,
});
const pr = (over = {}) => ({ ...issue(), type: 'pr', url: 'https://github.com/expo/expo/pull/1', reviewRequests: [], lastCommitAt: null, lastCommitBy: null, ...over });

const ME = 'oncall';
const comment = (login, at, over = {}) => ({ login, association: 'NONE', at, ...over });
const mine = (at) => comment(ME, at, { association: 'MEMBER' });
const assignedToMe = { assignees: [{ login: ME }] };

const rows = (items, options = {}) => startHereRows(items, { me: ME, ...options });
const only = (item, options) => {
  const found = rows([item], options);
  assert.equal(found.length, 1, 'one row');
  return found[0];
};
const summary = (row) => ({ number: row.item.number, status: row.status, at: row.at });

test('an item I commented on is listed as Waiting, dated by my comment', () => {
  const item = issue({ comments: [comment('reporter', hoursAgo(9)), mine(hoursAgo(5))] });
  const row = only(item);
  assert.equal(row.item, item);
  assert.equal(row.key, 'issue#1');
  assert.deepEqual(summary(row), { number: 1, status: 'waiting', at: hoursAgo(5) });
});

test('a comment from someone else after mine makes it Replied, dated by that comment', () => {
  const item = issue({ comments: [mine(hoursAgo(5)), comment('reporter', hoursAgo(3)), comment('someone', hoursAgo(2))] });
  assert.deepEqual(summary(only(item)), { number: 1, status: 'replied', at: hoursAgo(2) });
});

test('a review from someone else after mine makes it Replied', () => {
  const item = pr({ comments: [mine(hoursAgo(5)), comment('reviewer', hoursAgo(2), { association: 'MEMBER', review: 'APPROVED' })] });
  assert.deepEqual(summary(only(item)), { number: 1, status: 'replied', at: hoursAgo(2) });
});

test('a bot comment after mine makes it Replied', () => {
  const item = pr({ comments: [mine(hoursAgo(5)), comment('expo-bot', hoursAgo(4), { association: 'MEMBER' })] });
  assert.deepEqual(summary(only(item)), { number: 1, status: 'replied', at: hoursAgo(4) });
});

test('expo-bot answering by editing an older comment makes it Replied, dated by the edit', () => {
  const item = pr({ comments: [comment('expo-bot', hoursAgo(20), { association: 'MEMBER', editedAt: hoursAgo(2) }), mine(hoursAgo(5))] });
  assert.deepEqual(summary(only(item)), { number: 1, status: 'replied', at: hoursAgo(2) });
});

test('a bot comment from before my command stays Waiting when it was not edited after', () => {
  const unedited = pr({ comments: [comment('expo-bot', hoursAgo(20), { association: 'MEMBER' }), mine(hoursAgo(5))] });
  const editedBefore = pr({ comments: [comment('expo-bot', hoursAgo(20), { association: 'MEMBER', editedAt: hoursAgo(6) }), mine(hoursAgo(5))] });
  assert.equal(only(unedited).status, 'waiting');
  assert.equal(only(editedBefore).status, 'waiting');
});

test('a person editing an older comment is not a reply', () => {
  const item = issue({ comments: [comment('reporter', hoursAgo(20), { editedAt: hoursAgo(2) }), mine(hoursAgo(5))] });
  assert.equal(only(item).status, 'waiting');
});

test('a push by someone else after my last write makes it Replied, dated by the push', () => {
  const item = pr({ comments: [mine(hoursAgo(5))], lastCommitAt: hoursAgo(3), lastCommitBy: 'contributor' });
  assert.deepEqual(summary(only(item)), { number: 1, status: 'replied', at: hoursAgo(3) });
});

test('a push by me, by a bot or by an unknown author is not a reply', () => {
  for (const lastCommitBy of [ME, 'dependabot', 'renovate[bot]', null, undefined]) {
    const item = pr({ comments: [mine(hoursAgo(5))], lastCommitAt: hoursAgo(3), lastCommitBy });
    assert.equal(only(item).status, 'waiting', String(lastCommitBy));
  }
});

test('a push before my last write is not a reply', () => {
  const item = pr({ comments: [mine(hoursAgo(5))], lastCommitAt: hoursAgo(6), lastCommitBy: 'contributor' });
  assert.equal(only(item).status, 'waiting');
});

test('Replied is dated by the newest reply, comment or push', () => {
  const item = pr({ comments: [mine(hoursAgo(9)), comment('reporter', hoursAgo(4))], lastCommitAt: hoursAgo(2), lastCommitBy: 'contributor' });
  assert.equal(only(item).at, hoursAgo(2));
});

test('my comment or review on a fix PR counts as a write on the issue', () => {
  const linked = (fix) => issue({ number: 1, comments: [comment('reporter', hoursAgo(5))], linkedPrs: [{ number: 2, state: 'OPEN', fix }] });
  const fixPr = pr({ number: 2, comments: [comment(ME, hoursAgo(3), { review: 'CHANGES_REQUESTED' })] });
  const numbers = (items) => rows(items).map(summary);
  assert.deepEqual(numbers([linked(true), fixPr]), [
    { number: 1, status: 'waiting', at: hoursAgo(3) },
    { number: 2, status: 'waiting', at: hoursAgo(3) },
  ]);
  assert.deepEqual(numbers([linked(false), fixPr]), [{ number: 2, status: 'waiting', at: hoursAgo(3) }], 'not a fix PR');
});

test('an item I own and never wrote on is Assigned, dated by my newest assignment', () => {
  const item = issue({
    ...assignedToMe,
    comments: [comment('reporter', hoursAgo(2))],
    assignedEvents: [{ login: ME, at: hoursAgo(30) }, { login: 'colleague', at: hoursAgo(10) }, { login: ME, at: hoursAgo(20) }],
  });
  assert.deepEqual(summary(only(item)), { number: 1, status: 'assigned', at: hoursAgo(20) });
});

test('Assigned without an assignment event is dated by the item creation', () => {
  assert.deepEqual(summary(only(issue({ ...assignedToMe, createdAt: daysAgo(3) }))), { number: 1, status: 'assigned', at: daysAgo(3) });
});

test('a PR that requests my review is owned', () => {
  const requested = pr({ number: 1, reviewRequests: [{ login: ME }] });
  const otherReviewer = pr({ number: 2, reviewRequests: [{ login: 'colleague' }] });
  assert.deepEqual(rows([requested, otherReviewer]).map(summary), [{ number: 1, status: 'assigned', at: requested.createdAt }]);
});

test('an owned item I wrote on gets the status of my writes', () => {
  assert.equal(only(issue({ ...assignedToMe, comments: [mine(hoursAgo(5))] })).status, 'waiting');
  assert.equal(only(issue({ ...assignedToMe, comments: [mine(hoursAgo(5)), comment('reporter', hoursAgo(1))] })).status, 'replied');
});

test('items I neither wrote on nor own are not listed', () => {
  const items = [
    issue({ number: 1, comments: [comment('reporter', hoursAgo(2))] }),
    issue({ number: 2, assignees: [{ login: 'colleague' }], assignedEvents: [{ login: ME, at: hoursAgo(5) }] }),
  ];
  assert.deepEqual(rows(items), []);
});

test('closed and merged items are not listed', () => {
  const items = [
    issue({ number: 1, state: 'CLOSED', ...assignedToMe }),
    pr({ number: 2, state: 'MERGED', comments: [mine(hoursAgo(5))] }),
  ];
  assert.deepEqual(rows(items), []);
});

test('an item opened by the team is listed with includeInternal', () => {
  const item = issue({ author: { login: 'colleague' }, authorAssociation: 'MEMBER', comments: [mine(hoursAgo(5))] });
  assert.equal(only(item, { includeInternal: true }).status, 'waiting');
});

test('items opened by members, owners and collaborators are not listed by default', () => {
  const items = ['MEMBER', 'OWNER', 'COLLABORATOR'].map((authorAssociation, i) =>
    issue({ number: i + 1, author: { login: 'colleague' }, authorAssociation, ...assignedToMe, comments: [mine(hoursAgo(5))] }));
  assert.deepEqual(rows(items), []);
  assert.deepEqual(rows(items, { includeInternal: true }).map((row) => row.item.number).sort(), [1, 2, 3]);
});

test('an item opened by a community member is listed with or without includeInternal', () => {
  const item = pr({ authorAssociation: 'CONTRIBUTOR', comments: [mine(hoursAgo(5))] });
  assert.equal(only(item).status, 'waiting');
  assert.equal(only(item, { includeInternal: true }).status, 'waiting');
});

test('signed out lists nothing, even with comments by deleted users', () => {
  const items = [issue({ ...assignedToMe, comments: [comment(null, hoursAgo(5))] })];
  assert.deepEqual(startHereRows(items, { me: null }), []);
});

test('order: Replied, then Assigned, then Waiting; newest first in each', () => {
  const items = [
    issue({ number: 1, comments: [mine(hoursAgo(1))] }),
    issue({ number: 2, ...assignedToMe, assignedEvents: [{ login: ME, at: hoursAgo(8) }] }),
    issue({ number: 3, comments: [mine(hoursAgo(9)), comment('reporter', hoursAgo(7))] }),
    issue({ number: 4, comments: [mine(hoursAgo(6))] }),
    issue({ number: 5, ...assignedToMe, assignedEvents: [{ login: ME, at: hoursAgo(2) }] }),
    issue({ number: 6, comments: [mine(hoursAgo(9)), comment('reporter', hoursAgo(3))] }),
  ];
  assert.deepEqual(
    rows(items).map((row) => [row.item.number, row.status]),
    [[6, 'replied'], [3, 'replied'], [5, 'assigned'], [2, 'assigned'], [1, 'waiting'], [4, 'waiting']],
  );
});

test('done: hides the row; a reply does not bring it back', () => {
  const waiting = issue({ comments: [mine(hoursAgo(5))] });
  const done = withDone({}, waiting, NOW - 36e5);
  assert.deepEqual(rows([waiting], { done }), []);
  const replied = issue({ comments: [mine(hoursAgo(5)), comment('reporter', hoursAgo(0.5))] });
  assert.deepEqual(rows([replied], { done }), []);
});

test('done: my next write brings the row back', () => {
  const done = withDone({}, issue(), NOW - 2 * 36e5);
  const item = issue({ comments: [mine(hoursAgo(5)), mine(hoursAgo(1))] });
  assert.deepEqual(summary(only(item, { done })), { number: 1, status: 'waiting', at: hoursAgo(1) });
});

test('done: my next write on a fix PR brings the issue back', () => {
  const done = withDone({}, issue(), NOW - 2 * 36e5);
  const items = [issue({ comments: [mine(hoursAgo(5))], linkedPrs: [{ number: 2, state: 'OPEN', fix: true }] }), pr({ number: 2, comments: [mine(hoursAgo(1))] })];
  assert.deepEqual(rows(items, { done }).map((row) => row.key), ['issue#1', 'pr#2']);
});

test('done: an Assigned row stays hidden while any done entry exists', () => {
  const item = issue({ ...assignedToMe, assignedEvents: [{ login: ME, at: hoursAgo(1) }] });
  assert.deepEqual(rows([item], { done: { 'issue#1': NOW - 30 * 864e5 } }), []);
  assert.equal(rows([item], { done: { 'pr#1': NOW } }).length, 1, 'keyed by type and number');
});

test('skip: hides the row until a newer event', () => {
  const skipped = { 'issue#1': NOW - 2 * 36e5 };
  assert.deepEqual(rows([issue({ comments: [mine(hoursAgo(5)), comment('reporter', hoursAgo(3))] })], { skipped }), []);
  assert.equal(only(issue({ comments: [mine(hoursAgo(5)), comment('reporter', hoursAgo(1))] }), { skipped }).status, 'replied');
  assert.deepEqual(rows([issue({ ...assignedToMe, assignedEvents: [{ login: ME, at: hoursAgo(3) }] })], { skipped }), []);
});

test('withDone: records the time without changing its input', () => {
  const done = { 'issue#7': 5 };
  assert.deepEqual(withDone(done, pr({ number: 9 }), NOW), { 'issue#7': 5, 'pr#9': NOW });
  assert.deepEqual(done, { 'issue#7': 5 });
});

test('pruneDone: drops entries for closed items and items missing from the list', () => {
  const done = { 'issue#1': 1, 'issue#2': 2, 'pr#3': 3, 'issue#4': 4 };
  const items = [issue({ number: 1 }), issue({ number: 2, state: 'CLOSED' }), pr({ number: 3, state: 'MERGED' }), pr({ number: 4 })];
  assert.deepEqual(pruneDone(done, items), { 'issue#1': 1 });
});

test('pruneDone: keeps every entry while the item list is empty', () => {
  const done = { 'issue#1': 1, 'pr#2': 2 };
  assert.deepEqual(pruneDone(done, []), done);
});

test('parseDone: a JSON map of numbers, anything else is empty', () => {
  assert.deepEqual(parseDone('{"issue#1":5,"pr#2":"x"}'), { 'issue#1': 5 });
  assert.deepEqual(parseDone(null), {});
  assert.deepEqual(parseDone('not json'), {});
  assert.deepEqual(parseDone('[1,2]'), {});
});

test('an item from an old cache without comments or assigned events does not throw', () => {
  const { comments, assignedEvents, ...oldShape } = issue({ ...assignedToMe });
  assert.equal(only(oldShape).status, 'assigned');
});

test('event times are compared as instants', () => {
  const item = issue({ comments: [mine('2026-10-27T05:00:00Z'), comment('reporter', '2026-10-27T06:00:00.000+00:00')] });
  assert.equal(ms(only(item).at), ms('2026-10-27T06:00:00Z'));
  assert.equal(only(item).status, 'replied');
});
