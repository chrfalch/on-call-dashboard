import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTasks, isHidden, TASK_KINDS } from './public/inbox.js';

const NOW = new Date('2026-10-26T12:00:00Z').getTime();
const daysAgo = (d) => new Date(NOW - d * 864e5).toISOString();

const issue = (over = {}) => ({
  type: 'issue',
  number: 1,
  createdAt: daysAgo(3),
  updatedAt: daysAgo(1),
  labels: [],
  assignees: [],
  severity: 0,
  thumbsUp: 0,
  bot: { lastCommand: null, botRepliedAfterCommand: false },
  triage: null,
  conversation: { waitingOn: 'team', teamReplied: false, since: daysAgo(3) },
  ...over,
});
const pr = (over = {}) => ({
  ...issue(),
  type: 'pr',
  isDraft: false,
  checks: 'SUCCESS',
  mergeable: 'MERGEABLE',
  reviewDecision: 'REVIEW_REQUIRED',
  linkedIssues: [],
  ...over,
});
const one = (item, opts) => computeTasks([item], { now: NOW, ...opts })[0];

test('new unverified issue: verify before first response', () => {
  const t = one(issue());
  assert.equal(t.kind, 'verify');
  assert.deepEqual(t.also, ['first-response']);
});

test('reproduced and unassigned wins', () => {
  const t = one(issue({ triage: { verification: { outcome: 'problem' } }, bot: { lastCommand: { command: 'verify' }, botRepliedAfterCommand: true } }));
  assert.equal(t.kind, 'assign-repro');
  assert.ok(t.reasons.some((r) => r.text === 'reproduced'));
});

test('we owe a reply', () => {
  const t = one(issue({ createdAt: daysAgo(100), conversation: { waitingOn: 'team', teamReplied: true, since: daysAgo(9) } }));
  assert.equal(t.kind, 'reply');
  assert.ok(t.reasons.some((r) => r.text === 'waiting 9d'));
});

test('severity and reactions raise the score', () => {
  const base = one(issue({ number: 2, createdAt: daysAgo(100) }));
  const hot = one(issue({ number: 3, createdAt: daysAgo(100), severity: 4, labels: [{ name: 'severity: high' }], thumbsUp: 4 }));
  assert.ok(hot.score > base.score + 25);
});

test('on-call: skips owned items and owner-only task kinds, no personal boost', () => {
  assert.equal(one(issue({ assignees: [{ login: 'kudo' }] }), { me: 'me' }), undefined);
  assert.equal(one(issue({ assignees: [{ login: 'kudo' }] }), { me: 'me', includeAssigned: true }).kind, 'verify');
  assert.equal(one(pr({ reviewDecision: 'APPROVED' })), undefined); // merging is the owner's job
  assert.equal(one(pr()).kind, 'bot-review');
  const mine = one(issue({ assignees: [{ login: 'me' }] }), { me: 'me', includeAssigned: true });
  const theirs = one(issue({ assignees: [{ login: 'kudo' }] }), { me: 'me', includeAssigned: true });
  assert.equal(mine.score, theirs.score);
});

test('my work: only items assigned to me or requesting my review, all task kinds', () => {
  const opts = { me: 'me', mode: 'mine' };
  assert.equal(one(issue(), opts), undefined);
  assert.equal(one(pr({ reviewDecision: 'APPROVED', assignees: [{ login: 'me' }] }), opts).kind, 'merge');
  const t = one(pr({ bot: { lastCommand: { command: 'review' }, botRepliedAfterCommand: true }, reviewRequests: [{ login: 'me' }] }), opts);
  assert.equal(t.kind, 'review');
  assert.ok(t.reasons.some((r) => r.text === 'your review requested'));
});

test('stale issue waiting on reporter -> close, unless accepted', () => {
  const stale = { createdAt: daysAgo(200), conversation: { waitingOn: 'reporter', teamReplied: true, since: daysAgo(30) } };
  assert.equal(one(issue(stale)).kind, 'close');
  assert.equal(one(issue({ ...stale, labels: [{ name: 'Issue accepted' }] })), undefined);
});

const linkedPr = (number, over = {}) => ({ number, title: `Fix ${number}`, state: 'MERGED', mergedAt: daysAgo(5), baseRefName: 'main', ...over });
// Old enough to skip verify, and waiting on the reporter for too short a time to be stale.
const quiet = { createdAt: daysAgo(60), conversation: { waitingOn: 'reporter', teamReplied: true, since: daysAgo(2) } };
const kinds = (t) => (t ? [t.kind, ...t.also] : []);

test('close candidate is an on-call task that closes the issue', () => {
  const { label, action, oncall } = TASK_KINDS['close-candidate'];
  assert.deepEqual({ label, action, oncall }, { label: 'Close candidate', action: 'close', oncall: true });
});

test('issue with a merged linked PR -> close candidate, one reason per merged PR', () => {
  const t = one(issue({ ...quiet, linkedPrs: [linkedPr(10), linkedPr(11, { state: 'OPEN', mergedAt: null }), linkedPr(12, { mergedAt: daysAgo(40), baseRefName: 'stack/router' })] }));
  assert.equal(t.kind, 'close-candidate');
  assert.deepEqual(t.reasons.map((r) => r.text), ['#10 merged 5d ago into main', '#12 merged 40d ago into stack/router']);
});

test('no close candidate without a merged linked PR', () => {
  assert.ok(!kinds(one(issue({ ...quiet, linkedPrs: [linkedPr(10, { state: 'OPEN', mergedAt: null }), linkedPr(11, { state: 'CLOSED', mergedAt: null })] }))).includes('close-candidate'));
  assert.ok(!kinds(one(issue({ ...quiet, linkedPrs: [] }))).includes('close-candidate'));
  assert.doesNotThrow(() => assert.equal(one(issue(quiet)), undefined), 'old cached issues have no linkedPrs');
});

test('no close candidate for parked issues or PRs', () => {
  for (const label of ['Issue accepted', '✋ on hold']) assert.equal(one(issue({ ...quiet, labels: [{ name: label }], linkedPrs: [linkedPr(10)] })), undefined, label);
  assert.ok(!kinds(one(pr({ linkedPrs: [linkedPr(10)] }))).includes('close-candidate'));
});

test('close candidate ranks above stale close', () => {
  const t = one(issue({ createdAt: daysAgo(200), conversation: { waitingOn: 'reporter', teamReplied: true, since: daysAgo(30) }, linkedPrs: [linkedPr(10)] }));
  assert.equal(t.kind, 'close-candidate');
  assert.deepEqual(t.also, ['close']);
});

test('internal issues get no reply/verify tasks', () => {
  assert.equal(one(issue({ conversation: { waitingOn: 'internal', teamReplied: true, since: daysAgo(1) } })), undefined);
});

test('PRs: merge, bot review first, then human review', () => {
  const all = { me: 'me', mode: 'mine' };
  const mine = { assignees: [{ login: 'me' }] };
  assert.equal(one(pr({ ...mine, reviewDecision: 'APPROVED' }), all).kind, 'merge');
  assert.equal(one(pr(mine), all).kind, 'bot-review');
  assert.equal(one(pr({ ...mine, bot: { lastCommand: { command: 'review' }, botRepliedAfterCommand: false } }), all), undefined);
  assert.equal(one(pr({ ...mine, bot: { lastCommand: { command: 'review' }, botRepliedAfterCommand: true } }), all).kind, 'review');
  assert.equal(one(pr({ ...mine, isDraft: true, reviewDecision: 'APPROVED' }), all), undefined);
});

test('close-candidate scores 45 before bonuses', () => {
  const t = one(issue({
    triage: { verification: { outcome: 'pass' } },
    conversation: { waitingOn: 'reporter', teamReplied: true, since: daysAgo(1) },
    linkedPrs: [{ number: 7, title: 'Fix', state: 'MERGED', mergedAt: daysAgo(2), baseRefName: 'main' }],
  }));
  assert.equal(t.kind, 'close-candidate');
  assert.deepEqual(t.also, []);
  assert.equal(t.score, 45);
});

test('done hides until the item changes; snooze hides until a date', () => {
  const t = one(issue());
  assert.equal(isHidden(t, { [t.key]: { doneAt: NOW, updatedAt: t.item.updatedAt } }, NOW), true);
  assert.equal(isHidden(t, { [t.key]: { doneAt: NOW, updatedAt: daysAgo(5) } }, NOW), false);
  assert.equal(isHidden(t, { [t.key]: { snoozeUntil: NOW + 1000 } }, NOW), true);
  assert.equal(isHidden(t, { [t.key]: { snoozeUntil: NOW - 1000 } }, NOW), false);
});
