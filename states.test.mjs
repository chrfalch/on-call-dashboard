import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsBotTriage } from './public/inbox.js';
import { cleanupFilters, isOpen, stateOf } from './public/states.js';

const NOW = new Date('2026-10-26T12:00:00Z').getTime();
const daysAgo = (d) => new Date(NOW - d * 864e5).toISOString();
const hoursAgo = (h) => new Date(NOW - h * 36e5).toISOString();

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

const ctx = { now: NOW, unsupportedSdks: new Set(['sdk-50']) };
const state = (item) => stateOf(item, ctx);
const filters = (item) => cleanupFilters(item, ctx);

const labels = (...names) => names.map((name) => ({ name }));
const routed = labels('Android', 'sdk-54');
const assigned = [{ login: 'owner' }];
const linkedPr = (state, fix) => ({ number: 10, title: 'Fix it', state, mergedAt: state === 'MERGED' ? daysAgo(1) : null, baseRefName: 'main', fix });
const verified = (outcome, at = daysAgo(1)) => ({ triage: { assessment: null, verification: { outcome, at }, fixPrs: [] } });
const assessment = { kind: 'Bug', confidence: 80, severity: null, impact: null, scope: null, at: daysAgo(2) };
const command = (name, at = daysAgo(2)) => ({ command: name, by: 'me', at });
const botAsked = (name, at) => ({ bot: { lastCommand: command(name, at), botRepliedAfterCommand: false, lastReview: null, botRepliedAfterReview: false } });
const reviewCmd = command('review');
const botReview = (replied, at) => {
  const cmd = at ? command('review', at) : reviewCmd;
  return { bot: { lastCommand: cmd, botRepliedAfterCommand: replied, lastReview: cmd, botRepliedAfterReview: replied } };
};
const waiting = (waitingOn, d) => ({ conversation: { waitingOn, teamReplied: true, since: daysAgo(d) } });

// Changes requested `d` days ago; the team spoke last and the author has not acted since.
const changesRequested = (d = 2, over = {}) => pr({
  ...botReview(true),
  reviewDecision: 'CHANGES_REQUESTED',
  changesRequestedAt: daysAgo(d),
  changesRequestedBy: ['me'],
  lastCommitAt: daysAgo(d + 1),
  reviewRequests: [],
  conversation: { waitingOn: 'reporter', teamReplied: true, lastHuman: { role: 'team', at: daysAgo(d) }, since: daysAgo(d) },
  ...over,
});
const authorReplied = (d) => ({ conversation: { waitingOn: 'team', teamReplied: true, lastHuman: { role: 'reporter', at: daysAgo(d) }, since: daysAgo(d) } });

test('I10: a closed issue', () => {
  assert.equal(state(issue({ state: 'CLOSED', linkedPrs: [linkedPr('MERGED', true)] })), 'I10');
});

test('I9: a merged fix PR', () => {
  assert.equal(state(issue({ linkedPrs: [linkedPr('MERGED', true)] })), 'I9');
});

test('I8: an open fix PR', () => {
  assert.equal(state(issue({ linkedPrs: [linkedPr('OPEN', true)] })), 'I8');
});

test('I8 needs a fix PR: an open PR that only mentions the issue does not count', () => {
  assert.equal(state(issue({ labels: routed, linkedPrs: [linkedPr('OPEN', false)] })), 'I3');
});

test('I8 beats I7: an open fix PR wins over accepted and assigned', () => {
  assert.equal(state(issue({ ...verified('problem'), assignees: assigned, linkedPrs: [linkedPr('OPEN', true)] })), 'I8');
});

test('I7: reproduced and assigned', () => {
  assert.equal(state(issue({ ...verified('problem'), assignees: assigned })), 'I7');
});

test('I7: Issue accepted and assigned', () => {
  assert.equal(state(issue({ labels: labels('Issue accepted'), assignees: assigned })), 'I7');
});

test('I6: Issue accepted and nobody assigned', () => {
  assert.equal(state(issue({ labels: labels('Issue accepted') })), 'I6');
});

test('I7 beats I5: Issue accepted and assigned, though the bot could not reproduce', () => {
  assert.equal(state(issue({ ...verified('pass'), labels: labels('Issue accepted'), assignees: assigned })), 'I7');
});

test('I6 beats I5: Issue accepted and nobody assigned, though the bot could not reproduce', () => {
  assert.equal(state(issue({ ...verified('pass'), labels: labels('Issue accepted') })), 'I6');
});

test('I6: reproduced and nobody assigned', () => {
  assert.equal(state(issue(verified('problem'))), 'I6');
});

test('I5: the bot could not reproduce', () => {
  assert.equal(state(issue(verified('pass'))), 'I5');
});

test('I5 beats I4: not reproducible while waiting on the reporter', () => {
  assert.equal(state(issue({ ...verified('pass'), ...waiting('reporter', 3), labels: labels('needs more info') })), 'I5');
});

test('I4: waiting on the reporter', () => {
  assert.equal(state(issue(waiting('reporter', 3))), 'I4');
});

test('I4: labeled needs more info', () => {
  assert.equal(state(issue({ labels: labels('needs more info') })), 'I4');
});

test('I4 beats I3: assessed by the bot while waiting on the reporter', () => {
  assert.equal(state(issue({ triage: { assessment, verification: null, fixPrs: [] }, ...waiting('reporter', 3) })), 'I4');
});

test('I3 beats I2: assessed by the bot with a verify command unanswered', () => {
  assert.equal(state(issue({ triage: { assessment, verification: null, fixPrs: [] }, ...botAsked('verify') })), 'I3');
});

test('I3: assessed by the bot, not verified', () => {
  assert.equal(state(issue({ triage: { assessment, verification: null, fixPrs: [] } })), 'I3');
});

test('I3: assessed by the bot, verification blocked', () => {
  assert.equal(state(issue({ triage: { assessment, verification: { outcome: 'blocked', at: daysAgo(1) }, fixPrs: [] } })), 'I3');
});

test('I2: bot asked to verify, no reply yet', () => {
  assert.equal(state(issue(botAsked('verify'))), 'I2');
});

test('I2: bot asked to triage, no reply yet', () => {
  assert.equal(state(issue(botAsked('triage'))), 'I2');
});

test('I2 ends once the bot replies', () => {
  assert.equal(state(issue({ labels: routed, bot: { lastCommand: command('verify'), botRepliedAfterCommand: true, lastReview: null, botRepliedAfterReview: false } })), 'I3');
});

test('I1: missing routing labels, never triaged by the bot', () => {
  const item = issue();
  assert.ok(needsBotTriage(item));
  assert.equal(state(item), 'I1');
});

test('I3 is the fallback: an open issue with no state field and no other signal', () => {
  const item = issue({ labels: routed });
  assert.equal(item.state, undefined);
  assert.equal(state(item), 'I3');
});

test('P10: a closed, unmerged PR', () => {
  assert.equal(state(pr({ state: 'CLOSED', reviewDecision: 'APPROVED' })), 'P10');
});

test('P9: a merged PR', () => {
  assert.equal(state(pr({ state: 'MERGED', reviewDecision: 'APPROVED' })), 'P9');
});

test('P1: a draft', () => {
  assert.equal(state(pr({ isDraft: true })), 'P1');
});

test('P1 beats P8: a draft that is approved', () => {
  assert.equal(state(pr({ isDraft: true, reviewDecision: 'APPROVED' })), 'P1');
});

test('P8: approved', () => {
  assert.equal(state(pr({ reviewDecision: 'APPROVED' })), 'P8');
});

test('P8 even when it cannot land: approved and conflicting', () => {
  const item = pr({ reviewDecision: 'APPROVED', mergeable: 'CONFLICTING' });
  assert.equal(state(item), 'P8');
  assert.ok(filters(item).includes('C9'));
});

test('P5: the author answered requested changes', () => {
  assert.equal(state(changesRequested(5, authorReplied(1))), 'P5');
});

test('P5: the author pushed after requested changes', () => {
  assert.equal(state(changesRequested(5, { lastCommitAt: daysAgo(1) })), 'P5');
});

test('P4: changes requested, the author has not acted', () => {
  assert.equal(state(changesRequested()), 'P4');
});

test('P3: bot review asked, no reply yet', () => {
  assert.equal(state(pr(botReview(false))), 'P3');
});

test('P2: no bot review asked', () => {
  assert.equal(state(pr({ labels: routed })), 'P2');
});

test('P2, never I1, for a PR that needs bot triage', () => {
  const item = pr();
  assert.ok(needsBotTriage(item));
  assert.equal(state(item), 'P2');
});

test('P2 beats P7: a reviewer is requested, but no bot review asked', () => {
  assert.equal(state(pr({ labels: routed, reviewRequests: [{ login: 'reviewer' }] })), 'P2');
});

test('P7: bot reviewed and a reviewer is requested', () => {
  assert.equal(state(pr({ ...botReview(true), reviewRequests: [{ login: 'reviewer' }] })), 'P7');
});

test('P7: bot reviewed and a human has reviewed', () => {
  assert.equal(state(pr({ ...botReview(true), latestReviews: [{ state: 'COMMENTED', login: 'reviewer' }] })), 'P7');
});

test('P6: bot reviewed, no human asked', () => {
  assert.equal(state(pr({ ...botReview(true), reviewRequests: [], latestReviews: [] })), 'P6');
});

test('CI checks never pick a state', () => {
  assert.equal(state(pr({ checks: 'FAILURE' })), 'P2');
  assert.equal(state(pr({ ...botReview(true), checks: 'FAILURE', mergeable: 'CONFLICTING' })), 'P6');
});

test('cleanup filters come back in ascending order', () => {
  const item = issue({ ...waiting('reporter', 20), ...verified('pass', daysAgo(10)), labels: labels('sdk-50') });
  assert.deepEqual(filters(item), ['C2', 'C3', 'C4', 'C5']);
});

test('no cleanup filter for a fresh, labeled issue', () => {
  assert.deepEqual(filters(issue({ labels: labels('needs review') })), []);
});

test('C1: waiting on the team for 7 days', () => {
  assert.ok(filters(issue(waiting('team', 7))).includes('C1'));
});

test('C1: not yet at 6 days', () => {
  assert.ok(!filters(issue(waiting('team', 6))).includes('C1'));
});

test('C1: a first response owed for 7 days', () => {
  assert.ok(filters(issue({ conversation: { waitingOn: 'team', teamReplied: false, since: daysAgo(7) } })).includes('C1'));
});

test('C1: not when the issue is the team\'s own to-do', () => {
  assert.ok(!filters(issue({ conversation: { waitingOn: 'internal', teamReplied: false, since: daysAgo(30) } })).includes('C1'));
});

test('C1: issues only', () => {
  assert.ok(!filters(pr(waiting('team', 7))).includes('C1'));
});

test('C2: reporter silent 14 days', () => {
  assert.ok(filters(issue(waiting('reporter', 14))).includes('C2'));
});

test('C2: not at 13 days', () => {
  assert.ok(!filters(issue(waiting('reporter', 13))).includes('C2'));
});

test('C2: not with an open fix PR', () => {
  assert.ok(!filters(issue({ ...waiting('reporter', 30), linkedPrs: [linkedPr('OPEN', true)] })).includes('C2'));
});

test('C2: not when parked', () => {
  assert.ok(!filters(issue({ ...waiting('reporter', 30), labels: labels('✋ on hold') })).includes('C2'));
});

test('C2: issues only', () => {
  assert.ok(!filters(pr(waiting('reporter', 14))).includes('C2'));
});

test('C3: not reproducible, verified 7 days ago', () => {
  assert.ok(filters(issue(verified('pass', daysAgo(7)))).includes('C3'));
});

test('C3: not at 6 days', () => {
  assert.ok(!filters(issue(verified('pass', daysAgo(6)))).includes('C3'));
});

test('C4: every SDK label is unsupported', () => {
  assert.ok(filters(issue({ labels: labels('sdk-50') })).includes('C4'));
});

test('C4: not when one SDK label is still supported', () => {
  assert.ok(!filters(issue({ labels: labels('sdk-50', 'sdk-54') })).includes('C4'));
});

test('C4: not without SDK labels', () => {
  assert.ok(!filters(issue()).includes('C4'));
});

test('C5: no triage label and no owner', () => {
  assert.ok(filters(issue()).includes('C5'));
});

test('C5: not when assigned', () => {
  assert.ok(!filters(issue({ assignees: assigned })).includes('C5'));
});

test('C5: issues only', () => {
  assert.ok(!filters(pr()).includes('C5'));
});

test('C6 never applies', () => {
  const items = [issue(), issue(waiting('reporter', 90)), pr(), changesRequested(90), pr({ reviewDecision: 'APPROVED', mergeable: 'CONFLICTING' })];
  for (const item of items) assert.ok(!filters(item).includes('C6'));
});

test('C7: changes requested and the author silent 21 days', () => {
  const item = changesRequested(21);
  assert.equal(state(item), 'P4');
  assert.ok(filters(item).includes('C7'));
});

test('C7: not at 20 days', () => {
  assert.ok(!filters(changesRequested(20)).includes('C7'));
});

test('C7: not once the author answered', () => {
  const item = changesRequested(30, authorReplied(25));
  assert.equal(state(item), 'P5');
  assert.ok(!filters(item).includes('C7'));
});

test('C8: accepted and assigned, owner idle 7 days', () => {
  const item = issue({ ...verified('problem'), assignees: assigned, ownerLastActivityAt: daysAgo(7) });
  assert.equal(state(item), 'I7');
  assert.ok(filters(item).includes('C8'));
});

test('C8: not at 6 days', () => {
  assert.ok(!filters(issue({ ...verified('problem'), assignees: assigned, ownerLastActivityAt: daysAgo(6) })).includes('C8'));
});

test('C8: not without ownerLastActivityAt', () => {
  assert.ok(!filters(issue({ ...verified('problem'), assignees: assigned })).includes('C8'));
});

test('C8: not with a linked PR', () => {
  const item = issue({ ...verified('problem'), assignees: assigned, ownerLastActivityAt: daysAgo(30), linkedPrs: [linkedPr('OPEN', false)] });
  assert.equal(state(item), 'I7');
  assert.ok(!filters(item).includes('C8'));
});

test('C9: approved and conflicting, without mergeStateStatus', () => {
  const item = pr({ reviewDecision: 'APPROVED', mergeable: 'CONFLICTING' });
  assert.equal(item.mergeStateStatus, undefined);
  assert.ok(filters(item).includes('C9'));
});

test('C9: approved and checks failing', () => {
  assert.ok(filters(pr({ reviewDecision: 'APPROVED', checks: 'FAILURE' })).includes('C9'));
});

test('C9: approved and blocked or behind', () => {
  for (const mergeStateStatus of ['BLOCKED', 'BEHIND'])
    assert.ok(filters(pr({ reviewDecision: 'APPROVED', mergeStateStatus })).includes('C9'));
});

test('C9: no age limit', () => {
  assert.ok(filters(pr({ reviewDecision: 'APPROVED', mergeable: 'CONFLICTING', updatedAt: hoursAgo(1), conversation: { waitingOn: 'team', teamReplied: true, since: hoursAgo(1) } })).includes('C9'));
});

test('C9: a draft that is approved and conflicting', () => {
  assert.ok(filters(pr({ isDraft: true, reviewDecision: 'APPROVED', mergeable: 'CONFLICTING' })).includes('C9'));
});

test('C9: a merged PR that was approved and conflicting', () => {
  assert.ok(filters(pr({ state: 'MERGED', reviewDecision: 'APPROVED', mergeable: 'CONFLICTING' })).includes('C9'));
});

test('C9: not when approved and clean', () => {
  assert.ok(!filters(pr({ reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN' })).includes('C9'));
});

test('C9: not when conflicting but not approved', () => {
  assert.ok(!filters(pr({ mergeable: 'CONFLICTING', checks: 'FAILURE', mergeStateStatus: 'BLOCKED' })).includes('C9'));
});

test('C10: bot command unanswered for a day', () => {
  assert.ok(filters(issue(botAsked('verify', daysAgo(1)))).includes('C10'));
});

test('C10: bot review unanswered for a day', () => {
  assert.ok(filters(pr(botReview(false, daysAgo(1)))).includes('C10'));
});

test('C10: a free-form bot command unanswered for a day', () => {
  assert.ok(filters(issue(botAsked('change', daysAgo(1)))).includes('C10'));
});

test('C10: not under a day', () => {
  assert.ok(!filters(issue(botAsked('verify', hoursAgo(23)))).includes('C10'));
});

test('C10: not once the bot replied', () => {
  assert.ok(!filters(pr(botReview(true, daysAgo(5)))).includes('C10'));
});

for (const [name, item, expected] of [
  ['open', { state: 'OPEN' }, true],
  ['state-less', {}, true],
  ['CLOSED', { state: 'CLOSED' }, false],
  ['MERGED', { state: 'MERGED' }, false],
]) {
  test(`isOpen handles a ${name} item`, () => {
    assert.equal(isOpen(item), expected);
  });
}
