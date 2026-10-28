import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseItemNumber, findItem } from './public/quick-open.js';

const issue = { type: 'issue', number: 49630 };
const pr = { type: 'pr', number: 50001 };

test('parseItemNumber accepts digits with an optional leading #', () => {
  assert.equal(parseItemNumber('49630'), 49630);
  assert.equal(parseItemNumber(' #49630 '), 49630);
  assert.equal(parseItemNumber('#1'), 1);
});

test('parseItemNumber rejects anything that is not a positive integer', () => {
  for (const text of ['#0', '0', 'abc', '49630x', '##1', '', '   ', '#', '1.5', '-3', '# 1']) {
    assert.equal(parseItemNumber(text), null, JSON.stringify(text));
  }
});

test('findItem returns the item with that number, else null', () => {
  assert.equal(findItem([issue, pr], 50001), pr);
  assert.equal(findItem([issue, pr], 1), null);
  assert.equal(findItem([], 49630), null);
});
