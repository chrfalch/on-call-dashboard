import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS } from './public/actions.js';
import { TASK_KINDS } from './public/inbox.js';
import { applyPlan, hasPending, recAction, recDisagrees, recFor, recLabel, recRequest, recSignature } from './public/recs.js';
import { recKey } from './recommend.mjs';

const issue = { type: 'issue', number: 12, url: 'https://github.com/expo/expo/issues/12', updatedAt: '2026-10-26T10:00:00Z' };
const pr = { type: 'pr', number: 34, url: 'https://github.com/expo/expo/pull/34', updatedAt: '2026-10-26T11:00:00Z' };
const task = (item, kind = 'reply', reasons = []) => ({ key: `${item.number}:${kind}`, kind, item, reasons, score: 50, also: [] });
const rec = (action, over = {}) => ({ action, who: 'on-call', why: 'Because.', draft: null, confidence: 70, ...over });

test('recRequest sends key, kind and reason texts, and nothing about the item', () => {
  const body = recRequest([task(issue, 'reply', [{ text: 'waiting 3d' }, { text: '👍 4' }])]);
  assert.deepEqual(body, { tasks: [{ key: '12:reply', kind: 'reply', reasons: [{ text: 'waiting 3d' }, { text: '👍 4' }] }] });
});

test('recRequest turns label reasons into text and drops empty ones', () => {
  const body = recRequest([task(issue, 'reply', [{ label: 'severity: high' }, { label: undefined }, { text: '' }])]);
  assert.deepEqual(body.tasks[0].reasons, [{ text: 'severity: high' }]);
});

test('recRequest keeps the first 30 tasks in order', () => {
  const tasks = Array.from({ length: 35 }, (_, i) => task({ ...issue, number: i + 1 }));
  const keys = recRequest(tasks).tasks.map((t) => t.key);
  assert.equal(keys.length, 30);
  assert.equal(keys[0], '1:reply');
  assert.equal(keys[29], '30:reply');
});

test('recRequest of no tasks is an empty list', () => {
  assert.deepEqual(recRequest([]), { tasks: [] });
});

test('recSignature changes when the requested set or an item version changes', () => {
  const a = [task(issue), task(pr, 'merge')];
  assert.equal(recSignature(a), recSignature([task(issue), task(pr, 'merge')]));
  assert.notEqual(recSignature(a), recSignature([task(pr, 'merge'), task(issue)]));
  assert.notEqual(recSignature(a), recSignature([task(issue)]));
  assert.notEqual(recSignature(a), recSignature([task({ ...issue, updatedAt: '2026-10-27T00:00:00Z' }), task(pr, 'merge')]));
});

test('recSignature ignores tasks after the first 30', () => {
  const tasks = Array.from({ length: 30 }, (_, i) => task({ ...issue, number: i + 1 }));
  assert.equal(recSignature(tasks), recSignature([...tasks, task({ ...issue, number: 99 })]));
});

test('hasPending is true only when some task is pending', () => {
  assert.equal(hasPending({ '1:reply': { status: 'pending' }, '2:reply': { status: 'error', error: 'x' } }), true);
  assert.equal(hasPending({ '1:reply': { status: 'done', rec: rec('wait'), recKey: '1:reply@t' } }), false);
  assert.equal(hasPending({}), false);
  assert.equal(hasPending(null), false);
  assert.equal(hasPending(undefined), false);
});

test('recFor returns the entry for the task', () => {
  const pending = { status: 'pending' };
  const error = { status: 'error', error: 'claude failed' };
  assert.equal(recFor({ '12:reply': pending }, task(issue)), pending);
  assert.equal(recFor({ '12:reply': error }, task(issue)), error);
  assert.equal(recFor({}, task(issue)), undefined);
  assert.equal(recFor(undefined, task(issue)), undefined);
});

test('recFor drops a done rec made for an older version of the item', () => {
  const current = { status: 'done', rec: rec('wait'), recKey: `12:reply@${issue.updatedAt}` };
  const stale = { status: 'done', rec: rec('wait'), recKey: '12:reply@2026-10-01T00:00:00Z' };
  assert.equal(recFor({ '12:reply': current }, task(issue)), current);
  assert.equal(recFor({ '12:reply': stale }, task(issue)), undefined);
});

test('recFor and recSignature follow a linked PR merging, like the server recKey', () => {
  const linkedPr = (state) => ({ number: 7, title: 'Fix', state, mergedAt: null, baseRefName: 'main' });
  const open = task({ ...issue, linkedPrs: [linkedPr('OPEN')] }, 'close-candidate');
  const merged = task({ ...issue, linkedPrs: [linkedPr('MERGED')] }, 'close-candidate');
  const done = { status: 'done', rec: rec('wait'), recKey: recKey(merged, merged.item) };
  assert.equal(recFor({ '12:close-candidate': done }, merged), done);
  assert.equal(recFor({ '12:close-candidate': done }, open), undefined);
  assert.notEqual(recSignature([open]), recSignature([merged]));
});

test('recFor does not read inherited properties', () => {
  assert.equal(recFor({}, { ...task(issue), key: 'toString' }), undefined);
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

test('recDisagrees: a close task and a rec that does not close', () => {
  assert.deepEqual(recDisagrees(task(pr, 'close'), rec('nudge-author')), { task: 'Close stale', agent: 'Nudge author' });
  assert.deepEqual(recDisagrees(task(issue, 'close-candidate'), rec('wait')), { task: 'Close candidate', agent: 'Wait' });
});

test('recDisagrees: a close task agrees with close and close as duplicate', () => {
  assert.equal(recDisagrees(task(pr, 'close'), rec('close')), null);
  assert.equal(recDisagrees(task(issue, 'close'), rec('close-duplicate')), null);
});

test('recDisagrees: a bot-command task agrees only with that command', () => {
  assert.equal(recDisagrees(task(issue, 'verify'), rec('verify')), null);
  assert.equal(recDisagrees(task(pr, 'bot-review'), rec('request-review')), null);
  assert.deepEqual(recDisagrees(task(issue, 'verify'), rec('ask-reporter')), { task: 'Verify new issue', agent: 'Ask reporter' });
  assert.deepEqual(recDisagrees(task(pr, 'bot-review'), rec('close')), { task: 'Request bot review', agent: 'Close' });
});

test('recDisagrees: tasks that only open the item never disagree', () => {
  for (const kind of ['reply', 'first-response', 'review', 'merge', 'nudge', 'assign-repro', 'fix-severity']) {
    assert.equal(recDisagrees(task(pr, kind), rec('wait')), null, kind);
  }
});

test('recDisagrees: no answer for an unknown action, an action for the other item type, or an unknown task kind', () => {
  assert.equal(recDisagrees(task(pr, 'close'), rec('nope')), null);
  assert.equal(recDisagrees(task(pr, 'close'), rec('accept')), null);
  assert.equal(recDisagrees(task(pr, 'nope'), rec('wait')), null);
  assert.equal(recDisagrees(task(pr, 'close'), undefined), null);
});

test('recDisagrees: every bot-command task kind agrees with some action', () => {
  for (const [kind, { action }] of Object.entries(TASK_KINDS)) {
    if (action !== 'command') continue;
    const item = kind === 'bot-review' ? pr : issue;
    assert.ok(ACTIONS.some((a) => recDisagrees(task(item, kind), rec(a.id)) === null), kind);
  }
});
