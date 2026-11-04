// "Since last time": what changed on open issues and PRs since the on-call person last looked.
// Pure functions only (no DOM). Activity never comes from the item's update time: one bulk edit moves it on many items.
import { isBot, isTeam } from './people.js';
import { isMine, isOpen, ownedBy, rowKey, stateAction, stateOf } from './states.js';

const SKIP_DAYS = 30;
const time = (iso) => new Date(iso).getTime();
const newestFirst = (a, b) => time(b.at) - time(a.at);

// Local midnight at the start of yesterday; on a Monday, at the start of the previous Friday.
export function sinceStart(now) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (start.getDay() === 1 ? 3 : 1));
  return start;
}

// My comments and reviews; those on an issue's fix PRs count as mine on the issue. `prs` maps a PR number to the PR.
export function myWrites(item, me, prs) {
  if (!me) return [];
  const fixPrComments = (item.linkedPrs ?? []).filter((linked) => linked.fix === true).flatMap((linked) => prs.get(linked.number)?.comments ?? []);
  return [...(item.comments ?? []), ...fixPrComments].filter((c) => c.login === me);
}

// Items I wrote on or own are listed in Start here, so Since leaves them out.
export const involves = (item, me, prs) => ownedBy(item, me) || myWrites(item, me, prs).length > 0;

const teamActed = (item) => (item.comments ?? []).some((c) => isTeam(c.association) && !isBot(c.login));

// `action` is the state's one-click action; Assign when nobody owns the item, Open when someone else does; Unassign when I am assigned.
export function sinceButtons(item, { me = null, now = Date.now(), stateId = stateOf(item) } = {}) {
  const action = stateAction(item, stateId, { now, me });
  const assigned = item.assignees.length > 0;
  return {
    action: action?.kind === 'open' ? null : action,
    assign: !!me && !assigned,
    open: assigned && !isMine(item, me),
    unassign: isMine(item, me),
  };
}

export const skipKey = (item) => `${item.type}#${item.number}`;

// Groups "issues" and "prs", always in that order; a group can be empty.
// `skipped` maps skipKey to the skip time in ms; a row returns when its activity is newer.
// New issues and PRs leave out items opened by the team unless `includeInternal`.
export function sinceGroups(items, { now = Date.now(), me = null, skipped = {}, includeInternal = false } = {}) {
  const start = sinceStart(now).getTime();
  const row = (item, event) => {
    const stateId = stateOf(item);
    return { key: rowKey(item, stateId), item, ...event, ...sinceButtons(item, { me, now, stateId }) };
  };
  const shown = (rows) => rows.filter((r) => !(skipped[skipKey(r.item)] >= time(r.at)));
  const open = items.filter(isOpen);
  const prs = new Map(items.filter((item) => item.type === 'pr').map((pr) => [pr.number, pr]));
  const created = (type, what) =>
    open
      .filter((item) => item.type === type && time(item.createdAt) >= start && !teamActed(item) && (includeInternal || !isTeam(item.authorAssociation)) && !involves(item, me, prs))
      .map((item) => row(item, { at: item.createdAt, what }))
      .sort((a, b) => Number(a.open) - Number(b.open) || Number(!!b.action) - Number(!!a.action) || newestFirst(a, b));

  return [
    { id: 'issues', label: 'New issues', rows: shown(created('issue', 'new issue')) },
    { id: 'prs', label: 'New PRs', rows: shown(created('pr', 'new PR')) },
  ];
}

export function withSkip(skipped, item, now) {
  const cutoff = now - SKIP_DAYS * 864e5;
  const kept = Object.entries(skipped).filter(([, at]) => at >= cutoff);
  return { ...Object.fromEntries(kept), [skipKey(item)]: now };
}

export function parseSkipped(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, at]) => typeof at === 'number'));
  } catch {
    return {};
  }
}
