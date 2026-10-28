import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localDay, dayKey, parseLog, addDone, doneCounts, weekDone } from './public/done-log.js';

// Local time, so the tests pass in any TZ.
const at = (d, h = 0, min = 0) => new Date(2026, 9, d, h, min);

test('localDay: local midnight starts a new calendar day', () => {
  assert.equal(localDay(at(27, 23, 59)), '2026-10-27');
  assert.equal(localDay(at(28)), '2026-10-28');
  assert.equal(localDay(at(28, 0, 30)), '2026-10-28');
  assert.equal(localDay(at(28, 23, 59)), '2026-10-28');
  assert.equal(localDay(at(29)), '2026-10-29');
});

test('localDay: zero-pads the local month and day', () => {
  assert.equal(localDay(new Date(2026, 0, 2, 0, 30)), '2026-01-02');
});

test('dayKey: prefixes the local calendar date', () => {
  assert.equal(dayKey(at(28, 0, 30)), 'inboxDoneLog:2026-10-28');
  assert.equal(dayKey(at(28, 23, 59)), 'inboxDoneLog:2026-10-28');
});

test('parseLog: null and invalid JSON give an empty log', () => {
  assert.deepEqual(parseLog(null), []);
  assert.deepEqual(parseLog('{broken'), []);
});

test('parseLog: non-array JSON values give an empty log', () => {
  for (const raw of ['{}', 'null', '42', '"text"', 'true']) {
    assert.deepEqual(parseLog(raw), []);
  }
});

test('parseLog: returns a valid array', () => {
  const log = [{ number: 1, type: 'issue' }, { number: 2, type: 'pr' }];
  assert.deepEqual(parseLog(JSON.stringify(log)), log);
  assert.deepEqual(parseLog('[]'), []);
});

test('addDone: deduplicates by number against the log and within items', () => {
  const log = [{ number: 1, type: 'issue' }];
  const items = [
    { number: 1, type: 'pr' },
    { number: 2, type: 'pr' },
    { number: 2, type: 'issue' },
    { number: 3, type: 'issue' },
  ];
  assert.deepEqual(addDone(log, items), [
    { number: 1, type: 'issue' },
    { number: 2, type: 'pr' },
    { number: 3, type: 'issue' },
  ]);
});

test('addDone: returns a new array without mutating the input log', () => {
  const log = [{ number: 1, type: 'issue' }];
  const result = addDone(log, [{ number: 2, type: 'pr' }]);
  assert.notStrictEqual(result, log);
  assert.deepEqual(log, [{ number: 1, type: 'issue' }]);
  assert.notStrictEqual(addDone(log, []), log);
});

test('addDone: keeps only number and type', () => {
  assert.deepEqual(addDone([], [{ number: 2, type: 'pr', title: 'Extra', url: 'https://example.com' }]), [
    { number: 2, type: 'pr' },
  ]);
});

test('doneCounts: an empty log gives zero counts', () => {
  assert.deepEqual(doneCounts([]), { total: 0, issues: 0, prs: 0 });
});

test('doneCounts: counts distinct numbers in a mixed log', () => {
  assert.deepEqual(doneCounts([
    { number: 1, type: 'issue' },
    { number: 2, type: 'pr' },
    { number: 1, type: 'issue' },
    { number: 3, type: 'issue' },
    { number: 2, type: 'pr' },
  ]), { total: 3, issues: 2, prs: 1 });
});

test('weekDone: items done on each local day from Monday to today', () => {
  const logs = { '2026-10-26': [{ number: 1, type: 'pr' }, { number: 2, type: 'issue' }], '2026-10-28': [{ number: 3, type: 'pr' }] };
  const days = weekDone((date) => logs[localDay(date)] ?? [], at(28, 15));
  assert.deepEqual(days.map((d) => [localDay(d.date), d.done]), [['2026-10-26', 2], ['2026-10-27', 0], ['2026-10-28', 1]]);
});

test('weekDone: on Monday the week has one day', () => {
  assert.deepEqual(weekDone(() => [], at(26, 9)).map((d) => d.done), [0]);
});
