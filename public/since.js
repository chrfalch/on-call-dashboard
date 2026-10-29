// "Since last time": what changed on open issues and PRs since the on-call person last looked.
// Pure functions only (no DOM). Activity never comes from the item's update time: one bulk edit moves it on many items.
import { isBot, isTeam } from './people.js';
import { isOpen, rowKey, stateAction, stateOf } from './states.js';

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

const REVIEW_TEXT = { APPROVED: 'approved', CHANGES_REQUESTED: 'requested changes' };
const commentEvent = (c) => ({ at: c.at, what: `@${c.login} ${c.review ? REVIEW_TEXT[c.review] ?? 'reviewed' : 'replied'}` });

const isMine = (item, me) => !!me && item.assignees.some((person) => person.login === me);
const awaitsMyReview = (item, me) => !!me && (item.reviewRequests ?? []).some((person) => person.login === me);

const BOT_DONE_TEXT = { review: 'expo-bot finished the review', triage: 'expo-bot finished triage', verify: 'expo-bot finished verify' };
const botFinished = (item, me) => {
  const bot = item.bot;
  return !!bot?.botRepliedAfterCommand && bot.lastCommand?.by === me && Object.hasOwn(BOT_DONE_TEXT, bot.lastCommand.command);
};

// The newest comment, review or commit by someone else after my last comment, review or assignment,
// or the bot's answer to my command after my last comment or review: assigning myself does not mean I read it.
function myItemEvent(item, me, start) {
  const comments = item.comments ?? [];
  const myComments = comments.filter((c) => c.login === me).map((c) => time(c.at));
  const lastComment = myComments.length ? Math.max(...myComments) : start;
  const assigned = (item.assignedEvents ?? []).filter((e) => e.login === me).map((e) => time(e.at));
  const touches = [...myComments, ...assigned];
  const lastTouch = touches.length ? Math.max(...touches) : start;
  const byOthers = (login) => login !== me && !isBot(login);
  const events = [
    ...comments.filter((c) => byOthers(c.login)).map(commentEvent),
    ...(item.lastCommitAt && byOthers(item.lastCommitBy) ? [{ at: item.lastCommitAt, what: 'new commit' }] : []),
  ].filter((e) => time(e.at) > lastTouch);
  if (botFinished(item, me) && time(item.bot.lastBotReply.at) > lastComment) {
    events.push({ at: item.bot.lastBotReply.at, what: BOT_DONE_TEXT[item.bot.lastCommand.command] });
  }
  return events.sort(newestFirst)[0] ?? null;
}

const teamActed = (item) => (item.comments ?? []).some((c) => isTeam(c.association) && !isBot(c.login));

// `action` is the state's one-click action; Assign when nobody owns the item, Open when someone else does; Unassign when I am assigned.
export function sinceButtons(item, { me = null, now = Date.now(), stateId = stateOf(item) } = {}) {
  const action = stateAction(item, stateId, { now });
  const assigned = item.assignees.length > 0;
  return {
    action: action?.kind === 'open' ? null : action,
    assign: !!me && !assigned,
    open: assigned && !isMine(item, me),
    unassign: isMine(item, me),
  };
}

export const skipKey = (item) => `${item.type}#${item.number}`;

// Groups "mine", "issues" and "prs", always in that order; a group can be empty.
// `skipped` maps skipKey to the skip time in ms; a row returns when its activity is newer.
export function sinceGroups(items, { now = Date.now(), me = null, skipped = {} } = {}) {
  const start = sinceStart(now).getTime();
  const row = (item, event) => {
    const stateId = stateOf(item);
    return { key: rowKey(item, stateId), item, ...event, ...sinceButtons(item, { me, now, stateId }) };
  };
  const shown = (rows) => rows.filter((r) => !(skipped[skipKey(r.item)] >= time(r.at)));
  const open = items.filter(isOpen);

  const mine = open.flatMap((item) => {
    const event = (isMine(item, me) || awaitsMyReview(item, me)) && myItemEvent(item, me, start);
    return event ? [row(item, event)] : [];
  });
  const inMine = new Set(mine.map((r) => r.item));
  const created = (type, what) =>
    open
      .filter((item) => item.type === type && time(item.createdAt) >= start && !teamActed(item) && !isMine(item, me) && !inMine.has(item))
      .map((item) => row(item, { at: item.createdAt, what }))
      .sort((a, b) => Number(a.open) - Number(b.open) || Number(!!b.action) - Number(!!a.action) || newestFirst(a, b));

  return [
    { id: 'mine', label: 'My items', rows: shown(mine.sort(newestFirst)) },
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
