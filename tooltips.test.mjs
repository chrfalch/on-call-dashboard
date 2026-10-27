import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS } from './public/actions.js';
import { TASK_KINDS } from './public/inbox.js';
import { ACTION_TIPS, CHIP_TIPS, OUTCOME_TEXT, OUTCOME_TIPS, TASK_TIPS, tooltip } from './public/tooltips.js';

const sentences = (text) => text.trim().split(/(?<=[.!?])\s+/).length;
const allTips = () => Object.entries({ CHIP_TIPS, TASK_TIPS, ACTION_TIPS, OUTCOME_TIPS }).flatMap(([group, tips]) => Object.entries(tips).map(([key, tip]) => [`${group}.${key}`, tip]));

test('every task kind has a tooltip', () => {
  assert.deepEqual(Object.keys(TASK_TIPS).sort(), Object.keys(TASK_KINDS).sort());
});

test('every recommendation action has a tooltip', () => {
  assert.deepEqual(Object.keys(ACTION_TIPS).sort(), ACTIONS.map((a) => a.id).sort());
});

test('every verification outcome has a tooltip', () => {
  assert.ok(Object.keys(OUTCOME_TEXT).length);
  assert.deepEqual(Object.keys(OUTCOME_TIPS).sort(), Object.keys(OUTCOME_TEXT).sort());
});

test('the chip tooltips cover the chips that app.js renders', () => {
  for (const key of ['label', 'assignee', 'checks', 'conflicts', 'waiting', 'botCommand', 'verdict', 'fixPr', 'recTag', 'recConfidence', 'taskScore']) {
    assert.ok(CHIP_TIPS[key], key);
  }
});

test('every tooltip has a meaning and a source of at most two sentences each', () => {
  const tips = allTips();
  assert.ok(tips.length > 0);
  for (const [key, tip] of tips) {
    for (const part of ['meaning', 'source']) {
      assert.equal(typeof tip[part], 'string', `${key}.${part}`);
      assert.ok(tip[part].trim(), `${key}.${part} is empty`);
      assert.ok(sentences(tip[part]) <= 2, `${key}.${part} has more than two sentences`);
    }
  }
});

test('tooltip puts the meaning first and the source on its own line', () => {
  const tip = { meaning: 'Checks pass.', source: 'GitHub: status checks' };
  assert.equal(tooltip(tip), 'Checks pass.\nSource: GitHub: status checks');
  assert.equal(tooltip(tip, 'Checks pending'), 'Checks pending\nSource: GitHub: status checks');
});

test('tooltip falls back to the meaning when the given text is missing', () => {
  const tip = { meaning: 'No recommendation.', source: 'Agent' };
  assert.equal(tooltip(tip, undefined), 'No recommendation.\nSource: Agent');
});
