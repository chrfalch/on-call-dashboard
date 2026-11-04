// "Start here": the open issues and PRs I wrote on or own, each with one status.
// Pure functions only (no DOM).
import { isBot, isTeam } from './people.js';
import { isOpen } from './states.js';
import { involves, myWrites, skipKey } from './since.js';

export { parseSkipped as parseDone } from './since.js';

const STATUS_ORDER = ['replied', 'assigned', 'waiting'];
const time = (iso) => new Date(iso).getTime();
const latest = (times) => times.reduce((a, b) => (time(b) > time(a) ? b : a));

// expo-bot can answer by editing an older comment; a person's edit is not a new reply.
const replyAt = (c) => (isBot(c.login) && c.editedAt && time(c.editedAt) > time(c.at) ? c.editedAt : c.at);

function replies(item, me) {
  const comments = (item.comments ?? []).filter((c) => c.login !== me).map(replyAt);
  const pushed = item.lastCommitAt && item.lastCommitBy !== me && !isBot(item.lastCommitBy);
  return pushed ? [...comments, item.lastCommitAt] : comments;
}

// `at` dates the row: the newest reply, my last write, or my newest assignment (else the item's creation).
function startHereRow(item, me, prs) {
  const key = skipKey(item);
  const writes = myWrites(item, me, prs).map((c) => c.at);
  if (!writes.length) {
    const assigned = (item.assignedEvents ?? []).filter((e) => e.login === me).map((e) => e.at);
    return { key, item, status: 'assigned', at: assigned.length ? latest(assigned) : item.createdAt, wroteAt: null };
  }
  const wroteAt = latest(writes);
  const newer = replies(item, me).filter((at) => time(at) > time(wroteAt));
  return newer.length ? { key, item, status: 'replied', at: latest(newer), wroteAt } : { key, item, status: 'waiting', at: wroteAt, wroteAt };
}

// Done holds until I write again, so a reply alone does not bring the row back.
const isDone = (row, done) => Object.hasOwn(done, row.key) && (row.wroteAt === null || done[row.key] >= time(row.wroteAt));

// `skipped` and `done` map skipKey to a time in ms.
export function startHereRows(items, { me = null, skipped = {}, done = {}, includeInternal = false } = {}) {
  const prs = new Map(items.filter((item) => item.type === 'pr').map((pr) => [pr.number, pr]));
  return items
    .filter((item) => isOpen(item) && (includeInternal || !isTeam(item.authorAssociation)) && involves(item, me, prs))
    .map((item) => startHereRow(item, me, prs))
    .filter((row) => !isDone(row, done) && !(skipped[row.key] >= time(row.at)))
    .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || time(b.at) - time(a.at));
}

export const withDone = (done, item, now) => ({ ...done, [skipKey(item)]: now });

// An empty list means the first sync has not finished, so nothing is known to be closed yet.
export function pruneDone(done, items) {
  if (!items.length) return done;
  const open = new Set(items.filter(isOpen).map(skipKey));
  return Object.fromEntries(Object.entries(done).filter(([key]) => open.has(key)));
}
