import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTasks, isHidden, listedTasks, needsBotTriage, PLATFORM_LABEL, TASK_KINDS } from './public/inbox.js';

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
  bot: { lastCommand: null, botRepliedAfterCommand: false, lastReview: null, botRepliedAfterReview: false },
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
// The item's best task. The fixtures have no routing labels, so most items also get a bot-triage task.
const one = (item, opts) => computeTasks([item], { now: NOW, ...opts }).find((t) => t.kind !== 'bot-triage');
const reviewCmd = { command: 'review', at: daysAgo(2) };
const botReview = (replied) => ({ bot: { lastCommand: reviewCmd, botRepliedAfterCommand: replied, lastReview: reviewCmd, botRepliedAfterReview: replied } });

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

test('on-call: bot review done and no reviewer requested -> ready for human review', () => {
  const reviewed = botReview(true);
  const t = one(pr(reviewed));
  assert.equal(t.kind, 'human-review');
  assert.equal(TASK_KINDS['human-review'].oncall, true);
  assert.equal(one(pr({ ...reviewed, reviewRequests: [{ login: 'kudo' }] })), undefined);
  assert.equal(one(pr(botReview(false))), undefined);
  assert.equal(one(pr({ ...reviewed, checks: 'FAILURE' })), undefined);
});

test('PR tasks follow the last review command, not the newest command', () => {
  const verified = { bot: { lastCommand: { command: 'verify', at: daysAgo(1) }, botRepliedAfterCommand: true, lastReview: null, botRepliedAfterReview: false } };
  assert.equal(one(pr(verified)).kind, 'bot-review');
  const rebased = { bot: { lastCommand: { command: 'rebase', at: daysAgo(1) }, botRepliedAfterCommand: true, lastReview: null, botRepliedAfterReview: false } };
  assert.equal(one(pr(rebased)).kind, 'bot-review');

  const rebasedAfterReview = { bot: { lastCommand: { command: 'rebase', at: daysAgo(1) }, botRepliedAfterCommand: false, lastReview: reviewCmd, botRepliedAfterReview: true } };
  assert.equal(one(pr(rebasedAfterReview)).kind, 'human-review');
  assert.deepEqual(kinds(one(pr({ ...rebasedAfterReview, assignees: [{ login: 'me' }] }), { me: 'me', mode: 'mine' })), ['review', 'human-review']);

  const rebaseRepliedReviewPending = { bot: { lastCommand: { command: 'rebase', at: daysAgo(1) }, botRepliedAfterCommand: true, lastReview: reviewCmd, botRepliedAfterReview: false } };
  assert.equal(one(pr(rebaseRepliedReviewPending)), undefined);
  assert.equal(one(pr({ ...rebaseRepliedReviewPending, assignees: [{ login: 'me' }] }), { me: 'me', mode: 'mine' }), undefined);
});

test('my work: only items assigned to me or requesting my review, all task kinds', () => {
  const opts = { me: 'me', mode: 'mine' };
  assert.equal(one(issue(), opts), undefined);
  assert.equal(one(pr({ reviewDecision: 'APPROVED', assignees: [{ login: 'me' }] }), opts).kind, 'merge');
  const t = one(pr({ ...botReview(true), reviewRequests: [{ login: 'me' }] }), opts);
  assert.equal(t.kind, 'review');
  assert.ok(t.reasons.some((r) => r.text === 'your review requested'));
});

test('stale issue waiting on reporter -> close, unless accepted', () => {
  const stale = { createdAt: daysAgo(200), conversation: { waitingOn: 'reporter', teamReplied: true, since: daysAgo(30) } };
  assert.equal(one(issue(stale)).kind, 'close');
  assert.equal(one(issue({ ...stale, labels: [{ name: 'Issue accepted' }] })), undefined);
});

const linkedPr = (number, over = {}) => ({ number, title: `Fix ${number}`, state: 'MERGED', mergedAt: daysAgo(5), baseRefName: 'main', fix: true, ...over });
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

test('issue whose only merged PR is named in a team comment -> close candidate, as on #49378', () => {
  const fromComment = linkedPr(49351, { baseRefName: '@ubax/always-use-use-in-useLoaderData', via: 'comment', by: { login: 'teammate', association: 'MEMBER' } });
  const t = one(issue({ ...quiet, number: 49378, linkedPrs: [fromComment] }));
  assert.equal(t.kind, 'close-candidate');
  assert.deepEqual(t.reasons.map((r) => r.text), ['#49351 merged 5d ago into @ubax/always-use-use-in-useLoaderData']);
});

test('no close candidate without a merged linked PR', () => {
  assert.ok(!kinds(one(issue({ ...quiet, linkedPrs: [linkedPr(10, { state: 'OPEN', mergedAt: null }), linkedPr(11, { state: 'CLOSED', mergedAt: null })] }))).includes('close-candidate'));
  assert.ok(!kinds(one(issue({ ...quiet, linkedPrs: [] }))).includes('close-candidate'));
  assert.doesNotThrow(() => assert.equal(one(issue(quiet)), undefined), 'old cached issues have no linkedPrs');
});

test('no close candidate when the merged PRs only mention the issue, as on #34136 and #45511', () => {
  const fromBot = linkedPr(31955, { fix: false, via: 'comment', by: { login: 'expo-bot', association: 'MEMBER' } });
  assert.ok(!kinds(one(issue({ ...quiet, number: 34136, linkedPrs: [fromBot] }))).includes('close-candidate'));
  const mention = linkedPr(48787, { fix: false });
  assert.ok(!kinds(one(issue({ ...quiet, number: 45511, linkedPrs: [linkedPr(20008, { fix: false, via: 'comment', by: { login: 'expo-bot', association: 'MEMBER' } }), mention] }))).includes('close-candidate'));
  assert.ok(!kinds(one(issue({ ...quiet, linkedPrs: [linkedPr(10, { fix: undefined })] }))).includes('close-candidate'), 'a PR without the fix field is no fix');
});

test('close candidate lists only the merged fix PRs', () => {
  const t = one(issue({ ...quiet, linkedPrs: [linkedPr(10, { fix: false }), linkedPr(11)] }));
  assert.equal(t.kind, 'close-candidate');
  assert.deepEqual(t.reasons.map((r) => r.text), ['#11 merged 5d ago into main']);
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

test('open fix PR blocks stale close; closed or non-fix PRs do not', () => {
  const stale = { createdAt: daysAgo(200), conversation: { waitingOn: 'reporter', teamReplied: true, since: daysAgo(30) } };
  const passed = { createdAt: daysAgo(200), triage: { verification: { outcome: 'pass' } }, conversation: { waitingOn: 'team', teamReplied: true, since: daysAgo(30) } };
  const open = linkedPr(10, { state: 'OPEN', mergedAt: null });
  for (const base of [stale, passed]) {
    assert.ok(!kinds(one(issue({ ...base, linkedPrs: [open] }))).includes('close'));
    assert.ok(kinds(one(issue({ ...base, linkedPrs: [linkedPr(10, { state: 'CLOSED', mergedAt: null })] }))).includes('close'));
    assert.ok(kinds(one(issue({ ...base, linkedPrs: [{ ...open, fix: false }] }))).includes('close'));
  }
});

const idlePr = (over = {}) => pr({ conversation: { waitingOn: 'reporter', teamReplied: true, since: daysAgo(90) }, updatedAt: daysAgo(90), ...over });

test('stale PR close needs requested changes', () => {
  assert.equal(one(idlePr({ reviewDecision: 'REVIEW_REQUIRED' })), undefined);
  assert.ok(!kinds(one(idlePr({ reviewDecision: 'APPROVED', assignees: [{ login: 'me' }] }), { me: 'me', mode: 'mine' })).includes('close'));
  const t = one(idlePr({ reviewDecision: 'CHANGES_REQUESTED' }));
  assert.equal(t.kind, 'close');
  assert.ok(t.reasons.some((r) => r.text === 'no activity 90d'));
});

test('PR idle age is the last human activity, not updatedAt', () => {
  const t = one(idlePr({ reviewDecision: 'CHANGES_REQUESTED', updatedAt: daysAgo(1) }));
  assert.equal(t.kind, 'close');
  assert.ok(t.reasons.some((r) => r.text === 'no activity 90d'));
  assert.equal(one(idlePr({ reviewDecision: 'CHANGES_REQUESTED', conversation: { waitingOn: 'reporter', teamReplied: true, since: daysAgo(10) } })), undefined);
});

test('on-call: long-idle approved PR with failing checks gets a nudge', () => {
  const t = one(idlePr({ reviewDecision: 'APPROVED', checks: 'FAILURE' }));
  assert.equal(t.kind, 'nudge');
  assert.ok(t.reasons.some((r) => r.text === 'idle 90d'));
  assert.equal(TASK_KINDS.nudge.oncall, false);
  assert.equal(one(idlePr({ reviewDecision: 'APPROVED', checks: 'FAILURE', conversation: { waitingOn: 'reporter', teamReplied: true, since: daysAgo(10) } })), undefined);
});

test('internal issues get no reply/verify tasks', () => {
  assert.equal(one(issue({ conversation: { waitingOn: 'internal', teamReplied: true, since: daysAgo(1) } })), undefined);
});

test('PRs: merge, bot review first, then human review', () => {
  const all = { me: 'me', mode: 'mine' };
  const mine = { assignees: [{ login: 'me' }] };
  assert.equal(one(pr({ ...mine, reviewDecision: 'APPROVED' }), all).kind, 'merge');
  assert.equal(one(pr(mine), all).kind, 'bot-review');
  assert.equal(one(pr({ ...mine, ...botReview(false) }), all), undefined);
  assert.equal(one(pr({ ...mine, ...botReview(true) }), all).kind, 'review');
  assert.equal(one(pr({ ...mine, isDraft: true, reviewDecision: 'APPROVED' }), all), undefined);
});

test('close-candidate scores 45 before bonuses', () => {
  const t = one(issue({
    triage: { verification: { outcome: 'pass' } },
    conversation: { waitingOn: 'reporter', teamReplied: true, since: daysAgo(1) },
    linkedPrs: [{ number: 7, title: 'Fix', state: 'MERGED', mergedAt: daysAgo(2), baseRefName: 'main', fix: true }],
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

const UNSUPPORTED = new Set(['sdk-52', 'sdk-53']);
const sdks = (...names) => names.map((name) => ({ name }));

test('issue with only unsupported SDK labels -> only an unsupported-sdk task, newest SDK first', () => {
  const t = one(issue({ labels: sdks('sdk-52', 'sdk-53') }), { unsupported: UNSUPPORTED });
  assert.equal(t.kind, 'unsupported-sdk');
  assert.deepEqual(t.also, []);
  assert.equal(t.reasons[0].text, 'sdk-53, sdk-52');
  assert.equal(TASK_KINDS['unsupported-sdk'].action, 'close');
});

test('PR with only unsupported SDK labels, draft or not -> only an unsupported-sdk task', () => {
  for (const isDraft of [false, true]) {
    const t = one(pr({ isDraft, reviewDecision: 'APPROVED', labels: sdks('sdk-52') }), { unsupported: UNSUPPORTED });
    assert.equal(t.kind, 'unsupported-sdk');
    assert.deepEqual(t.also, []);
    assert.equal(t.reasons[0].text, 'sdk-52');
  }
});

test('one supported SDK label keeps the ordinary tasks', () => {
  const t = one(issue({ labels: sdks('sdk-53', 'sdk-54') }), { unsupported: UNSUPPORTED });
  assert.equal(t.kind, 'verify');
});

test('no unsupported SDKs by default', () => {
  const t = one(issue({ labels: sdks('sdk-52') }));
  assert.equal(t.kind, 'verify');
  assert.deepEqual(t.also, ['first-response']);
});

test('unsupported-sdk tasks still respect on-call ownership', () => {
  const owned = issue({ labels: sdks('sdk-52'), assignees: [{ login: 'someone' }] });
  assert.equal(one(owned, { unsupported: UNSUPPORTED }), undefined);
  assert.equal(one(owned, { unsupported: UNSUPPORTED, includeAssigned: true }).kind, 'unsupported-sdk');
});

test('listed tasks: chip-only kinds show only when their chip is selected', () => {
  const tasks = computeTasks([issue({ number: 1 }), issue({ number: 2, labels: sdks('sdk-52') })], { now: NOW, unsupported: UNSUPPORTED });
  assert.deepEqual(listedTasks(tasks).map((t) => t.item.number), [1]);
  assert.deepEqual(listedTasks(tasks, 'unsupported-sdk').map((t) => t.item.number), [2]);
  assert.deepEqual(listedTasks(tasks, 'verify').map((t) => t.item.number), [1]);
});

const routed = sdks('Android', 'sdk-54');
const kindsOf = (tasks) => tasks.map((t) => t.kind);

test('PLATFORM_LABEL matches platform and OS labels only', () => {
  for (const name of ['Android', 'iOS', 'iOS 18', 'iPadOS', 'macOS', 'tvOS', 'Platform: web', 'OS: Windows']) assert.ok(PLATFORM_LABEL.test(name), name);
  for (const name of ['iOS-only', 'web', 'Android TV', 'sdk-54']) assert.ok(!PLATFORM_LABEL.test(name), name);
});

test('needsBotTriage: missing platform or SDK label', () => {
  assert.equal(needsBotTriage(issue()), true);
  assert.equal(needsBotTriage(issue({ labels: sdks('iOS') })), true);
  assert.equal(needsBotTriage(issue({ labels: sdks('sdk-54') })), true);
  assert.equal(needsBotTriage(issue({ labels: routed })), false);
  assert.equal(needsBotTriage(issue({ labels: sdks('Platform: web', 'sdk-53') })), false);
});

test('needsBotTriage: not when the bot already posted its triage', () => {
  assert.equal(needsBotTriage(issue({ triage: { assessment: { kind: 'bug' } } })), false);
  assert.equal(needsBotTriage(issue({ triage: { verification: { outcome: 'pass' } } })), true);
});

test('needsBotTriage: not while a triage command waits for the bot', () => {
  const cmd = (command, replied) => ({ bot: { lastCommand: { command, at: daysAgo(1) }, botRepliedAfterCommand: replied } });
  assert.equal(needsBotTriage(issue(cmd('triage', false))), false);
  assert.equal(needsBotTriage(issue(cmd('triage', true))), true);
  assert.equal(needsBotTriage(issue(cmd('verify', false))), true);
});

test('needsBotTriage: draft PRs wait until they are ready', () => {
  assert.equal(needsBotTriage(pr({ isDraft: true })), false);
  assert.equal(needsBotTriage(pr()), true);
  assert.equal(needsBotTriage(pr({ labels: routed })), false);
});

test('bot-triage is a chip-only on-call command task', () => {
  assert.deepEqual(TASK_KINDS['bot-triage'], { label: 'Ask bot to triage', icon: 'bot', tone: 'attention', action: 'command', oncall: true, chipOnly: true });
});

test('bot-triage is an extra task next to the best task, with the same bonus', () => {
  const tasks = computeTasks([issue({ severity: 4, thumbsUp: 2 })], { now: NOW });
  assert.deepEqual(kindsOf(tasks), ['verify', 'bot-triage']);
  const [best, triage] = tasks;
  assert.deepEqual(best.also, ['first-response']);
  assert.equal(triage.key, '1:bot-triage');
  assert.equal(triage.score - 10, best.score - 58);
  assert.deepEqual(triage.also, []);
  assert.deepEqual(triage.reasons.slice(0, 2), [{ text: 'no platform label' }, { text: 'no SDK label' }]);
  assert.deepEqual(triage.reasons.slice(2), best.reasons.slice(1));
});

test('bot-triage reasons name only the missing label', () => {
  const reasons = (labels) => computeTasks([issue({ labels: sdks(...labels) })], { now: NOW }).find((t) => t.kind === 'bot-triage').reasons;
  assert.deepEqual(reasons(['iOS']), [{ text: 'no SDK label' }]);
  assert.deepEqual(reasons(['sdk-54']), [{ text: 'no platform label' }]);
});

test('bot-triage task even when the item has no other task', () => {
  const quiet = issue({ createdAt: daysAgo(200), conversation: { waitingOn: 'internal', teamReplied: true, since: daysAgo(100) } });
  assert.deepEqual(kindsOf(computeTasks([quiet], { now: NOW })), ['bot-triage']);
  assert.deepEqual(kindsOf(computeTasks([{ ...quiet, labels: routed }], { now: NOW })), []);
});

test('no bot-triage task for routed, unsupported-SDK or owned items', () => {
  assert.deepEqual(kindsOf(computeTasks([issue({ labels: routed })], { now: NOW })), ['verify']);
  assert.deepEqual(kindsOf(computeTasks([issue({ labels: sdks('sdk-52') })], { now: NOW, unsupported: UNSUPPORTED })), ['unsupported-sdk']);
  assert.deepEqual(kindsOf(computeTasks([issue({ assignees: [{ login: 'someone' }] })], { now: NOW })), []);
});

test('a triage command does not remove the verify task', () => {
  for (const replied of [false, true]) {
    const bot = { lastCommand: { command: 'triage', at: daysAgo(1) }, botRepliedAfterCommand: replied };
    assert.equal(one(issue({ bot })).kind, 'verify', `replied: ${replied}`);
  }
  assert.equal(one(issue({ bot: { lastCommand: { command: 'verify', at: daysAgo(1) }, botRepliedAfterCommand: false } })).kind, 'first-response');
});

test('bot-triage tasks show only under their chip', () => {
  const tasks = computeTasks([issue({ number: 1 }), issue({ number: 2, labels: routed })], { now: NOW });
  assert.deepEqual(listedTasks(tasks).map((t) => t.key), ['1:verify', '2:verify']);
  assert.deepEqual(listedTasks(tasks, 'bot-triage').map((t) => t.key), ['1:bot-triage']);
});

const reviewedAt = daysAgo(2);
// Changes requested two days ago; the team spoke last and the author has not acted since.
const changesRequested = (over = {}) => pr({
  reviewDecision: 'CHANGES_REQUESTED',
  changesRequestedAt: reviewedAt,
  changesRequestedBy: ['me'],
  lastCommitAt: daysAgo(3),
  reviewRequests: [],
  conversation: { waitingOn: 'reporter', teamReplied: true, lastHuman: { role: 'team', at: reviewedAt }, since: reviewedAt },
  ...over,
});
const authorReplied = { conversation: { waitingOn: 'team', teamReplied: true, lastHuman: { role: 'reporter', at: daysAgo(1) }, since: daysAgo(1) } };
const authorPushed = { lastCommitAt: daysAgo(1) };
const mine = { me: 'me', mode: 'mine' };
const texts = (t) => t.reasons.map((r) => r.text);

test('re-review: author replied after changes were requested', () => {
  const t = one(changesRequested(authorReplied));
  assert.equal(t.kind, 're-review');
  assert.equal(texts(t)[0], 'author replied');
});

test('re-review: author pushed after changes were requested', () => {
  const t = one(changesRequested(authorPushed));
  assert.equal(t.kind, 're-review');
  assert.equal(texts(t)[0], 'author pushed');
});

test('re-review: review re-requested', () => {
  const t = one(changesRequested({ reviewRequests: [{ login: 'me' }] }), mine);
  assert.equal(t.kind, 're-review');
  assert.equal(texts(t)[0], 'review re-requested');
});

test('no re-review for drafts, other review decisions, or an author who did nothing', () => {
  const owned = { assignees: [{ login: 'me' }] };
  const acted = { ...owned, ...authorReplied, ...authorPushed };
  assert.ok(!kinds(one(changesRequested({ ...acted, isDraft: true }), mine)).includes('re-review'));
  for (const reviewDecision of ['APPROVED', 'REVIEW_REQUIRED', null])
    assert.ok(!kinds(one(changesRequested({ ...acted, reviewDecision }), mine)).includes('re-review'));
  assert.ok(!kinds(one(changesRequested(owned), mine)).includes('re-review'));
});

test('no re-review for a pending request to someone who did not request the changes', () => {
  const owned = { assignees: [{ login: 'me' }] };
  const teamRequest = changesRequested({ ...owned, changesRequestedBy: ['kudo'], reviewRequests: [{ name: 'expo-cli' }] });
  assert.ok(!kinds(one(teamRequest, mine)).includes('re-review'));
  const otherUser = changesRequested({ ...owned, changesRequestedBy: ['kudo'], reviewRequests: [{ login: 'me' }] });
  assert.ok(!kinds(one(otherUser, mine)).includes('re-review'));
});

test('re-review: the reviewer who requested changes is requested again', () => {
  const t = one(changesRequested({ changesRequestedBy: ['kudo'], reviewRequests: [{ login: 'kudo' }], assignees: [{ login: 'me' }] }), mine);
  assert.equal(t.kind, 're-review');
  assert.deepEqual(texts(t).slice(0, 1), ['review re-requested']);
});

test('no re-review without changesRequestedAt, even when waiting on the team', () => {
  const unknown = { changesRequestedAt: null, changesRequestedBy: [], assignees: [{ login: 'me' }] };
  assert.ok(!kinds(one(changesRequested({ ...unknown, ...authorReplied, ...authorPushed }), mine)).includes('re-review'));
});

test('re-review: on-call only when nobody owns the PR; mine for an assignee or requested reviewer', () => {
  assert.equal(TASK_KINDS['re-review'].oncall, false);
  assert.equal(one(changesRequested(authorReplied)).kind, 're-review');
  assert.equal(one(changesRequested(authorPushed)).kind, 're-review');
  assert.equal(one(changesRequested({ ...authorPushed, reviewRequests: [{ login: 'kudo' }] })), undefined);
  assert.equal(one(changesRequested({ ...authorPushed, assignees: [{ login: 'kudo' }] }), { includeAssigned: true }), undefined);
  assert.equal(one(changesRequested({ ...authorPushed, assignees: [{ login: 'me' }] }), mine).kind, 're-review');
  assert.equal(one(changesRequested({ ...authorPushed, reviewRequests: [{ login: 'me' }] }), mine).kind, 're-review');
  assert.equal(one(changesRequested({ ...authorPushed, reviewRequests: [{ login: 'kudo' }] }), mine), undefined);
});

test('re-review ranks above review, and higher when my review is requested', () => {
  const owned = { ...authorReplied, assignees: [{ login: 'me' }] };
  const review = one(pr({ ...botReview(true), ...owned }), mine);
  const reReview = one(changesRequested(owned), mine);
  assert.equal(reReview.score, review.score + 1);
  const requested = one(changesRequested({ ...owned, reviewRequests: [{ login: 'me' }] }), mine);
  assert.equal(requested.score, reReview.score + 10);
  const requestedOnly = one(changesRequested({ ...authorReplied, reviewRequests: [{ login: 'me' }] }), mine);
  assert.equal(requestedOnly.score, requested.score);
  assert.equal(texts(requestedOnly).filter((text) => text === 'your review requested').length, 1);
});

test('author replied, pushed and re-requested my review -> re-review, as on #45029', () => {
  const t = one(pr({
    number: 45029,
    createdAt: '2026-10-20T10:00:00Z',
    reviewDecision: 'CHANGES_REQUESTED',
    changesRequestedAt: '2026-10-27T13:58:00Z',
    lastCommitAt: '2026-10-28T09:01:00Z',
    conversation: { waitingOn: 'team', teamReplied: true, lastHuman: { role: 'reporter', at: '2026-10-27T22:51:38Z' }, since: '2026-10-27T22:51:38Z' },
    changesRequestedBy: ['chrfalch'],
    reviewRequests: [{ login: 'chrfalch' }],
    assignees: [{ login: 'chrfalch' }],
    latestReviews: [],
  }), { me: 'chrfalch', mode: 'mine', now: new Date('2026-10-28T12:00:00Z').getTime() });
  assert.equal(t.kind, 're-review');
  assert.deepEqual(texts(t).slice(0, 3), ['author replied', 'author pushed', 'review re-requested']);
});
