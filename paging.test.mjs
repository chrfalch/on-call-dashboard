import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pages } from './paging.mjs';

const timeout = Object.assign(new Error('GraphQL 502'), { status: 502 });
const isTimeout = (error) => error.status === 502;

// A fake fetchPage that records its calls and answers each from `script` in order:
// a connection, or an error to throw.
function fakeFetch(script) {
  const calls = [];
  const fetchPage = async (cursor, first) => {
    calls.push([cursor, first]);
    const next = script.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetchPage, calls };
}

const page = (nodes, endCursor = null) => ({ nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor } });

async function collect(iterable) {
  const out = [];
  for await (const conn of iterable) out.push(conn);
  return out;
}

test('pages follows endCursor until hasNextPage is false', async () => {
  const { fetchPage, calls } = fakeFetch([page([1, 2], 'a'), page([3, 4], 'b'), page([5])]);
  const conns = await collect(pages(fetchPage, { size: 2, isTimeout }));
  assert.deepEqual(conns.map((c) => c.nodes), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(calls, [[null, 2], ['a', 2], ['b', 2]]);
});

test('a timeout halves the size and retries the same cursor', async () => {
  const splits = [];
  const { fetchPage, calls } = fakeFetch([page([1], 'a'), timeout, page([2])]);
  await collect(pages(fetchPage, { size: 15, isTimeout, onSplit: (size) => splits.push(size) }));
  assert.deepEqual(calls, [[null, 15], ['a', 15], ['a', 8]]);
  assert.deepEqual(splits, [8]);
});

test('repeated timeouts go 15, 8, 4, 2, 1 and then throw', async () => {
  const { fetchPage, calls } = fakeFetch([timeout, timeout, timeout, timeout, timeout]);
  await assert.rejects(collect(pages(fetchPage, { size: 15, isTimeout })), timeout);
  assert.deepEqual(calls, [[null, 15], [null, 8], [null, 4], [null, 2], [null, 1]]);
});

test('the size returns to full after a successful page', async () => {
  const { fetchPage, calls } = fakeFetch([timeout, timeout, page([1, 2, 3], 'a'), page([4])]);
  await collect(pages(fetchPage, { size: 15, isTimeout }));
  assert.deepEqual(calls, [[null, 15], [null, 8], [null, 4], ['a', 15]]);
});

test('an error that is not a timeout throws without a retry', async () => {
  const other = new Error('bad credentials');
  const { fetchPage, calls } = fakeFetch([other]);
  await assert.rejects(collect(pages(fetchPage, { size: 15, isTimeout })), other);
  assert.deepEqual(calls, [[null, 15]]);
});

test('breaking out of the loop stops further fetches', async () => {
  const { fetchPage, calls } = fakeFetch([page([1], 'a'), page([2], 'b'), page([3])]);
  for await (const conn of pages(fetchPage, { size: 1, isTimeout })) {
    if (conn.nodes.includes(1)) break;
  }
  assert.deepEqual(calls, [[null, 1]]);
});
