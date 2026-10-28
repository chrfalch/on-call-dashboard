import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSyncRunner } from './sync-runner.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// A syncFn whose calls stay pending until the test settles them, in call order.
function controlledSync() {
  const calls = [];
  let running = 0;
  let maxRunning = 0;
  const syncFn = (kind) => {
    const d = deferred();
    calls.push({ kind, ...d });
    running++;
    maxRunning = Math.max(maxRunning, running);
    return d.promise.finally(() => running--);
  };
  return { syncFn, calls, maxRunning: () => maxRunning };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('run starts a sync with the given kind', async () => {
  const { syncFn, calls } = controlledSync();
  const runner = createSyncRunner(syncFn);
  const done = runner.run('full');
  assert.deepEqual(calls.map((c) => c.kind), ['full']);
  calls[0].resolve();
  assert.deepEqual(await done, { ok: true });
});

test('run does nothing while a sync is in flight', async () => {
  const { syncFn, calls } = controlledSync();
  const runner = createSyncRunner(syncFn);
  runner.run('incremental');
  runner.run('full');
  runner.run('incremental');
  await tick();
  assert.equal(calls.length, 1);
  calls[0].resolve();
  await tick();
  assert.equal(calls.length, 1);
});

test('run starts a new sync after the previous one finished', async () => {
  const { syncFn, calls } = controlledSync();
  const runner = createSyncRunner(syncFn);
  const first = runner.run('incremental');
  calls[0].resolve();
  await first;
  runner.run('full');
  assert.deepEqual(calls.map((c) => c.kind), ['incremental', 'full']);
});

test('runAndWait with nothing in flight starts one sync and resolves when it finishes', async () => {
  const { syncFn, calls } = controlledSync();
  const runner = createSyncRunner(syncFn);
  let result;
  runner.runAndWait('incremental').then((r) => (result = r));
  assert.equal(calls.length, 1);
  await tick();
  assert.equal(result, undefined);
  calls[0].resolve();
  await tick();
  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
});

test('runAndWait during a sync waits for it, then runs exactly one more', async () => {
  const { syncFn, calls } = controlledSync();
  const runner = createSyncRunner(syncFn);
  runner.run('full');
  let result;
  runner.runAndWait('incremental').then((r) => (result = r));
  await tick();
  assert.equal(calls.length, 1);
  calls[0].resolve();
  await tick();
  assert.deepEqual(calls.map((c) => c.kind), ['full', 'incremental']);
  assert.equal(result, undefined);
  calls[1].resolve();
  await tick();
  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 2);
});

test('runAndWait calls during the same sync share one follow-up sync', async () => {
  const { syncFn, calls } = controlledSync();
  const runner = createSyncRunner(syncFn);
  runner.run('incremental');
  const waits = [runner.runAndWait('incremental'), runner.runAndWait('incremental'), runner.runAndWait('incremental')];
  calls[0].resolve();
  await tick();
  assert.equal(calls.length, 2);
  calls[1].resolve();
  assert.deepEqual(await Promise.all(waits), [{ ok: true }, { ok: true }, { ok: true }]);
  assert.equal(calls.length, 2);
});

test('runAndWait during a follow-up sync gets a follow-up of its own', async () => {
  const { syncFn, calls } = controlledSync();
  const runner = createSyncRunner(syncFn);
  runner.run('incremental');
  const first = runner.runAndWait('incremental');
  calls[0].resolve();
  await tick();
  assert.equal(calls.length, 2);
  let secondResult;
  runner.runAndWait('incremental').then((r) => (secondResult = r));
  calls[1].resolve();
  assert.deepEqual(await first, { ok: true });
  await tick();
  assert.equal(calls.length, 3);
  assert.equal(secondResult, undefined);
  calls[2].resolve();
  await tick();
  assert.deepEqual(secondResult, { ok: true });
});

test('run while a follow-up is pending does not start an extra sync', async () => {
  const { syncFn, calls } = controlledSync();
  const runner = createSyncRunner(syncFn);
  runner.run('full');
  const waited = runner.runAndWait('incremental');
  runner.run('incremental');
  calls[0].resolve();
  await tick();
  runner.run('incremental');
  calls[1].resolve();
  await waited;
  await tick();
  assert.equal(calls.length, 2);
});

test('only one sync runs at a time', async () => {
  const { syncFn, calls, maxRunning } = controlledSync();
  const runner = createSyncRunner(syncFn);
  runner.run('full');
  runner.runAndWait('incremental');
  runner.run('incremental');
  runner.runAndWait('incremental');
  for (let i = 0; i < 4; i++) {
    calls[i]?.resolve();
    await tick();
    runner.runAndWait('incremental');
    runner.run('full');
  }
  assert.equal(maxRunning(), 1);
});

test('runAndWait reports a failed sync without rejecting', async () => {
  const { syncFn, calls } = controlledSync();
  const runner = createSyncRunner(syncFn);
  const waited = runner.runAndWait('incremental');
  calls[0].reject(new Error('rate limited'));
  assert.deepEqual(await waited, { ok: false, error: 'rate limited' });
});

test('runAndWait reports the follow-up result, not the in-flight one', async () => {
  const { syncFn, calls } = controlledSync();
  const runner = createSyncRunner(syncFn);
  runner.run('full');
  const waited = runner.runAndWait('incremental');
  calls[0].reject(new Error('boom'));
  await tick();
  calls[1].resolve();
  assert.deepEqual(await waited, { ok: true });
});

test('a rejected sync does not leave the runner stuck', async () => {
  const { syncFn, calls } = controlledSync();
  const runner = createSyncRunner(syncFn);
  const failed = runner.run('incremental');
  calls[0].reject(new Error('network'));
  assert.deepEqual(await failed, { ok: false, error: 'network' });
  const waited = runner.runAndWait('incremental');
  assert.equal(calls.length, 2);
  calls[1].resolve();
  assert.deepEqual(await waited, { ok: true });
});

test('run from a callback on the finished sync does not overlap the follow-up', async () => {
  const { syncFn, calls, maxRunning } = controlledSync();
  const runner = createSyncRunner(syncFn);
  const first = runner.run('incremental');
  first.then(() => runner.run('incremental'));
  const waited = runner.runAndWait('incremental');
  calls[0].resolve();
  await tick();
  assert.equal(calls.length, 2);
  calls[1].resolve();
  assert.deepEqual(await waited, { ok: true });
  assert.equal(maxRunning(), 1);
});

test('run starts a new sync after a syncFn that threw synchronously', async () => {
  let count = 0;
  const runner = createSyncRunner(() => {
    count++;
    throw new Error('bad kind');
  });
  await runner.run('incremental');
  await runner.run('incremental');
  assert.equal(count, 2);
});

test('a syncFn that throws synchronously is reported, not thrown', async () => {
  const runner = createSyncRunner(() => {
    throw new Error('bad kind');
  });
  assert.deepEqual(await runner.runAndWait('incremental'), { ok: false, error: 'bad kind' });
  assert.deepEqual(await runner.run('incremental'), { ok: false, error: 'bad kind' });
});
