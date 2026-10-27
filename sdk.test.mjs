import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSdkLabel, sdkLabels, isUnsupportedSdk } from './public/sdk.js';

const label = (name) => ({ name, color: 'ededed', description: '' });
const item = (...names) => ({ number: 1, labels: names.map(label) });

test('isSdkLabel matches only sdk-<number>', () => {
  assert.equal(isSdkLabel('sdk-58'), true);
  assert.equal(isSdkLabel('sdk-100'), true);
  assert.equal(isSdkLabel('sdk-58-beta'), false);
  assert.equal(isSdkLabel('React Native 0.80'), false);
  assert.equal(isSdkLabel('sdk-'), false);
  assert.equal(isSdkLabel('xsdk-58'), false);
});

test('sdkLabels keeps SDK labels, newest first by number', () => {
  const repo = ['sdk-9', 'bug', 'sdk-59', 'sdk-58-beta', 'sdk-100', 'React Native 0.80'].map(label);
  assert.deepEqual(sdkLabels(repo), ['sdk-100', 'sdk-59', 'sdk-9']);
});

test('sdkLabels removes duplicates', () => {
  assert.deepEqual(sdkLabels(['sdk-55', 'sdk-57', 'sdk-55'].map(label)), ['sdk-57', 'sdk-55']);
});

test('isUnsupportedSdk is false without an SDK label', () => {
  assert.equal(isUnsupportedSdk(item(), new Set(['sdk-55'])), false);
  assert.equal(isUnsupportedSdk(item('bug'), new Set(['sdk-55'])), false);
});

test('isUnsupportedSdk with a single SDK label', () => {
  const unsupported = new Set(['sdk-55']);
  assert.equal(isUnsupportedSdk(item('sdk-55'), unsupported), true);
  assert.equal(isUnsupportedSdk(item('sdk-57'), unsupported), false);
});

test('isUnsupportedSdk needs every SDK label to be unsupported', () => {
  assert.equal(isUnsupportedSdk(item('sdk-55', 'sdk-57'), new Set(['sdk-55'])), false);
  assert.equal(isUnsupportedSdk(item('sdk-55', 'sdk-57'), new Set(['sdk-55', 'sdk-57'])), true);
});

test('isUnsupportedSdk ignores non-SDK labels', () => {
  assert.equal(isUnsupportedSdk(item('sdk-55', 'bug', 'sdk-58-beta'), new Set(['sdk-55'])), true);
  assert.equal(isUnsupportedSdk(item('sdk-58-beta'), new Set(['sdk-58-beta'])), false);
  assert.equal(isUnsupportedSdk(item('sdk-57', 'sdk-58-beta'), new Set(['sdk-58-beta'])), false);
});

test('isUnsupportedSdk is false with an empty unsupported set', () => {
  assert.equal(isUnsupportedSdk(item('sdk-55'), new Set()), false);
});
