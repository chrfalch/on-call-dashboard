// Runs syncFn(kind) one call at a time. Both methods resolve { ok: true } or
// { ok: false, error } and never reject.
export function createSyncRunner(syncFn) {
  let current = null;
  let followUp = null;

  function start(kind) {
    let sync;
    try {
      sync = Promise.resolve(syncFn(kind));
    } catch (e) {
      sync = Promise.reject(e);
    }
    current = sync.then(() => ({ ok: true }), (e) => ({ ok: false, error: String(e?.message ?? e) })).then(finish);
    return current;
  }

  // Starts the follow-up here, not in a later callback, so a run() from any
  // callback on the finished sync cannot slip in and overlap it.
  function finish(result) {
    if (followUp) {
      const { kind, resolve } = followUp;
      followUp = null;
      resolve(start(kind));
    } else {
      current = null;
    }
    return result;
  }

  function run(kind) {
    return current ?? start(kind);
  }

  // The in-flight sync may have started before the caller's change on GitHub,
  // so wait for it and then sync once more. Callers that arrive during the
  // same sync share that one follow-up.
  function runAndWait(kind) {
    if (!current) return start(kind);
    if (!followUp) {
      let resolve;
      const promise = new Promise((r) => (resolve = r));
      followUp = { kind, promise, resolve };
    }
    return followUp.promise;
  }

  return { run, runAndWait };
}
