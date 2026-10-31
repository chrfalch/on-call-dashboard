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

test('sinceGroups: three groups in order', () => {
  assert.deepEqual(sinceGroups([], { now: NOW, me: ME }).map((g) => [g.id, g.label]), [
    ['mine', 'My items'],
    ['issues', 'New issues'],
    ['prs', 'New PRs'],
  ]);
});

test('my items: a comment from someone else after mine qualifies', () => {
  const item = issue({ ...assignedToMe, comments: [comment(ME, hoursAgo(20), { association: 'MEMBER' }), comment('reporter', hoursAgo(3))] });
  const [row] = groups([item]).mine;
  assert.equal(row.item, item);
  assert.equal(row.what, '@reporter replied');
  assert.equal(row.at, hoursAgo(3));
});

test('my items: a comment from someone else before mine does not qualify', () => {
  const item = issue({ ...assignedToMe, comments: [comment('reporter', hoursAgo(20)), comment(ME, hoursAgo(3), { association: 'MEMBER' })] });
  assert.deepEqual(groups([item]).mine, []);
});

test('my items: my own comment does not qualify', () => {
  const item = issue({ ...assignedToMe, comments: [comment(ME, hoursAgo(3), { association: 'MEMBER' })] });
  assert.deepEqual(groups([item]).mine, []);
});

test('my items: a bot comment does not qualify', () => {
  const item = issue({ ...assignedToMe, comments: [comment('expo-bot', hoursAgo(3), { association: 'MEMBER' }), comment('renovate[bot]', hoursAgo(2))] });
  assert.deepEqual(groups([item]).mine, []);
});

test('my items: a review after my touch qualifies and names its state', () => {
  const item = pr({ ...assignedToMe, comments: [comment(ME, hoursAgo(20)), comment('reviewer', hoursAgo(2), { association: 'MEMBER', review: 'CHANGES_REQUESTED' })] });
  const [row] = groups([item]).mine;
  assert.equal(row.what, '@reviewer requested changes');
});

test('my items: expo-bot finishing my review, triage or verify qualifies', () => {
  const asked = (command, by = ME, replied = true) => ({
    lastCommand: { command, by, at: hoursAgo(5) },
    commandAnswer: { at: hoursAgo(3), outcome: null },
    botRepliedAfterCommand: replied,
  });
  const item = (bot) => pr({ ...assignedToMe, comments: [comment(ME, hoursAgo(5))], bot });
  for (const [command, what] of [['review', 'expo-bot finished the review'], ['triage', 'expo-bot finished triage'], ['verify', 'expo-bot finished verify']]) {
    const [row] = groups([item(asked(command))]).mine;
    assert.equal(row.what, what, command);
    assert.equal(row.at, hoursAgo(3), command);
  }
  assert.deepEqual(groups([item(asked('review', 'colleague'))]).mine, [], 'asked by someone else');
  assert.deepEqual(groups([item(asked('review', ME, false))]).mine, [], 'no reply yet');
  assert.deepEqual(groups([item(asked('rebase'))]).mine, [], 'other command');
});

test('my items: expo-bot finishing before I assigned myself still qualifies', () => {
  const bot = { lastCommand: { command: 'review', by: ME, at: hoursAgo(5) }, commandAnswer: { at: hoursAgo(4), outcome: null }, botRepliedAfterCommand: true };
  const item = pr({ ...assignedToMe, comments: [comment(ME, hoursAgo(5))], assignedEvents: [{ login: ME, at: hoursAgo(3) }], bot });
  const [row] = groups([item]).mine;
  assert.equal(row?.what, 'expo-bot finished the review');
  assert.equal(row?.at, hoursAgo(4));
});

test('my items: the answer to my command dates the event, not a newer expo-bot comment of another kind', () => {
  const bot = { lastCommand: { command: 'review', by: ME, at: hoursAgo(5) }, commandAnswer: { at: hoursAgo(3), outcome: null }, botRepliedAfterCommand: true };
  const comments = (mine) => [comment(ME, mine), comment('expo-bot', hoursAgo(1))];
  const [row] = groups([pr({ ...assignedToMe, comments: comments(hoursAgo(5)), bot })]).mine;
  assert.equal(row?.at, hoursAgo(3));
  assert.deepEqual(groups([pr({ ...assignedToMe, comments: comments(hoursAgo(2)), bot })]).mine, []);
});

test('my items: expo-bot finishing before my last comment does not qualify', () => {
  const bot = { lastCommand: { command: 'review', by: ME, at: hoursAgo(5) }, commandAnswer: { at: hoursAgo(3), outcome: null }, botRepliedAfterCommand: true };
  assert.deepEqual(groups([pr({ ...assignedToMe, comments: [comment(ME, hoursAgo(2))], bot })]).mine, []);
});

test('my items: my review on the fix PR counts as touching the issue', () => {
  const bot = { lastCommand: { command: 'triage', by: ME, at: hoursAgo(20) }, commandAnswer: { at: hoursAgo(15), outcome: null }, botRepliedAfterCommand: true };
  const linkedPrs = (fix) => [{ number: 2, state: 'OPEN', fix }];
  const fixIssue = (fix = true) => issue({ ...assignedToMe, number: 1, comments: [comment(ME, hoursAgo(20))], linkedPrs: linkedPrs(fix), bot });
  const fixPr = (at) => pr({ number: 2, reviewDecision: 'CHANGES_REQUESTED', comments: [comment(ME, at, { review: 'CHANGES_REQUESTED' })] });

  assert.deepEqual(groups([fixIssue(), fixPr(hoursAgo(2))]).mine, [], 'reviewed after the bot answered');
  assert.equal(groups([fixIssue(), fixPr(hoursAgo(18))]).mine[0]?.what, 'expo-bot finished triage', 'reviewed before the bot answered');
  assert.equal(groups([fixIssue(false), fixPr(hoursAgo(2))]).mine[0]?.what, 'expo-bot finished triage', 'not a fix PR');
});

test('my items: my review on the fix PR hides older comments by others on the issue', () => {
  const item = issue({ ...assignedToMe, comments: [comment('reporter', hoursAgo(5))], linkedPrs: [{ number: 2, state: 'MERGED', fix: true }] });
  const fixPr = pr({ number: 2, state: 'MERGED', comments: [comment(ME, hoursAgo(2), { review: 'APPROVED' })] });
  assert.deepEqual(groups([item, fixPr]).mine, []);
});

test('my items: a commit after my touch qualifies', () => {
  const item = pr({ ...assignedToMe, comments: [comment(ME, hoursAgo(20))], lastCommitAt: hoursAgo(4), lastCommitBy: 'contributor' });
  const [row] = groups([item]).mine;
  assert.equal(row.what, 'new commit');
  assert.equal(row.at, hoursAgo(4));
});

test('my items: a commit by me, by a bot or by an unknown author does not qualify', () => {
  const commit = (lastCommitBy) => pr({ ...assignedToMe, comments: [comment(ME, hoursAgo(20))], lastCommitAt: hoursAgo(4), lastCommitBy });
  for (const by of [ME, 'dependabot', 'renovate[bot]', null, undefined]) assert.deepEqual(groups([commit(by)]).mine, [], String(by));
});

test('my items: the assigned event counts as my last touch', () => {
  const before = issue({ ...assignedToMe, comments: [comment('reporter', hoursAgo(6))], assignedEvents: [{ login: ME, at: hoursAgo(4) }] });
  const after = issue({ ...assignedToMe, comments: [comment('reporter', hoursAgo(3))], assignedEvents: [{ login: ME, at: hoursAgo(4) }] });
  assert.deepEqual(groups([before]).mine, []);
  assert.equal(groups([after]).mine.length, 1);
});

test('my items: someone else being assigned is not my touch', () => {
  const item = issue({ ...assignedToMe, comments: [comment('reporter', hoursAgo(6))], assignedEvents: [{ login: 'colleague', at: hoursAgo(4) }] });
  assert.equal(groups([item]).mine.length, 1);
});

test('my items: without a known touch, the window start is the cutoff', () => {
  const inWindow = issue({ ...assignedToMe, number: 1, comments: [comment('reporter', hoursAgo(5))] });
  const beforeWindow = issue({ ...assignedToMe, number: 2, comments: [comment('reporter', daysAgo(3))] });
  assert.deepEqual(numbers(groups([inWindow, beforeWindow]).mine), [1]);
});

test('my items: the newest qualifying event is shown', () => {
  const item = pr({ ...assignedToMe, lastCommitAt: hoursAgo(6), comments: [comment('reviewer', hoursAgo(2), { review: 'APPROVED' }), comment('reporter', hoursAgo(4))] });
  assert.equal(groups([item]).mine[0].what, '@reviewer approved');
});

test('my items: only open items assigned to me', () => {
  const activity = { comments: [comment('reporter', hoursAgo(3))] };
  const items = [
    issue({ ...assignedToMe, ...activity, number: 1 }),
    issue({ ...activity, number: 2, assignees: [{ login: 'colleague' }], createdAt: daysAgo(30) }),
    issue({ ...assignedToMe, ...activity, number: 3, state: 'CLOSED' }),
  ];
  assert.deepEqual(numbers(groups(items).mine), [1]);
});

test('my items: a PR that requests my review counts as mine', () => {
  const activity = { createdAt: daysAgo(30), comments: [comment('contributor', hoursAgo(3))] };
  const items = [
    pr({ ...activity, number: 1, reviewRequests: [{ login: ME }] }),
    pr({ ...activity, number: 2, reviewRequests: [{ login: 'colleague' }] }),
  ];
  assert.deepEqual(numbers(groups(items).mine), [1]);
});

test('my items: a new PR that requests my review shows once', () => {
  const quiet = pr({ number: 1, reviewRequests: [{ login: ME }] });
  const active = pr({ number: 2, reviewRequests: [{ login: ME }], comments: [comment('contributor', hoursAgo(1))] });
  const { mine, prs } = groups([quiet, active]);
  assert.deepEqual(numbers(mine), [2]);
  assert.deepEqual(numbers(prs), [1]);
});

test('my items: hidden when signed out', () => {
  const item = issue({ ...assignedToMe, comments: [comment('reporter', hoursAgo(3))] });
  assert.deepEqual(groups([item], { me: null }).mine, []);
});

test('my items: newest activity first', () => {
  const items = [
    issue({ ...assignedToMe, number: 1, comments: [comment('reporter', hoursAgo(5))] }),
    issue({ ...assignedToMe, number: 2, comments: [comment('reporter', hoursAgo(1))] }),
    pr({ ...assignedToMe, number: 3, lastCommitAt: hoursAgo(3), lastCommitBy: 'contributor' }),
  ];
  assert.deepEqual(numbers(groups(items).mine), [2, 3, 1]);
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
  assert.deepEqual(groups([...items, pr({ number: 4, author: { login: 'colleague' }, authorAssociation: 'MEMBER' })]), { mine: [], issues: [], prs: [] });
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

test('my items: an internal author does not hide the item', () => {
  const item = issue({ ...assignedToMe, author: { login: 'colleague' }, authorAssociation: 'MEMBER', comments: [comment('someone', hoursAgo(2))] });
  assert.deepEqual(numbers(groups([item]).mine), [1]);
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
  assert.deepEqual(groups([issue({ assignees: [{ login: ME }] }), pr({ number: 2, assignees: [{ login: 'colleague' }, { login: ME }] })]), { mine: [], issues: [], prs: [] });
});

test('new items: assigned to someone else stays when signed out', () => {
  const [row] = groups([issue({ assignees: [{ login: 'colleague' }] })], { me: null }).issues;
  assert.equal(row.open, true);
});

test('new items: closed items are excluded', () => {
  assert.deepEqual(groups([issue({ state: 'CLOSED' }), pr({ number: 2, state: 'MERGED' })]), { mine: [], issues: [], prs: [] });
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
  assert.deepEqual(groups(items), { mine: [], issues: [], prs: [] });
});

test('an item from an old cache without comments or assigned events does not throw', () => {
  const oldShape = (item) => {
    const { comments, assignedEvents, ...rest } = item;
    return rest;
  };
  const items = [oldShape(issue({ ...assignedToMe, number: 1 })), oldShape(issue({ number: 2 })), oldShape(pr({ number: 3, assignees: [{ login: 'colleague' }] }))];
  const { mine, issues, prs } = groups(items);
  assert.deepEqual(mine, []);
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
  const item = issue({ assignees: [{ login: ME }, { login: 'colleague' }], createdAt: daysAgo(30), comments: [comment('reporter', hoursAgo(2))] });
  const [row] = groups([item]).mine;
  assert.equal(row.assign, false);
  assert.equal(row.open, false);
});

test('skip: hides the row', () => {
  const skipped = withSkip({}, issue(), NOW);
  assert.deepEqual(groups([issue()], { skipped }).issues, []);
});

test('skip: a new item stays hidden for good', () => {
  const skipped = withSkip({}, issue(), NOW);
  assert.deepEqual(groups([issue()], { skipped, now: NOW + 36e5 }).issues, []);
});

test('skip: a my-item comes back after newer activity', () => {
  const skippedAt = NOW - 2 * 36e5;
  const skipped = { [skipKey(issue())]: skippedAt };
  const older = issue({ ...assignedToMe, comments: [comment('reporter', hoursAgo(3))] });
  const newer = issue({ ...assignedToMe, comments: [comment('reporter', hoursAgo(3)), comment('reporter', hoursAgo(1))] });
  assert.deepEqual(groups([older], { skipped }).mine, []);
  assert.equal(groups([newer], { skipped }).mine.length, 1);
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