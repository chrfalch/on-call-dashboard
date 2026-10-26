import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VIEWS, GROUPS, applyView, viewCounts } from './public/views.js';

const NOW = new Date('2026-10-26T12:00:00Z').getTime();
const daysAgo = (d) => new Date(NOW - d * 864e5).toISOString();
const labels = (...names) => names.map((name) => ({ name }));
const waiting = (waitingOn, d = 3) => ({ waitingOn, teamReplied: waitingOn !== 'team', since: daysAgo(d) });

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
  conversation: waiting('team'),
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
  latestReviews: [],
  reviewRequests: [],
  ...over,
});
const ext = (over = {}) => pr({ labels: labels('contributor: external'), ...over });
const internal = (over = {}) => pr({ labels: labels('contributor: internal'), ...over });

const view = (id) => VIEWS.find((v) => v.id === id);
const inView = (id, item) => applyView(view(id), [item], { now: NOW }).length === 1;
const order = (id, items) => applyView(view(id), items, { now: NOW }).map((i) => i.number);
const assignee = { assignees: [{ login: 'kudo' }] };
const reproduced = { triage: { verification: { outcome: 'problem', at: daysAgo(2) } } };

test('views are listed in group display order', () => {
  assert.deepEqual(
    VIEWS.map((v) => v.id),
    [
      'issue:triage-queue',
      'issue:reproduced-unowned',
      'issue:accepted-unowned',
      'issue:unlabeled-unowned',
      'issue:awaiting-reporter',
      'issue:owner-followup',
      'pr:external-first-review',
      'pr:external-blocked-unreviewed',
      'pr:changes-requested-author-replied',
      'pr:stale-external',
      'pr:ready-to-merge',
      'pr:approved-blocked',
      'pr:internal-review',
    ],
  );
  assert.deepEqual(GROUPS.issue.map((g) => g.id), ['oncall', 'team']);
  assert.deepEqual(GROUPS.pr.map((g) => g.id), ['external', 'merge', 'internal']);
});

test('every view has the required fields and a group from its scope', () => {
  for (const v of VIEWS) {
    for (const key of ['id', 'scope', 'group', 'name', 'audience', 'step', 'hint']) assert.ok(v[key], `${v.id} lacks ${key}`);
    assert.equal(typeof v.match, 'function');
    assert.equal(typeof v.compare, 'function');
    assert.ok(GROUPS[v.scope].some((g) => g.id === v.group), `${v.id}: group ${v.group}`);
    assert.ok(v.id.startsWith(`${v.scope}:`));
  }
  for (const groups of Object.values(GROUPS)) for (const g of groups) assert.ok(g.title);
});

test('a view only matches items of its own scope', () => {
  assert.equal(inView('pr:internal-review', issue({ labels: labels('contributor: internal') })), false);
  assert.equal(inView('issue:triage-queue', pr({ labels: labels('needs review') })), false);
});

test('I1 triage queue: needs review, unassigned, waiting on the team', () => {
  const base = { labels: labels('needs review') };
  assert.equal(inView('issue:triage-queue', issue(base)), true);
  assert.equal(inView('issue:triage-queue', issue({ ...base, ...assignee })), false);
  assert.equal(inView('issue:triage-queue', issue({ labels: labels('Issue accepted') })), false);
  assert.equal(inView('issue:triage-queue', issue({ ...base, conversation: waiting('reporter') })), false);
  assert.equal(inView('issue:triage-queue', issue({ ...base, conversation: waiting('internal') })), false);
});

test('I1 sorts strictly newest first, ignoring severity', () => {
  const base = { labels: labels('needs review') };
  const items = [
    issue({ ...base, number: 1, createdAt: daysAgo(10), severity: 5 }),
    issue({ ...base, number: 2, createdAt: daysAgo(1), severity: 0 }),
    issue({ ...base, number: 3, createdAt: daysAgo(10) }),
  ];
  assert.deepEqual(order('issue:triage-queue', items), [2, 3, 1]);
});

test('I2 reproduced, unowned: severity first, then oldest verification', () => {
  assert.equal(inView('issue:reproduced-unowned', issue(reproduced)), true);
  assert.equal(inView('issue:reproduced-unowned', issue({ ...reproduced, ...assignee })), false);
  const at = (d) => ({ triage: { verification: { outcome: 'problem', at: daysAgo(d) } } });
  const items = [
    issue({ number: 1, ...at(9) }),
    issue({ number: 2, ...at(1), severity: 4 }),
    issue({ number: 3, ...at(20) }),
  ];
  assert.deepEqual(order('issue:reproduced-unowned', items), [2, 3, 1]);
});

test('I3 accepted, unowned: severity first, then oldest', () => {
  const base = { labels: labels('Issue accepted') };
  assert.equal(inView('issue:accepted-unowned', issue(base)), true);
  assert.equal(inView('issue:accepted-unowned', issue({ ...base, ...assignee })), false);
  const items = [
    issue({ ...base, number: 1, createdAt: daysAgo(100) }),
    issue({ ...base, number: 2, createdAt: daysAgo(500) }),
    issue({ ...base, number: 3, createdAt: daysAgo(5), severity: 3 }),
  ];
  assert.deepEqual(order('issue:accepted-unowned', items), [3, 2, 1]);
});

test('I4 fell through triage: no triage label, unassigned, not internal', () => {
  assert.equal(inView('issue:unlabeled-unowned', issue({ labels: labels('docs') })), true);
  for (const label of ['needs review', 'Issue accepted', 'needs more info', '✋ on hold'])
    assert.equal(inView('issue:unlabeled-unowned', issue({ labels: labels(label) })), false, label);
  assert.equal(inView('issue:unlabeled-unowned', issue(assignee)), false);
  assert.equal(inView('issue:unlabeled-unowned', issue({ conversation: waiting('internal') })), false);
});

test('I5 reporter silent 14d+, unless parked', () => {
  const base = { conversation: waiting('reporter', 14) };
  assert.equal(inView('issue:awaiting-reporter', issue(base)), true);
  assert.equal(inView('issue:awaiting-reporter', issue({ conversation: waiting('reporter', 13) })), false);
  assert.equal(inView('issue:awaiting-reporter', issue({ ...base, labels: labels('Issue accepted') })), false);
  assert.equal(inView('issue:awaiting-reporter', issue({ ...base, labels: labels('✋ on hold') })), false);
  assert.equal(inView('issue:awaiting-reporter', issue({ conversation: waiting('team', 30) })), false);
  const items = [
    issue({ number: 2, conversation: waiting('reporter', 20) }),
    issue({ number: 1, conversation: waiting('reporter', 20) }),
    issue({ number: 3, conversation: waiting('reporter', 60) }),
  ];
  assert.deepEqual(order('issue:awaiting-reporter', items), [3, 1, 2]);
});

test('I6 owner follow-up: needs review, assigned, team silent 14d+', () => {
  const base = { labels: labels('needs review'), ...assignee, conversation: waiting('team', 14) };
  assert.equal(inView('issue:owner-followup', issue(base)), true);
  assert.equal(inView('issue:owner-followup', issue({ ...base, conversation: waiting('team', 13) })), false);
  assert.equal(inView('issue:owner-followup', issue({ ...base, assignees: [] })), false);
  assert.equal(inView('issue:owner-followup', issue({ ...base, conversation: waiting('reporter', 30) })), false);
});

test('P1 external first review: green, clean, unreviewed, unrequested', () => {
  assert.equal(inView('pr:external-first-review', ext()), true);
  assert.equal(inView('pr:external-first-review', ext({ latestReviews: [{ state: 'COMMENTED', login: 'kudo' }] })), false);
  assert.equal(inView('pr:external-first-review', ext({ reviewRequests: [{ login: 'kudo' }] })), false);
  assert.equal(inView('pr:external-first-review', ext({ conversation: waiting('reporter') })), false);
  assert.equal(inView('pr:external-first-review', ext({ isDraft: true })), false);
  assert.equal(inView('pr:external-first-review', ext({ checks: 'FAILURE' })), false);
  assert.equal(inView('pr:external-first-review', pr()), false);
});

test('P1 sorts bot-reviewed, then no bot command, then bot pending; older first within a tier', () => {
  const done = { bot: { lastCommand: { command: 'review' }, botRepliedAfterCommand: true } };
  const pending = { bot: { lastCommand: { command: 'review' }, botRepliedAfterCommand: false } };
  const items = [
    ext({ number: 1, createdAt: daysAgo(50), ...pending }),
    ext({ number: 2, createdAt: daysAgo(40) }),
    ext({ number: 3, createdAt: daysAgo(2), ...done }),
    ext({ number: 4, createdAt: daysAgo(30) }),
    ext({ number: 5, createdAt: daysAgo(9), ...done }),
  ];
  assert.deepEqual(order('pr:external-first-review', items), [5, 3, 2, 4, 1]);
});

test('P2 external, unreviewed, failing or conflicting', () => {
  assert.equal(inView('pr:external-blocked-unreviewed', ext({ checks: 'FAILURE' })), true);
  assert.equal(inView('pr:external-blocked-unreviewed', ext({ mergeable: 'CONFLICTING' })), true);
  assert.equal(inView('pr:external-blocked-unreviewed', ext()), false);
  assert.equal(inView('pr:external-blocked-unreviewed', ext({ checks: 'FAILURE', latestReviews: [{ state: 'COMMENTED' }] })), false);
  const items = [ext({ number: 1, checks: 'FAILURE', updatedAt: daysAgo(2) }), ext({ number: 2, checks: 'FAILURE', updatedAt: daysAgo(8) })];
  assert.deepEqual(order('pr:external-blocked-unreviewed', items), [2, 1]);
});

test('P3 ready to merge: external first, then least recently updated', () => {
  const ok = { reviewDecision: 'APPROVED' };
  assert.equal(inView('pr:ready-to-merge', pr(ok)), true);
  assert.equal(inView('pr:ready-to-merge', pr({ ...ok, isDraft: true })), false);
  assert.equal(inView('pr:ready-to-merge', pr({ ...ok, mergeable: 'CONFLICTING' })), false);
  const items = [
    internal({ ...ok, number: 1, updatedAt: daysAgo(30) }),
    ext({ ...ok, number: 2, updatedAt: daysAgo(1) }),
    ext({ ...ok, number: 3, updatedAt: daysAgo(5) }),
  ];
  assert.deepEqual(order('pr:ready-to-merge', items), [3, 2, 1]);
});

test('P4 approved but blocked: external first, then least recently updated', () => {
  const ok = { reviewDecision: 'APPROVED', mergeable: 'CONFLICTING' };
  assert.equal(inView('pr:approved-blocked', pr(ok)), true);
  assert.equal(inView('pr:approved-blocked', pr({ reviewDecision: 'APPROVED', checks: 'FAILURE' })), true);
  assert.equal(inView('pr:approved-blocked', pr({ ...ok, mergeable: 'MERGEABLE' })), false);
  const items = [internal({ ...ok, number: 1, updatedAt: daysAgo(30) }), ext({ ...ok, number: 2, updatedAt: daysAgo(1) })];
  assert.deepEqual(order('pr:approved-blocked', items), [2, 1]);
});

test('P5 changes requested, author replied', () => {
  const base = { reviewDecision: 'CHANGES_REQUESTED' };
  assert.equal(inView('pr:changes-requested-author-replied', ext(base)), true);
  assert.equal(inView('pr:changes-requested-author-replied', ext({ ...base, conversation: waiting('reporter') })), false);
  assert.equal(inView('pr:changes-requested-author-replied', internal(base)), false);
  const items = [ext({ ...base, number: 1, conversation: waiting('team', 2) }), ext({ ...base, number: 2, conversation: waiting('team', 9) })];
  assert.deepEqual(order('pr:changes-requested-author-replied', items), [2, 1]);
});

test('P6 stale external: waiting on the author, idle 60d+', () => {
  const base = { conversation: waiting('reporter', 70), updatedAt: daysAgo(60) };
  assert.equal(inView('pr:stale-external', ext(base)), true);
  assert.equal(inView('pr:stale-external', ext({ ...base, updatedAt: daysAgo(59) })), false);
  assert.equal(inView('pr:stale-external', ext({ ...base, conversation: waiting('team', 70) })), false);
  assert.equal(inView('pr:stale-external', ext({ ...base, conversation: waiting('internal', 70) })), false);
  assert.equal(inView('pr:stale-external', internal(base)), false);
});

test('P7 internal review: internal, review required', () => {
  assert.equal(inView('pr:internal-review', internal()), true);
  assert.equal(inView('pr:internal-review', ext()), false);
  assert.equal(inView('pr:internal-review', internal({ isDraft: true })), false);
  assert.equal(inView('pr:internal-review', internal({ reviewDecision: 'APPROVED' })), false);
  const items = [internal({ number: 2, createdAt: daysAgo(5) }), internal({ number: 1, createdAt: daysAgo(5) }), internal({ number: 3, createdAt: daysAgo(1) })];
  assert.deepEqual(order('pr:internal-review', items), [1, 2, 3]);
});

test('applyView does not mutate its input', () => {
  const items = [issue({ number: 1, labels: labels('needs review'), createdAt: daysAgo(9) }), issue({ number: 2, labels: labels('needs review') })];
  applyView(view('issue:triage-queue'), items, { now: NOW });
  assert.deepEqual(items.map((i) => i.number), [1, 2]);
});

test('viewCounts over a hand-built fixture', () => {
  const items = [
    issue({ number: 10, labels: labels('needs review') }), // I1
    issue({ number: 11, labels: labels('needs review'), createdAt: daysAgo(40) }), // I1
    issue({ number: 12, ...reproduced }), // I2, I4
    issue({ number: 13, labels: labels('Issue accepted'), conversation: waiting('reporter', 20) }), // I3 (parked, not I5)
    issue({ number: 14, labels: labels('needs review'), ...assignee, conversation: waiting('team', 20) }), // I6
    issue({ number: 15, ...assignee, conversation: waiting('reporter', 30) }), // I5
    issue({ number: 16, labels: labels('needs review'), conversation: waiting('internal') }), // none
    ext({ number: 20 }), // P1
    ext({ number: 21, checks: 'FAILURE' }), // P2
    ext({ number: 22, reviewDecision: 'APPROVED' }), // P3
    internal({ number: 23, reviewDecision: 'APPROVED', mergeable: 'CONFLICTING' }), // P4
    ext({ number: 24, reviewDecision: 'CHANGES_REQUESTED', latestReviews: [{ state: 'CHANGES_REQUESTED' }] }), // P5
    ext({ number: 25, conversation: waiting('reporter', 90), updatedAt: daysAgo(90), latestReviews: [{ state: 'COMMENTED' }] }), // P6
    internal({ number: 26 }), // P7
    internal({ number: 27, checks: 'FAILURE' }), // P7
    internal({ number: 28, isDraft: true }), // none
    ext({ number: 29, isDraft: true }), // none
  ];
  assert.deepEqual(viewCounts(items, { now: NOW }), {
    'issue:triage-queue': 2,
    'issue:reproduced-unowned': 1,
    'issue:accepted-unowned': 1,
    'issue:unlabeled-unowned': 1,
    'issue:awaiting-reporter': 1,
    'issue:owner-followup': 1,
    'pr:external-first-review': 1,
    'pr:external-blocked-unreviewed': 1,
    'pr:changes-requested-author-replied': 1,
    'pr:stale-external': 1,
    'pr:ready-to-merge': 1,
    'pr:approved-blocked': 1,
    'pr:internal-review': 2,
  });
});
