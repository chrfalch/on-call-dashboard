import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from './public/bot-command.js';

test('parseCommand reads the command word after the mention', () => {
  assert.deepEqual(parseCommand('@expo-bot /review'), { command: 'review', text: '@expo-bot /review' });
  assert.equal(parseCommand('@expo-bot Review').command, 'review');
  assert.equal(parseCommand('@expo-bot review, thanks').command, 'review');
});

test('parseCommand reads a leading slash command and applies aliases', () => {
  assert.deepEqual(parseCommand('  /check please '), { command: 'verify', text: '/check please' });
});

test('parseCommand keeps the text from the command to the end', () => {
  assert.deepEqual(parseCommand('Thanks!\n@expo-bot change rename the prop\n'), { command: 'change', text: '@expo-bot change rename the prop' });
});

test('parseCommand finds no command in plain text or a path', () => {
  assert.equal(parseCommand('Looks good to me'), null);
  assert.equal(parseCommand('/Users/me/app crashes'), null);
});
