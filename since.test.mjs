import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSkipped, sinceButtons, sinceGroups, sinceStart, skipKey, withSkip } from './public/since.js';

// Tuesday 27 October 2026, 09:00 local time; the window starts Monday 00:00.
const NOW = new Date(2026, 9, 27, 9, 0).getTime();
const hoursAgo = (h) => new Date(NOW - h * 36e5).toISOString();
const daysAgo = (d) => hoursAgo(d * 24);

const issue = (over = {}) => ({
  type: 'issue',
  number: 1,
  title: 'Crash on launch',
  url: 'https://github.com/expo/expo/issues/1',
  state: 'OPEN',
  createdAt: hoursAgo(5),
  updatedAt: hoursAgo(1),
  author: { login: 'reporter' },
  authorAssociation: 'NONE',
  labels: [],
  assignees: [],
  comments: [],
  assignedEvents: [],
  severity: 0,
  bot: { lastCommand: null, botRepliedAfterCommand: false, lastReview: null, botRepliedAfterReview: false },
  triage: null,
  conversation: { waitingOn: 'team', teamReplied: false, since: hoursAgo(5) },
  ...over,
});
const pr = (over = {}) => ({
  ...issue(),
  type: 'pr',
  url: 'https://github.com/expo/expo/pull/1',
  isDraft: false,
  checks: 'SUCCESS',
  mergeable: 'MERGEABLE',
  reviewDecision: 'REVIEW_REQUIRED',
  linkedIssues: [],
  lastCommitAt: null,
  ...over,
});

const ME = 'oncall';
const comment = (login, at, over = {}) => ({ login, association: 'NONE', at, ...over });
const assignedToMe = { assignees: [{ login: ME }], createdAt: daysAgo(30) };
const waitingOnReporter = { conversation: { waitingOn: 'reporter', teamReplied: true, since: hoursAgo(5) } };

const groups = (items, options = {}) => Object.fromEntries(sinceGroups(items, { now: NOW, me: ME, ...options }).map((g) => [g.id, g.rows]));
const numbers = (rows) => rows.map((row) => row.item.number);

test('sinceStart: yesterday 00:00 local on a Tuesday', () => {
  assert.equal(sinceStart(NOW).getTime(), new Date(2026, 9, 26).getTime());
});

test('sinceStart: Friday 00:00 local on a Monday', () => {
  assert.equal(sinceStart(new Date(2026, 9, 26, 8, 30).getTime()).getTime(), new Date(2026, 9, 23).getTime());
});

test('sinceStart: Saturday 00:00 local on a Sunday', () => {
  assert.equal(sinceStart(new Date(2026, 9, 25, 23, 59).getTime()).getTime(), new Date(2026, 9, 24).getTime());
});

test('sinceGroups: two groups in order', () => {
  assert.deepEqual(sinceGroups([], { now: NOW, me: ME }).map((g) => [g.id, g.label]), [
    ['issues', 'New issues'],
    ['prs', 'New PRs'],
  ]);
});

test('new items: an untouched issue and PR created in the window', () => {
  const { issues, prs } = groups([issue({ number: 1 }), pr({ number: 2 })]);
  assert.deepEqual(numbers(issues), [1]);
  assert.equal(issues[0].what, 'new issue');
  assert.equal(issues[0].at, hoursAgo(5));
  assert.deepEqual(numbers(prs), [2]);
  assert.equal(prs[0].what, 'new PR');
});

test('new items: created before the window are excluded', () => {
  assert.deepEqual(groups([issue({ createdAt: new Date(new Date(2026, 9, 26).getTime() - 1).toISOString() })]).issues, []);
  assert.equal(groups([issue({ createdAt: new Date(2026, 9, 26).toISOString() })]).issues.length, 1);
});

test('new items: a team comment excludes the item', () => {
  assert.deepEqual(groups([issue({ comments: [comment('colleague', hoursAgo(2), { association: 'MEMBER' })] })]).issues, []);
});

test('new items: a team review excludes the PR', () => {
  assert.deepEqual(groups([pr({ comments: [comment('colleague', hoursAgo(2), { association: 'COLLABORATOR', review: 'COMMENTED' })] })]).prs, []);
});

test('new items: comments from the community or bots do not exclude', () => {
  const items = [
    issue({ number: 1, comments: [comment('someone', hoursAgo(2), { association: 'CONTRIBUTOR' })] }),
    issue({ number: 2, comments: [comment('expo-bot', hoursAgo(2), { association: 'MEMBER' })] }),
  ];
  assert.deepEqual(numbers(groups(items).issues), [1, 2]);
});

test('new items: a comment from the team author excludes the item', () => {
  const item = pr({ author: { login: 'colleague' }, authorAssociation: 'MEMBER', comments: [comment('colleague', hoursAgo(2), { association: 'MEMBER' })] });
  assert.deepEqual(groups([item], { includeInternal: true }).prs, []);
});

test('new items: a team author alone does not exclude when internal authors are included', () => {
  assert.equal(groups([pr({ author: { login: 'colleague' }, authorAssociation: 'MEMBER' })], { includeInternal: true }).prs.length, 1);
});

test('new items: internal authors are hidden by default', () => {
  const items = ['MEMBER', 'OWNER', 'COLLABORATOR'].map((authorAssociation, i) => issue({ number: i + 1, author: { login: 'colleague' }, authorAssociation }));
  assert.deepEqual(groups([...items, pr({ number: 4, author: { login: 'colleague' }, authorAssociation: 'MEMBER' })]), { issues: [], prs: [] });
});

test('new items: internal authors show when included', () => {
  const items = ['MEMBER', 'OWNER', 'COLLABORATOR'].map((authorAssociation, i) => issue({ number: i + 1, author: { login: 'colleague' }, authorAssociation }));
  const { issues, prs } = groups([...items, pr({ number: 4, author: { login: 'colleague' }, authorAssociation: 'MEMBER' })], { includeInternal: true });
  assert.deepEqual(numbers(issues), [1, 2, 3]);
  assert.deepEqual(numbers(prs), [4]);
});

test('new items: outside authors show by default', () => {
  const associations = ['CONTRIBUTOR', 'NONE', 'FIRST_TIME_CONTRIBUTOR'];
  const items = associations.flatMap((authorAssociation, i) => [issue({ number: i + 1, authorAssociation }), pr({ number: i + 11, authorAssociation })]);
  const { issues, prs } = groups(items);
  assert.deepEqual(numbers(issues).sort(), [1, 2, 3]);
  assert.deepEqual(numbers(prs).sort(), [11, 12, 13]);
});

test('new items: assigned to someone else stays, after the unassigned rows, with Open', () => {
  const items = [
    issue({ number: 1, createdAt: hoursAgo(1), assignees: [{ login: 'colleague' }] }),
    issue({ number: 2, createdAt: hoursAgo(6) }),
    issue({ number: 3, createdAt: hoursAgo(4), ...waitingOnReporter }),
  ];
  const { issues } = groups(items);
  assert.deepEqual(numbers(issues), [2, 3, 1]);
  assert.equal(issues[2].open, true);
  assert.equal(issues[2].assign, false);
});

test('new items: assigned to me leaves the group', () => {
  assert.deepEqual(groups([issue({ assignees: [{ login: ME }] }), pr({ number: 2, assignees: [{ login: 'colleague' }, { login: ME }] })]), { issues: [], prs: [] });
});

test('new items: a PR that requests my review leaves the group', () => {
  const items = [pr({ number: 1, reviewRequests: [{ login: ME }] }), pr({ number: 2, reviewRequests: [{ login: 'colleague' }] })];
  assert.deepEqual(numbers(groups(items).prs), [2]);
});

test('new items: an item I commented on leaves the group', () => {
  const items = [issue({ number: 1, comments: [comment(ME, hoursAgo(2))] }), issue({ number: 2, comments: [comment('someone', hoursAgo(2))] })];
  assert.deepEqual(numbers(groups(items).issues), [2]);
});

test('new items: an issue whose fix PR I commented on leaves the group', () => {
  const linked = (fix) => issue({ number: 1, linkedPrs: [{ number: 2, state: 'OPEN', fix }] });
  const fixPr = pr({ number: 2, createdAt: daysAgo(3), comments: [comment(ME, hoursAgo(2), { review: 'APPROVED' })] });
  assert.deepEqual(groups([linked(true), fixPr]).issues, []);
  assert.deepEqual(numbers(groups([linked(false), fixPr]).issues), [1]);
});

test('new items: assigned to someone else stays when signed out', () => {
  const [row] = groups([issue({ assignees: [{ login: 'colleague' }] })], { me: null }).issues;
  assert.equal(row.open, true);
});

test('new items: closed items are excluded', () => {
  assert.deepEqual(groups([issue({ state: 'CLOSED' }), pr({ number: 2, state: 'MERGED' })]), { issues: [], prs: [] });
});

test('new items: a label alone does not exclude', () => {
  assert.equal(groups([issue({ labels: [{ name: 'Android' }, { name: 'sdk-54' }] })]).issues.length, 1);
});

test('new items: rows with an action first, then newest first', () => {
  const items = [
    issue({ number: 1, createdAt: hoursAgo(1), ...waitingOnReporter }),
    issue({ number: 2, createdAt: hoursAgo(8) }),
    issue({ number: 3, createdAt: hoursAgo(2) }),
    issue({ number: 4, createdAt: hoursAgo(3), ...waitingOnReporter }),
  ];
  assert.deepEqual(numbers(groups(items).issues), [3, 2, 1, 4]);
});

test('no activity from updatedAt alone', () => {
  const items = [
    issue({ ...assignedToMe, number: 1, updatedAt: hoursAgo(1) }),
    issue({ number: 2, createdAt: daysAgo(10), updatedAt: hoursAgo(1) }),
  ];
  assert.deepEqual(groups(items), { issues: [], prs: [] });
});

test('an item from an old cache without comments or assigned events does not throw', () => {
  const oldShape = (item) => {
    const { comments, assignedEvents, ...rest } = item;
    return rest;
  };
  const items = [oldShape(issue({ ...assignedToMe, number: 1 })), oldShape(issue({ number: 2 })), oldShape(pr({ number: 3, assignees: [{ login: 'colleague' }] }))];
  const { issues, prs } = groups(items);
  assert.deepEqual(numbers(issues), [2]);
  assert.deepEqual(numbers(prs), [3]);
});

test('buttons: a given state is used instead of computing it', () => {
  assert.equal(sinceButtons(issue(), { me: ME, now: NOW }).action.kind, 'command');
  assert.equal(sinceButtons(issue(), { me: ME, now: NOW, stateId: 'I4' }).action, null);
});

test('buttons: Close on a fix-merged issue only when it is mine or nobody else has it', () => {
  const merged = { linkedPrs: [{ number: 10, state: 'MERGED', fix: true }] };
  assert.equal(sinceButtons(issue({ ...merged, assignees: [{ login: ME }] }), { me: ME, now: NOW }).action?.kind, 'close');
  assert.equal(sinceButtons(issue({ ...merged, assignees: [{ login: 'colleague' }] }), { me: ME, now: NOW }).action, null);
});

test('buttons: the state action when it is one click', () => {
  const [row] = groups([issue()]).issues;
  assert.deepEqual(row.action, { kind: 'command', label: 'Ask bot to triage', body: '@expo-bot triage' });
});

test('buttons: no action when the state only opens the item', () => {
  assert.equal(groups([issue(waitingOnReporter)]).issues[0].action, null);
});

test('buttons: Assign when nobody is assigned and I am signed in', () => {
  const [row] = groups([issue()]).issues;
  assert.equal(row.assign, true);
  assert.equal(row.open, false);
});

test('buttons: no Assign when signed out', () => {
  const [row] = groups([issue()], { me: null }).issues;
  assert.equal(row.assign, false);
  assert.equal(row.open, false);
});

test('buttons: Open when someone else is assigned', () => {
  const buttons = sinceButtons(issue({ assignees: [{ login: 'colleague' }] }), { me: ME, now: NOW });
  assert.equal(buttons.assign, false);
  assert.equal(buttons.open, true);
});

test('buttons: Unassign only on items assigned to me', () => {
  assert.equal(sinceButtons(issue({ assignees: [{ login: ME }, { login: 'colleague' }] }), { me: ME, now: NOW }).unassign, true);
  assert.equal(sinceButtons(issue({ assignees: [{ login: 'colleague' }] }), { me: ME, now: NOW }).unassign, false);
  assert.equal(sinceButtons(issue(), { me: ME, now: NOW }).unassign, false);
  assert.equal(sinceButtons(issue({ assignees: [{ login: ME }] }), { me: null, now: NOW }).unassign, false);
});

test('buttons: neither Assign nor Open on my own items', () => {
  const buttons = sinceButtons(issue({ assignees: [{ login: ME }, { login: 'colleague' }] }), { me: ME, now: NOW });
  assert.equal(buttons.assign, false);
  assert.equal(buttons.open, false);
});

test('skip: hides the row', () => {
  const skipped = withSkip({}, issue(), NOW);
  assert.deepEqual(groups([issue()], { skipped }).issues, []);
});

test('skip: a new item stays hidden for good', () => {
  const skipped = withSkip({}, issue(), NOW);
  assert.deepEqual(groups([issue()], { skipped, now: NOW + 36e5 }).issues, []);
});

test('skip: keyed by type and number', () => {
  assert.equal(skipKey(pr({ number: 42 })), 'pr#42');
  const skipped = withSkip({}, pr({ number: 1 }), NOW);
  assert.equal(groups([issue({ number: 1 })], { skipped }).issues.length, 1);
});

test('withSkip: records the time and forgets entries older than 30 days', () => {
  const old = { 'issue#7': NOW - 31 * 864e5, 'issue#8': NOW - 29 * 864e5 };
  assert.deepEqual(withSkip(old, issue({ number: 9 }), NOW), { 'issue#8': NOW - 29 * 864e5, 'issue#9': NOW });
  assert.equal(Object.keys(old).length, 2, 'does not change its input');
});

test('parseSkipped: a JSON map of numbers, anything else is empty', () => {
  assert.deepEqual(parseSkipped('{"issue#1":5,"pr#2":"x"}'), { 'issue#1': 5 });
  assert.deepEqual(parseSkipped(null), {});
  assert.deepEqual(parseSkipped('not json'), {});
  assert.deepEqual(parseSkipped('[1,2]'), {});
});