import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS } from './public/actions.js';
import * as recs from './public/recs.js';
import { applyPlan, hasPending, promptHash, recAction, recDisagrees, recFor, recLabel, recRequest, taskKey } from './public/recs.js';
import { cleanupAction, stateAction } from './public/states.js';
import { recKey } from './recommend.mjs';

const issue = { type: 'issue', number: 12, url: 'https://github.com/expo/expo/issues/12', updatedAt: '2026-10-26T10:00:00Z', labels: [] };
const pr = { type: 'pr', number: 34, url: 'https://github.com/expo/expo/pull/34', updatedAt: '2026-10-26T11:00:00Z', labels: [] };
const row = (item, stateId = 'I4', cleanup = ['C2']) => ({ item, stateId, cleanup, key: `${item.type}#${item.number}:${stateId}` });
const rec = (action, over = {}) => ({ action, who: 'on-call', why: 'Because.', draft: null, confidence: 70, ...over });

test('promptHash is the 32-bit FNV-1a of the UTF-8 text, as 8 hex characters', () => {
  assert.equal(promptHash(''), '811c9dc5');
  assert.equal(promptHash('a'), 'e40c292c');
  assert.equal(promptHash('foobar'), 'bf9cf968');
  assert.match(promptHash('Fermez-la, s’il vous plaît 😀'), /^[0-9a-f]{8}$/);
  assert.notEqual(promptHash('é'), promptHash('é'.normalize('NFD')));
});

test('taskKey is the item number and workflow state, with :custom-<hash> for an operator prompt', () => {
  assert.equal(taskKey(row(issue)), '12:I4');
  assert.equal(taskKey(row(pr, 'P6', [])), '34:P6');
  assert.equal(taskKey(row(issue), { prompt: 'Draft a close.' }), `12:I4:custom-${promptHash('Draft a close.')}`);
  assert.equal(taskKey(row(issue), { prompt: '  Draft a close.\n' }), taskKey(row(issue), { prompt: 'Draft a close.' }));
  assert.equal(taskKey(row(issue), { prompt: '   ' }), '12:I4');
});

test('two different prompts on the same row get different keys, the same prompt the same key', () => {
  const a = recRequest(row(issue), { prompt: 'Draft a close.' }).tasks[0].key;
  const b = recRequest(row(issue), { prompt: 'Ask for a Snack.' }).tasks[0].key;
  assert.notEqual(a, b);
  assert.equal(recRequest(row(issue), { prompt: 'Draft a close.' }).tasks[0].key, a);
});

test('recRequest sends one task with the state and cleanup filters, and nothing about the item', () => {
  assert.deepEqual(recRequest(row(issue, 'I4', ['C2', 'C4'])), { tasks: [{ key: '12:I4', state: 'I4', filters: ['C2', 'C4'] }] });
  assert.deepEqual(recRequest(row(pr, 'P2', [])), { tasks: [{ key: '34:P2', state: 'P2', filters: [] }] });
});

test('recRequest asks for any row, including C10 and bot-command states', () => {
  assert.deepEqual(recRequest(row(pr, 'P3', ['C10'])).tasks.map((t) => t.key), ['34:P3']);
  assert.deepEqual(recRequest(row(issue, 'I1', [])).tasks.map((t) => t.key), ['12:I1']);
});

test('recRequest with a prompt sends it trimmed under the :custom key', () => {
  assert.deepEqual(recRequest(row(issue), { prompt: '  Draft a polite close.\n' }), {
    tasks: [{ key: `12:I4:custom-${promptHash('Draft a polite close.')}`, state: 'I4', filters: ['C2'], prompt: 'Draft a polite close.' }],
  });
});

test('recRequest with an empty or missing prompt is the predefined request', () => {
  for (const prompt of [undefined, '', '   \n', null]) {
    assert.deepEqual(recRequest(row(issue), { prompt }), { tasks: [{ key: '12:I4', state: 'I4', filters: ['C2'] }] }, String(prompt));
  }
});

test('recs.js no longer exports the batch and task-kind helpers', () => {
  assert.equal(recs.recSignature, undefined);
  assert.equal(recs.recIsNextStep, undefined);
});

test('hasPending is true only when some task is pending', () => {
  assert.equal(hasPending({ '1:I4': { status: 'pending' }, '2:I4': { status: 'error', error: 'x' } }), true);
  assert.equal(hasPending({ '1:I4': { status: 'done', rec: rec('wait'), recKey: '1:I4@t' } }), false);
  assert.equal(hasPending({}), false);
  assert.equal(hasPending(null), false);
  assert.equal(hasPending(undefined), false);
});

test('recFor returns the entry for the key', () => {
  const pending = { status: 'pending' };
  const error = { status: 'error', error: 'claude failed' };
  assert.equal(recFor({ '12:I4': pending }, '12:I4', issue), pending);
  assert.equal(recFor({ '12:I4:custom': error }, '12:I4:custom', issue), error);
  assert.equal(recFor({ '12:I4': pending }, '12:I4:custom', issue), undefined);
  assert.equal(recFor({}, '12:I4', issue), undefined);
  assert.equal(recFor(undefined, '12:I4', issue), undefined);
});

test('recFor drops a done rec made for an older version of the item', () => {
  const current = { status: 'done', rec: rec('wait'), recKey: `12:I4@${issue.updatedAt}` };
  const stale = { status: 'done', rec: rec('wait'), recKey: '12:I4@2026-10-01T00:00:00Z' };
  assert.equal(recFor({ '12:I4': current }, '12:I4', issue), current);
  assert.equal(recFor({ '12:I4': stale }, '12:I4', issue), undefined);
  const custom = { status: 'done', rec: rec('wait'), recKey: `12:I4:custom@${issue.updatedAt}` };
  assert.equal(recFor({ '12:I4:custom': custom }, '12:I4:custom', issue), custom);
});

test('recFor follows a linked PR merging, like the server recKey', () => {
  const linkedPr = (state) => ({ number: 7, title: 'Fix', state, mergedAt: null, baseRefName: 'main' });
  const open = { ...issue, linkedPrs: [linkedPr('OPEN')] };
  const merged = { ...issue, linkedPrs: [linkedPr('MERGED')] };
  const done = { status: 'done', rec: rec('wait'), recKey: recKey({ key: '12:I9' }, merged) };
  assert.equal(recFor({ '12:I9': done }, '12:I9', merged), done);
  assert.equal(recFor({ '12:I9': done }, '12:I9', open), undefined);
});

test('recFor does not read inherited properties', () => {
  assert.equal(recFor(Object.create({ '12:I4': { status: 'pending' } }), '12:I4', issue), undefined);
  assert.equal(recFor({}, 'toString', issue), undefined);
});

test('recAction finds the action when it fits the item type', () => {
  assert.equal(recAction(rec('ask-reporter'), issue), ACTIONS.find((a) => a.id === 'ask-reporter'));
  assert.equal(recAction(rec('close'), pr).id, 'close');
  assert.equal(recAction(rec('merge'), issue), undefined);
  assert.equal(recAction(rec('nope'), issue), undefined);
  assert.equal(recAction(null, issue), undefined);
});

test('applyPlan: command posts the action body, never rec text', () => {
  assert.deepEqual(applyPlan(rec('verify', { draft: '@expo-bot close' }), issue), { kind: 'command', body: '@expo-bot verify' });
  assert.deepEqual(applyPlan(rec('request-review'), pr), { kind: 'command', body: '@expo-bot review' });
});

test('applyPlan: comment uses the draft', () => {
  assert.deepEqual(applyPlan(rec('ask-reporter', { draft: 'Can you share a Snack?' }), issue), { kind: 'comment', body: 'Can you share a Snack?' });
  assert.deepEqual(applyPlan(rec('nudge-author', { draft: 'Please rebase.' }), pr), { kind: 'comment', body: 'Please rebase.' });
});

test('applyPlan: a comment without a usable draft starts empty', () => {
  assert.deepEqual(applyPlan(rec('review-note', { draft: null }), pr), { kind: 'comment', body: '' });
  assert.deepEqual(applyPlan(rec('review-note', { draft: { html: '<b>' } }), pr), { kind: 'comment', body: '' });
});

test('applyPlan: close uses the action reason and the draft', () => {
  assert.deepEqual(applyPlan(rec('close-duplicate', { draft: 'Duplicate of #1.' }), issue), { kind: 'close', reason: 'duplicate', body: 'Duplicate of #1.' });
  assert.deepEqual(applyPlan(rec('close'), pr), { kind: 'close', reason: 'completed', body: '' });
});

test('applyPlan: github opens the trusted item URL, never rec text', () => {
  const hostile = { why: 'https://evil.example', who: 'javascript:alert(1)', draft: 'https://evil.example' };
  assert.deepEqual(applyPlan(rec('accept', hostile), issue), { kind: 'github', url: issue.url });
  assert.deepEqual(applyPlan(rec('assign-owner'), issue), { kind: 'github', url: issue.url });
  assert.deepEqual(applyPlan(rec('merge', hostile), pr), { kind: 'github', url: pr.url });
});

test('applyPlan: wait does nothing', () => {
  assert.deepEqual(applyPlan(rec('wait'), issue), { kind: 'none' });
});

test('applyPlan: unknown actions and actions for the other item type do nothing', () => {
  assert.deepEqual(applyPlan(rec('rm -rf'), issue), { kind: 'none' });
  assert.deepEqual(applyPlan(rec('__proto__'), issue), { kind: 'none' });
  assert.deepEqual(applyPlan(rec('merge'), issue), { kind: 'none' });
  assert.deepEqual(applyPlan(rec('verify'), pr), { kind: 'none' });
  assert.deepEqual(applyPlan(rec('close-duplicate'), pr), { kind: 'none' });
  assert.deepEqual(applyPlan(null, issue), { kind: 'none' });
});

test('recLabel puts the person in the button when the action addresses them', () => {
  assert.deepEqual(recLabel(rec('ask-reporter', { who: 'yerapat' }), issue), { button: 'Ask yerapat', who: null });
  assert.deepEqual(recLabel(rec('nudge-author', { who: 'brentvatne' }), pr), { button: 'Ask brentvatne', who: null });
  assert.deepEqual(recLabel(rec('review-note', { who: 'brentvatne' }), pr), { button: 'Tell brentvatne', who: null });
  assert.deepEqual(recLabel(rec('assign-owner', { who: 'alanjhughes' }), issue), { button: 'Assign to alanjhughes', who: null });
  assert.deepEqual(recLabel(rec('accept', { who: 'alanjhughes' }), issue), { button: 'Accept, assign to alanjhughes', who: null });
});

test('recLabel keeps the action label and a separate who when the person only does the action', () => {
  assert.deepEqual(recLabel(rec('verify'), issue), { button: 'Ask bot to verify', who: 'Done by' });
  assert.deepEqual(recLabel(rec('request-review', { who: 'kudo' }), pr), { button: 'Ask bot to review', who: 'Review by' });
  assert.deepEqual(recLabel(rec('wait', { who: 'reporter' }), issue), { button: 'Wait', who: 'Waiting on' });
});

test('recLabel returns null for an unknown action or one for the other item type', () => {
  assert.equal(recLabel(rec('nope'), issue), null);
  assert.equal(recLabel(rec('nudge-author', { who: 'brentvatne' }), issue), null);
});

const close = { kind: 'close', label: 'Close…' };

test('recDisagrees: a close button and a rec that does not close', () => {
  assert.deepEqual(recDisagrees(close, rec('nudge-author'), pr), { task: 'Close…', agent: 'Nudge author' });
  assert.deepEqual(recDisagrees(cleanupAction(issue, 'C2'), rec('wait'), issue), { task: 'Close…', agent: 'Wait' });
  assert.deepEqual(recDisagrees(stateAction(issue, 'I9'), rec('ask-reporter'), issue), { task: 'Close…', agent: 'Ask reporter' });
});

test('recDisagrees: a close button agrees with close and close as duplicate', () => {
  assert.equal(recDisagrees(close, rec('close'), pr), null);
  assert.equal(recDisagrees(close, rec('close-duplicate'), issue), null);
});

test('recDisagrees: a comment button agrees only with an action that comments', () => {
  const ask = cleanupAction(pr, 'C11');
  assert.equal(recDisagrees(ask, rec('nudge-author', { draft: 'Please open an issue.' }), pr), null);
  assert.equal(recDisagrees(ask, rec('review-note', { draft: 'Note.' }), pr), null);
  assert.deepEqual(recDisagrees(ask, rec('close'), pr), { task: 'Ask for an issue', agent: 'Close' });
  assert.deepEqual(recDisagrees(ask, rec('request-review'), pr), { task: 'Ask for an issue', agent: 'Ask bot to review' });
});

test('recDisagrees: a command button disagrees with a rec that posts a different command', () => {
  const verify = stateAction(issue, 'I3');
  assert.equal(recDisagrees(verify, rec('verify'), issue), null);
  const review = stateAction(pr, 'P2');
  assert.equal(recDisagrees(review, rec('request-review'), pr), null);
  const triage = stateAction(issue, 'I1');
  assert.deepEqual(recDisagrees(triage, rec('verify'), issue), { task: 'Ask bot to triage', agent: 'Ask bot to verify' });
  const again = { kind: 'command', label: 'Ask bot again', body: '@expo-bot review' };
  assert.equal(recDisagrees(again, rec('request-review'), pr), null);
});

test('recDisagrees: a command button disagrees with a rec that closes', () => {
  const triage = stateAction(issue, 'I1');
  assert.deepEqual(recDisagrees(triage, rec('close'), issue), { task: triage.label, agent: 'Close' });
  assert.deepEqual(recDisagrees(triage, rec('close-duplicate'), issue), { task: triage.label, agent: 'Close as duplicate' });
  const review = stateAction(pr, 'P2');
  assert.deepEqual(recDisagrees(review, rec('close'), pr), { task: review.label, agent: 'Close' });
});

test('recDisagrees: a command button agrees with a rec that comments, opens the item or waits', () => {
  const triage = stateAction(issue, 'I1');
  for (const id of ['ask-reporter', 'accept', 'assign-owner', 'wait']) {
    assert.equal(recDisagrees(triage, rec(id, { draft: 'Text.' }), issue), null, id);
  }
  for (const id of ['nudge-author', 'review-note', 'merge', 'wait']) {
    assert.equal(recDisagrees(stateAction(pr, 'P2'), rec(id, { draft: 'Text.' }), pr), null, id);
  }
});

test('recDisagrees: a nudge button counts as a comment', () => {
  const nudge = stateAction({ ...pr, changesRequestedAt: '2026-01-01T00:00:00Z' }, 'P4');
  assert.equal(nudge.kind, 'nudge');
  assert.equal(recDisagrees(nudge, rec('nudge-author', { draft: 'Please rebase.' }), pr), null);
  assert.deepEqual(recDisagrees(nudge, rec('close'), pr), { task: 'Nudge author', agent: 'Close' });
  assert.deepEqual(recDisagrees(nudge, rec('request-review'), pr), { task: 'Nudge author', agent: 'Ask bot to review' });
});

test('recDisagrees: an apply-severity button never disagrees', () => {
  const severity = { kind: 'apply-severity', label: 'Apply severity: high' };
  for (const id of ['close', 'verify', 'ask-reporter', 'wait']) assert.equal(recDisagrees(severity, rec(id, { draft: 'Text.' }), issue), null, id);
});

test('recDisagrees: buttons that only open the item never disagree', () => {
  for (const id of ['C1', 'C5', 'C8', 'C9']) assert.equal(recDisagrees(cleanupAction(pr, id), rec('close'), pr), null, id);
  assert.equal(recDisagrees({ kind: 'open', label: 'Open' }, rec('wait'), issue), null);
});

test('recDisagrees: no answer for an unknown action, an action for the other item type, or no button', () => {
  assert.equal(recDisagrees(close, rec('nope'), pr), null);
  assert.equal(recDisagrees(close, rec('accept'), pr), null);
  assert.equal(recDisagrees(close, undefined, pr), null);
  assert.equal(recDisagrees(undefined, rec('wait'), pr), null);
  assert.equal(recDisagrees({ kind: 'toString', label: 'x' }, rec('wait'), pr), null);
});
