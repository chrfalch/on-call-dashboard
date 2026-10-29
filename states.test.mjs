import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ASK_FOR_ISSUE, needsBotTriage } from './public/inbox.js';
import { CLEANUP_FILTERS, STATE_CHIPS, STATES, cleanupAction, cleanupFilters, inboxCounts, inboxRows, isOpen, stateAction, stateOf } from './public/states.js';

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

test('C11: an open external non-draft PR without a linked issue', () => {
  assert.ok(filters(pr({ state: 'OPEN', linkedIssues: [] })).includes('C11'));
});

test('C11: not with a linked issue', () => {
  assert.ok(!filters(pr({ state: 'OPEN', linkedIssues: [{ number: 123 }] })).includes('C11'));
});

test('C11: not when linked issues are unknown', () => {
  assert.ok(!filters(pr({ state: 'OPEN', linkedIssues: undefined })).includes('C11'));
});

test('C11: not for a draft', () => {
  assert.ok(!filters(pr({ state: 'OPEN', isDraft: true })).includes('C11'));
});

test('C11: not for a merged or closed PR', () => {
  for (const state of ['MERGED', 'CLOSED'])
    assert.ok(!filters(pr({ state })).includes('C11'));
});

test('C11: not with the internal contributor label', () => {
  assert.ok(!filters(pr({ state: 'OPEN', labels: labels('contributor: internal') })).includes('C11'));
});

test('C11: not for an internal author', () => {
  assert.ok(!filters(pr({ state: 'OPEN', ...waiting('internal', 3) })).includes('C11'));
});

test('C11: not for an issue', () => {
  assert.ok(!filters(issue({ state: 'OPEN', linkedIssues: [] })).includes('C11'));
});

test('C11: a bot author without a linked issue', () => {
  assert.ok(filters(pr({ state: 'OPEN', author: { login: 'dependabot[bot]' }, authorAssociation: 'NONE', linkedIssues: [] })).includes('C11'));
});

const noBotReview = { bot: { lastCommand: null, botRepliedAfterCommand: false, lastReview: null, botRepliedAfterReview: false } };
const awaitingCi = (over = {}) => pr({ state: 'OPEN', author: { login: 'contributor' }, ciApprovalRunIds: [101, 102], ...botReview(true), ...over });

test('P11: CI runs wait for approval after the bot review, instead of P6', () => {
  assert.equal(state(awaitingCi()), 'P11');
});

test('P11: CI runs wait for approval after the bot review, instead of P7', () => {
  assert.equal(state(awaitingCi({ reviewRequests: [{ login: 'reviewer' }] })), 'P11');
});

test('P11: not before the bot review is asked', () => {
  assert.equal(state(awaitingCi(noBotReview)), 'P2');
});

test('P11: not while the bot is still reviewing', () => {
  assert.equal(state(awaitingCi(botReview(false))), 'P3');
});

test('P11: never for a github-actions PR', () => {
  assert.equal(state(awaitingCi({ author: { login: 'github-actions' } })), 'P6');
  assert.equal(state(awaitingCi({ author: { login: 'github-actions' }, ...noBotReview })), 'P2');
});

test('P11: another bot author still needs the bot review first', () => {
  assert.equal(state(awaitingCi({ author: { login: 'dependabot' } })), 'P11');
  assert.equal(state(awaitingCi({ author: { login: 'dependabot' }, ...noBotReview })), 'P2');
});

test('P11: earlier states win', () => {
  assert.equal(state(awaitingCi({ reviewDecision: 'CHANGES_REQUESTED', changesRequestedAt: daysAgo(2), changesRequestedBy: ['me'], lastCommitAt: daysAgo(3) })), 'P4');
  assert.equal(state(changesRequested(5, { lastCommitAt: daysAgo(1), ciApprovalRunIds: [101] })), 'P5');
  assert.equal(state(awaitingCi({ reviewDecision: 'APPROVED' })), 'P8');
  assert.equal(state(awaitingCi({ isDraft: true })), 'P1');
});

test('P11: not without waiting runs', () => {
  assert.equal(state(awaitingCi({ ciApprovalRunIds: [] })), 'P6');
  assert.equal(state(awaitingCi({ ciApprovalRunIds: undefined })), 'P6');
});

test('no cleanup filter for CI approval', () => {
  assert.ok(!CLEANUP_FILTERS.some((filter) => filter.id === 'C12'));
  assert.ok(!filters(awaitingCi()).includes('C12'));
});

test('ASK_FOR_ISSUE gives a linking example and asks to open an issue', () => {
  assert.equal(
    ASK_FOR_ISSUE,
    'Thanks for the PR! We track every change against an issue. Can you link the issue this PR fixes (for example, add "Fixes #123" to the description)? If there is no issue yet, please open one that describes the problem, then link it here.',
  );
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

test('STATES lists the issue track, then the PR track, with labels', () => {
  assert.deepEqual(STATES.map(({ id, label, track }) => [id, label, track]), [
    ['I1', 'New', 'issue'],
    ['I2', 'Triaging', 'issue'],
    ['I3', 'Needs verification', 'issue'],
    ['I4', 'Waiting on reporter', 'issue'],
    ['I5', 'Not reproducible', 'issue'],
    ['I6', 'Reproduced', 'issue'],
    ['I7', 'Waiting for PR', 'issue'],
    ['I8', 'Fix in progress', 'issue'],
    ['I9', 'Fix merged', 'issue'],
    ['I10', 'Closed', 'issue'],
    ['P1', 'Draft', 'pr'],
    ['P2', 'Needs bot review', 'pr'],
    ['P3', 'Bot reviewing', 'pr'],
    ['P4', 'Changes requested', 'pr'],
    ['P5', 'Author answered', 'pr'],
    ['P11', 'CI awaits approval', 'pr'],
    ['P6', 'Ready for human', 'pr'],
    ['P7', 'In human review', 'pr'],
    ['P8', 'Ready to merge', 'pr'],
    ['P9', 'Merged', 'pr'],
    ['P10', 'Abandoned', 'pr'],
  ]);
  assert.ok(STATES.every((s) => s.icon));
});

test('STATE_CHIPS: every state except Closed, Merged and Abandoned, in order', () => {
  const ended = ['I10', 'P9', 'P10'];
  const ids = STATE_CHIPS.map((s) => s.id);
  assert.deepEqual(ids, STATES.map((s) => s.id).filter((id) => !ended.includes(id)));
  assert.ok(ended.every((id) => !ids.includes(id)));
});

test('STATES: on-call states and tones', () => {
  const ids = (pick) => STATES.filter(pick).map((s) => s.id);
  assert.deepEqual(ids((s) => s.oncall), ['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I9', 'P2', 'P3', 'P11', 'P6']);
  assert.deepEqual(ids((s) => s.tone === 'attention'), ['I1', 'I3', 'P2', 'P5', 'P11', 'P6']);
  assert.deepEqual(ids((s) => s.tone === 'danger'), ['I6']);
  assert.deepEqual(ids((s) => s.tone === 'success'), ['I5', 'I9', 'P8']);
  assert.equal(ids((s) => s.tone === 'muted').length, 11);
});

test('CLEANUP_FILTERS skips C6', () => {
  assert.deepEqual(CLEANUP_FILTERS.map(({ id, label }) => [id, label]), [
    ['C1', 'Team owes a reply'],
    ['C2', 'Reporter silent 14d'],
    ['C3', 'Not reproducible still open 7d'],
    ['C4', 'Unsupported SDK'],
    ['C5', 'Fell through triage'],
    ['C7', 'Stale PR'],
    ['C8', 'Owner silent'],
    ['C9', 'Approved but cannot land'],
    ['C10', 'Stuck waiting for the bot'],
    ['C11', 'PR without an issue'],
  ]);
});

const action = (item, stateId) => stateAction(item, stateId, { now: NOW });

test('stateAction: I1, I3 and P2 post a bot command', () => {
  assert.deepEqual([action(issue(), 'I1'), action(issue(), 'I3'), action(pr(), 'P2')].map(({ kind, body }) => [kind, body]), [
    ['command', '@expo-bot triage'],
    ['command', '@expo-bot verify'],
    ['command', '@expo-bot review'],
  ]);
});

test('stateAction: I5 and I9 close', () => {
  assert.equal(action(issue(), 'I5').kind, 'close');
  assert.equal(action(issue(), 'I9').kind, 'close');
});

test('stateAction: I6 applies the severity when the label is wrong', () => {
  const triage = { assessment: { ...assessment, severity: { label: 'severity: 3' } }, verification: null, fixPrs: [] };
  assert.equal(action(issue({ triage }), 'I6').kind, 'apply-severity');
  assert.equal(action(issue({ triage, labels: labels('severity: 3') }), 'I6').kind, 'open');
});

test('stateAction: I8 opens the first open fix PR', () => {
  const linkedPrs = [
    { ...linkedPr('OPEN', false), url: 'https://x/mention' },
    { ...linkedPr('MERGED', true), url: 'https://x/merged' },
    { ...linkedPr('OPEN', true), url: 'https://x/fix' },
  ];
  const result = action(issue({ linkedPrs }), 'I8');
  assert.equal(result.kind, 'open');
  assert.equal(result.url, 'https://x/fix');
});

test('stateAction: P4 nudges after 7 days of requested changes', () => {
  assert.equal(action(changesRequested(7), 'P4').kind, 'nudge');
  assert.equal(action(changesRequested(6), 'P4').kind, 'open');
});

test('stateAction: nothing for I10, P9 and P10; open for the rest', () => {
  assert.equal(action(issue({ state: 'CLOSED' }), 'I10'), null);
  assert.equal(action(pr({ state: 'MERGED' }), 'P9'), null);
  assert.equal(action(pr({ state: 'CLOSED' }), 'P10'), null);
  assert.equal(action(issue(), 'I2').kind, 'open');
  assert.equal(action(pr(), 'P6').kind, 'open');
});

test('cleanupAction: C1 replies; C2, C3, C4 and C7 close; the rest open', () => {
  const reply = cleanupAction(issue(), 'C1');
  assert.deepEqual([reply.kind, reply.label], ['open', 'Reply']);
  for (const id of ['C2', 'C3', 'C4', 'C7']) assert.equal(cleanupAction(issue(), id).kind, 'close', id);
  for (const id of ['C5', 'C8', 'C9']) assert.equal(cleanupAction(issue(), id).kind, 'open', id);
});

test('cleanupAction: C10 re-posts the unanswered bot command', () => {
  const result = cleanupAction(issue(botAsked('verify', daysAgo(1))), 'C10');
  assert.equal(result.kind, 'command');
  assert.equal(result.body, '@expo-bot verify');
});

test('cleanupAction: C10 re-posts the review when that is what the bot owes', () => {
  const bot = { lastCommand: command('verify', daysAgo(1)), botRepliedAfterCommand: true, lastReview: command('review', daysAgo(3)), botRepliedAfterReview: false };
  assert.equal(cleanupAction(pr({ bot }), 'C10').body, '@expo-bot review');
});

test('cleanupAction: C11 asks the author to link an issue', () => {
  assert.deepEqual(cleanupAction(pr(), 'C11'), { kind: 'comment', label: 'Ask for an issue', body: ASK_FOR_ISSUE });
});

test('stateAction: P11 approves the waiting runs', () => {
  assert.deepEqual(action(awaitingCi(), 'P11'), { kind: 'approve-ci', label: 'Approve and run', runIds: [101, 102] });
});

const rowOpts = { now: NOW, me: 'me', mode: 'oncall', unsupportedSdks: new Set(['sdk-50']) };
const rows = (items, over = {}) => inboxRows(items, { ...rowOpts, ...over });
const keys = (items, over) => rows(items, over).map((row) => row.key);
const fresh = (over) => ({ ...waiting('team', 1), ...over });
const mineToo = [{ login: 'me' }];

test('inboxRows: open items only, in STATES order, then oldest first', () => {
  const items = [
    pr({ number: 5, ...fresh() }),
    issue({ number: 4, ...fresh({ labels: routed, createdAt: daysAgo(2) }) }),
    issue({ number: 3, ...fresh({ labels: routed, createdAt: daysAgo(5) }) }),
    issue({ number: 2, ...fresh() }),
    issue({ number: 1, ...fresh({ state: 'CLOSED' }) }),
  ];
  assert.deepEqual(keys(items), ['issue#2:I1', 'issue#3:I3', 'issue#4:I3', 'pr#5:P2']);
  const [first] = rows(items);
  assert.equal(first.item.number, 2);
  assert.equal(first.stateId, 'I1');
  assert.ok(Array.isArray(first.cleanup));
});

test('inboxRows: a state chip lists only that state, closed included', () => {
  const items = [issue({ number: 1, assignees: mineToo, state: 'CLOSED' }), issue({ number: 2, assignees: mineToo })];
  assert.deepEqual(keys(items, { mode: 'mine', stateId: 'I10' }), ['issue#1:I10']);
  assert.deepEqual(keys(items, { mode: 'mine' }), ['issue#2:I1']);
});

test('inboxRows: on-call closed chips list closed items without a cleanup filter', () => {
  const items = [issue({ number: 1, ...fresh({ state: 'CLOSED' }) }), pr({ number: 2, ...fresh({ state: 'MERGED' }) })];
  assert.deepEqual(keys(items, { mode: 'oncall', stateId: 'I10' }), ['issue#1:I10']);
  assert.deepEqual(keys(items, { mode: 'oncall', stateId: 'P9' }), ['pr#2:P9']);
  assert.equal(inboxCounts(items, { ...rowOpts, mode: 'oncall' }).states.I10, 1);
});

test('inboxRows: a cleanup chip lists only items with that filter', () => {
  const items = [issue({ number: 1, labels: labels('sdk-50') }), issue({ number: 2, labels: labels('sdk-54') })];
  assert.deepEqual(keys(items, { cleanupId: 'C4' }), ['issue#1:I1']);
});

test('inboxRows: on-call mode keeps on-call states and items with a cleanup filter', () => {
  const draft = pr({ number: 1, ...fresh({ isDraft: true }) });
  const unsupportedDraft = pr({ number: 2, ...fresh({ isDraft: true, labels: labels('sdk-50') }) });
  assert.deepEqual(keys([draft, unsupportedDraft]), ['pr#2:P1']);
});

test('inboxRows: on-call mode leaves assigned items unless includeAssigned', () => {
  const items = [issue({ number: 1, ...fresh({ assignees: assigned }) })];
  assert.deepEqual(keys(items), []);
  assert.deepEqual(keys(items, { includeAssigned: true }), ['issue#1:I1']);
});

test('inboxRows: My Work lists items assigned to me or awaiting my review, in any state', () => {
  const items = [
    pr({ number: 1, isDraft: true, reviewRequests: mineToo }),
    issue({ number: 2, labels: labels('Issue accepted'), assignees: mineToo }),
    issue({ number: 3, assignees: assigned }),
    issue({ number: 4 }),
  ];
  assert.deepEqual(keys(items, { mode: 'mine' }), ['issue#2:I7', 'pr#1:P1']);
});

test('inboxRows: hidden rows drop out', () => {
  const items = [issue({ number: 1 }), issue({ number: 2 })];
  assert.deepEqual(keys(items, { hidden: (key) => key === 'issue#1:I1' }), ['issue#2:I1']);
});

test('inboxCounts match inboxRows; state counts include closed items, cleanup counts do not', () => {
  const items = [
    issue({ number: 1, labels: labels('sdk-50') }),
    issue({ number: 2, labels: labels('sdk-50'), state: 'CLOSED' }),
    issue({ number: 3, ...fresh({ labels: routed }) }),
    issue({ number: 4, ...fresh({ assignees: assigned }) }),
    pr({ number: 5, ...fresh() }),
  ];
  const hidden = (key) => key === 'pr#5:P2';
  const counts = inboxCounts(items, { ...rowOpts, hidden });
  assert.deepEqual([counts.states.I1, counts.states.I3, counts.states.I10, counts.states.P2], [1, 1, 1, 0]);
  assert.equal(counts.cleanup.C4, 1);
  assert.equal(counts.cleanup.C4, rows(items, { hidden, cleanupId: 'C4' }).length);
  assert.equal(counts.states.I3, rows(items, { hidden, stateId: 'I3' }).length);
});

test('inboxRows: on-call mode keeps an assigned item with a cleanup filter', () => {
  const items = [issue({ number: 1, ...verified('problem'), assignees: assigned, ownerLastActivityAt: daysAgo(7) })];
  assert.deepEqual(keys(items, { cleanupId: 'C8' }), ['issue#1:I7']);
  assert.equal(inboxCounts(items, rowOpts).cleanup.C8, 1);
});

test('inboxRows: on-call mode leaves an assigned item with a cleanup filter out of the list and state chips unless includeAssigned', () => {
  const items = [pr({ number: 1, state: 'OPEN', assignees: assigned })];
  const [row] = rows(items, { includeAssigned: true });
  assert.ok(row.cleanup.includes('C11'));
  assert.deepEqual(keys(items), []);
  assert.deepEqual(keys(items, { stateId: row.stateId }), []);
  assert.deepEqual(keys(items, { cleanupId: 'C11' }), [row.key]);
  const counts = inboxCounts(items, rowOpts);
  assert.equal(counts.states[row.stateId], 0);
  assert.equal(counts.cleanup.C11, 1);
});

test('inboxCounts: the P11 chip counts the PRs whose CI awaits approval', () => {
  const items = [awaitingCi({ number: 1 }), awaitingCi({ number: 2, ciApprovalRunIds: [] }), awaitingCi({ number: 3, state: 'MERGED' })];
  assert.equal(inboxCounts(items, rowOpts).states.P11, 1);
  assert.deepEqual(keys(items, { stateId: 'P11' }), ['pr#1:P11']);
});

test('inboxRows: on-call mode keeps an assigned closed item', () => {
  const items = [issue({ number: 1, ...fresh({ assignees: assigned, state: 'CLOSED' }) })];
  assert.deepEqual(keys(items, { stateId: 'I10' }), ['issue#1:I10']);
  assert.equal(inboxCounts(items, rowOpts).states.I10, 1);
});

test('inboxRows: hideUnsupported drops unsupported SDK rows outside the C4 chip', () => {
  const items = [issue({ number: 1, labels: labels('sdk-50') }), issue({ number: 2 })];
  assert.deepEqual(keys(items, { hideUnsupported: true }), ['issue#2:I1']);
  assert.deepEqual(keys(items, { hideUnsupported: true, stateId: 'I1' }), ['issue#2:I1']);
  assert.deepEqual(keys(items, { hideUnsupported: false }), ['issue#1:I1', 'issue#2:I1']);
  const counts = inboxCounts(items, { ...rowOpts, hideUnsupported: true });
  assert.equal(counts.states.I1, 1);
  assert.equal(counts.cleanup.C4, 1);
});

test('inboxRows: hideUnsupported still lists unsupported SDK rows under the C4 chip', () => {
  const items = [issue({ number: 1, labels: labels('sdk-50') })];
  assert.deepEqual(keys(items, { hideUnsupported: true, cleanupId: 'C4' }), ['issue#1:I1']);
});

test('inboxRows: hideUnsupported also drops unsupported SDK rows under other cleanup chips', () => {
  const items = [issue({ number: 1, labels: labels('sdk-50'), ...waiting('team', 10) }), issue({ number: 2, ...waiting('team', 10) })];
  assert.deepEqual(keys(items, { hideUnsupported: true, cleanupId: 'C1' }), ['issue#2:I1']);
  assert.equal(inboxCounts(items, { ...rowOpts, hideUnsupported: true }).cleanup.C1, 1);
  assert.equal(inboxCounts(items, { ...rowOpts, hideUnsupported: true }).cleanup.C4, 1);
});
