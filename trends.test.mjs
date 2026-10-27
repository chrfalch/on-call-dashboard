import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weekStart, weekTrend } from './public/trends.js';

// Local time, so the tests pass in any TZ. 2026-10-26 is a Monday; day 32 is Sunday 1 November
// (US DST ends that morning, so America/* zones also exercise a 25-hour day).
const at = (d, h = 0, min = 0) => new Date(2026, 9, d, h, min);
const iso = (d, h = 12) => at(d, h).toISOString();
const MONDAY = at(26);
const entry = (createdAt, closedAt = null, number = 1) => ({ number, createdAt, closedAt });
const counts = (trend) => trend.days.map(({ opened, closed }) => [opened, closed]);

test('weekStart: Monday 00:00 is its own week start', () => {
  assert.deepEqual(weekStart(at(26)), MONDAY);
});

test('weekStart: mid-week goes back to Monday 00:00', () => {
  assert.deepEqual(weekStart(at(29, 15, 30)), MONDAY);
});

test('weekStart: Sunday 23:59 belongs to the week that started the Monday before', () => {
  assert.deepEqual(weekStart(at(25, 23, 59)), at(19));
  assert.deepEqual(weekStart(at(32, 23, 59)), at(26));
});

test('weekTrend: one point on Monday, seven on Sunday, each at local midnight', () => {
  assert.deepEqual(weekTrend([], at(26, 9)).days.map((d) => d.date), [MONDAY]);
  const sunday = weekTrend([], at(32, 23, 59));
  assert.equal(sunday.days.length, 7);
  assert.deepEqual(sunday.days.map((d) => d.date), [26, 27, 28, 29, 30, 31, 32].map((d) => at(d)));
  assert.deepEqual(sunday.start, MONDAY);
});

test('weekTrend: empty entries give zeros and flat', () => {
  const trend = weekTrend([], at(28, 10));
  assert.deepEqual(counts(trend), [[0, 0], [0, 0], [0, 0]]);
  assert.deepEqual(
    { opened: trend.opened, closed: trend.closed, net: trend.net, direction: trend.direction },
    { opened: 0, closed: 0, net: 0, direction: 'flat' },
  );
});

test('weekTrend: counts are cumulative across days', () => {
  const trend = weekTrend(
    [entry(iso(26), null, 1), entry(iso(27), iso(28), 2), entry(iso(28), null, 3), entry(iso(28, 23), null, 4)],
    at(29, 9),
  );
  assert.deepEqual(counts(trend), [[1, 0], [2, 0], [4, 1], [4, 1]]);
  assert.equal(trend.opened, 4);
  assert.equal(trend.closed, 1);
});

test('weekTrend: ignores timestamps before start and after now', () => {
  const trend = weekTrend(
    [
      entry(at(25, 23, 59).toISOString(), iso(26), 1),
      entry(iso(20), iso(21), 2),
      entry(iso(27, 14), null, 3),
      entry(iso(27, 8), iso(27, 14), 4),
    ],
    at(27, 12),
  );
  assert.deepEqual(counts(trend), [[0, 1], [1, 1]]);
});

test('weekTrend: a null closedAt is not closed', () => {
  const trend = weekTrend([entry(iso(26), null)], at(26, 18));
  assert.equal(trend.closed, 0);
  assert.equal(trend.opened, 1);
});

test('weekTrend: an item opened and closed in the same week counts once each way', () => {
  const trend = weekTrend([entry(iso(26, 9), iso(27, 9))], at(28, 9));
  assert.deepEqual(counts(trend), [[1, 0], [1, 1], [1, 1]]);
  assert.equal(trend.net, 0);
  assert.equal(trend.direction, 'flat');
});

test('weekTrend: net and direction up when more opened than closed', () => {
  const trend = weekTrend([entry(iso(26), null, 1), entry(iso(27), null, 2)], at(27, 18));
  assert.equal(trend.net, 2);
  assert.equal(trend.direction, 'up');
});

test('weekTrend: net and direction down when more closed than opened', () => {
  const trend = weekTrend([entry(iso(10), iso(26), 1), entry(iso(11), iso(27), 2)], at(27, 18));
  assert.equal(trend.opened, 0);
  assert.equal(trend.closed, 2);
  assert.equal(trend.net, -2);
  assert.equal(trend.direction, 'down');
});
