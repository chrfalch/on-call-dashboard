// Workflow states: where each issue or PR stands (`stateOf`) and which cleanup filters it meets.
// Pure functions only (no DOM), so it can be unit-tested with node.
import { ASK_FOR_ISSUE, conversationOf, days, hasLabel, needsBotTriage, needsSeverityFix, PARKED, reReviewReasons } from './inbox.js';
import { isUnsupportedSdk } from './sdk.js';
import { VIEWS } from './views.js';

export const isOpen = (item) => !item.state || item.state === 'OPEN';

export const STATES = [
  { id: 'I1', label: 'New', track: 'issue', oncall: true, icon: 'bot', tone: 'attention' },
  { id: 'I2', label: 'Triaging', track: 'issue', oncall: true, icon: 'bot', tone: 'muted' },
  { id: 'I3', label: 'Needs verification', track: 'issue', oncall: true, icon: 'bot', tone: 'attention' },
  { id: 'I4', label: 'Waiting on reporter', track: 'issue', oncall: true, icon: 'clock', tone: 'muted' },
  { id: 'I5', label: 'Not reproducible', track: 'issue', oncall: true, icon: 'check', tone: 'success' },
  { id: 'I6', label: 'Reproduced', track: 'issue', oncall: true, icon: 'bug', tone: 'danger' },
  { id: 'I7', label: 'Waiting for PR', track: 'issue', oncall: false, icon: 'clock', tone: 'muted' },
  { id: 'I8', label: 'Fix in progress', track: 'issue', oncall: false, icon: 'merge', tone: 'muted' },
  { id: 'I9', label: 'Fix merged', track: 'issue', oncall: true, icon: 'merge', tone: 'success' },
  { id: 'I10', label: 'Closed', track: 'issue', oncall: false, icon: 'check', tone: 'muted' },
  { id: 'P1', label: 'Draft', track: 'pr', oncall: false, icon: 'draft', tone: 'muted' },
  { id: 'P2', label: 'Needs bot review', track: 'pr', oncall: true, icon: 'bot', tone: 'attention' },
  { id: 'P3', label: 'Bot reviewing', track: 'pr', oncall: true, icon: 'bot', tone: 'muted' },
  { id: 'P4', label: 'Changes requested', track: 'pr', oncall: false, icon: 'clock', tone: 'muted' },
  { id: 'P5', label: 'Author answered', track: 'pr', oncall: false, icon: 'reply', tone: 'attention' },
  { id: 'P6', label: 'Ready for human', track: 'pr', oncall: true, icon: 'eye', tone: 'attention' },
  { id: 'P7', label: 'In human review', track: 'pr', oncall: false, icon: 'eye', tone: 'muted' },
  { id: 'P8', label: 'Ready to merge', track: 'pr', oncall: false, icon: 'merge', tone: 'success' },
  { id: 'P9', label: 'Merged', track: 'pr', oncall: false, icon: 'merge', tone: 'muted' },
  { id: 'P10', label: 'Abandoned', track: 'pr', oncall: false, icon: 'x', tone: 'muted' },
];

const ENDED = ['I10', 'P9', 'P10'];
export const STATE_CHIPS = STATES.filter((state) => !ENDED.includes(state.id));

export const CLEANUP_FILTERS = [
  { id: 'C1', label: 'Team owes a reply' },
  { id: 'C2', label: 'Reporter silent 14d' },
  { id: 'C3', label: 'Not reproducible still open 7d' },
  { id: 'C4', label: 'Unsupported SDK' },
  { id: 'C5', label: 'Fell through triage' },
  { id: 'C7', label: 'Stale PR' },
  { id: 'C8', label: 'Owner silent' },
  { id: 'C9', label: 'Approved but cannot land' },
  { id: 'C10', label: 'Stuck waiting for the bot' },
  { id: 'C11', label: 'PR without an issue' },
];

const STATE_BY_ID = Object.fromEntries(STATES.map((state) => [state.id, state]));

const hasFixPr = (item, state) => (item.linkedPrs ?? []).some((pr) => pr.state === state && pr.fix === true);
const unlabeledUnowned = VIEWS.find((view) => view.id === 'issue:unlabeled-unowned');

function issueState(item) {
  if (item.state === 'CLOSED') return 'I10';
  if (hasFixPr(item, 'MERGED')) return 'I9';
  if (hasFixPr(item, 'OPEN')) return 'I8';
  const { assessment, verification } = item.triage ?? {};
  if (verification?.outcome === 'problem' || hasLabel(item, 'Issue accepted')) return item.assignees.length ? 'I7' : 'I6';
  if (verification?.outcome === 'pass') return 'I5';
  if (item.conversation?.waitingOn === 'reporter' || hasLabel(item, 'needs more info')) return 'I4';
  if (assessment && (!verification || verification.outcome === 'blocked')) return 'I3';
  const command = item.bot?.lastCommand?.command;
  if ((command === 'triage' || command === 'verify') && !item.bot.botRepliedAfterCommand) return 'I2';
  if (needsBotTriage(item)) return 'I1';
  return 'I3';
}

// CI status is deliberately absent: a red build is a cleanup signal (C9), not a workflow step.
function prState(item) {
  if (item.state === 'CLOSED') return 'P10';
  if (item.state === 'MERGED') return 'P9';
  if (item.isDraft) return 'P1';
  if (item.reviewDecision === 'APPROVED') return 'P8';
  if (reReviewReasons(item).length) return 'P5';
  if (item.reviewDecision === 'CHANGES_REQUESTED') return 'P4';
  if (item.bot?.lastReview && !item.bot.botRepliedAfterReview) return 'P3';
  if (!item.bot?.lastReview) return 'P2';
  if ((item.reviewRequests ?? []).length || (item.latestReviews ?? []).length) return 'P7';
  return 'P6';
}

export const stateOf = (item) => (item.type === 'pr' ? prState(item) : issueState(item));

const openAction = { kind: 'open', label: 'Open' };

export function stateAction(item, stateId, { now = Date.now() } = {}) {
  if (ENDED.includes(stateId)) return null;
  if (stateId === 'I1') return { kind: 'command', label: 'Ask bot to triage', body: '@expo-bot triage' };
  if (stateId === 'I3') return { kind: 'command', label: 'Ask bot to verify', body: '@expo-bot verify' };
  if (stateId === 'I5' || stateId === 'I9') return { kind: 'close', label: 'Close…' };
  if (stateId === 'I6' && needsSeverityFix(item)) {
    return { kind: 'apply-severity', label: `Apply ${item.triage.assessment.severity.label}` };
  }
  if (stateId === 'I8') {
    const pr = (item.linkedPrs ?? []).find((linked) => linked.state === 'OPEN' && linked.fix === true);
    const url = pr && (pr.url ?? item.url?.replace(/\/issues\/\d+$/, `/pull/${pr.number}`));
    return pr ? { kind: 'open', label: 'Open fix PR', url } : openAction;
  }
  if (stateId === 'P2') return { kind: 'command', label: 'Ask bot to review', body: '@expo-bot review' };
  if (stateId === 'P4' && item.changesRequestedAt && days(item.changesRequestedAt, now) >= 7) {
    return { kind: 'nudge', label: 'Nudge author' };
  }
  return openAction;
}

const atLeast = (iso, d, now) => !!iso && days(iso, now) >= d;
const unanswered = (asked, replied, now) => !!asked && !replied && atLeast(asked.at, 1, now);

const CLEANUP = {
  C1: (item, { now }) => {
    const conv = conversationOf(item);
    return item.type === 'issue' && conv.waitingOn === 'team' && atLeast(conv.since, 7, now);
  },
  C2: (item, { now }) => {
    const conv = conversationOf(item);
    const parked = PARKED.some((l) => hasLabel(item, l));
    return item.type === 'issue' && conv.waitingOn === 'reporter' && atLeast(conv.since, 14, now) && !hasFixPr(item, 'OPEN') && !parked;
  },
  C3: (item, { now }) => item.triage?.verification?.outcome === 'pass' && atLeast(item.triage.verification.at, 7, now),
  C4: (item, { unsupportedSdks }) => isUnsupportedSdk(item, unsupportedSdks),
  C5: (item, ctx) => item.type === unlabeledUnowned.scope && unlabeledUnowned.match(item, ctx),
  C7: (item, { now }) => stateOf(item) === 'P4' && atLeast(item.changesRequestedAt, 21, now),
  C8: (item, { now }) => stateOf(item) === 'I7' && !(item.linkedPrs ?? []).length && atLeast(item.ownerLastActivityAt, 7, now),
  C9: (item) =>
    item.reviewDecision === 'APPROVED' &&
    (item.mergeable === 'CONFLICTING' || item.checks === 'FAILURE' || ['BLOCKED', 'BEHIND'].includes(item.mergeStateStatus)),
  C10: ({ bot }, { now }) =>
    !!bot && (unanswered(bot.lastCommand, bot.botRepliedAfterCommand, now) || unanswered(bot.lastReview, bot.botRepliedAfterReview, now)),
  C11: (item) =>
    item.type === 'pr' && item.state === 'OPEN' && !item.isDraft &&
    Array.isArray(item.linkedIssues) && item.linkedIssues.length === 0 &&
    conversationOf(item).waitingOn !== 'internal' && !hasLabel(item, 'contributor: internal'),
};

// Ids in ascending order. C6 has no rule yet, so it never matches.
export const cleanupFilters = (item, ctx) => Object.keys(CLEANUP).filter((id) => CLEANUP[id](item, ctx));

export function cleanupAction(item, id) {
  if (id === 'C1') return { kind: 'open', label: 'Reply' };
  if (['C2', 'C3', 'C4', 'C7'].includes(id)) return { kind: 'close', label: 'Close…' };
  if (id === 'C11') return { kind: 'comment', label: 'Ask for an issue', body: ASK_FOR_ISSUE };
  if (id !== 'C10') return openAction;
  const { bot = {} } = item;
  const command = !bot.botRepliedAfterCommand && bot.lastCommand;
  const review = !bot.botRepliedAfterReview && bot.lastReview;
  const latest = !command || (review?.at ?? '') > (command.at ?? '') ? review : command;
  const body = latest === review ? '@expo-bot review' : `@expo-bot ${latest?.command}`;
  return latest ? { kind: 'command', label: 'Ask bot again', body } : openAction;
}

const assigned = (item) => (item.assignees ?? []).length > 0;
const mine = (item, me) =>
  !!me && ((item.assignees ?? []).some((person) => person.login === me) || (item.reviewRequests ?? []).some((person) => person.login === me));
export const rowKey = (item, stateId) => `${item.type}#${item.number}:${stateId}`;

function rowData(item, ctx) {
  const stateId = stateOf(item);
  return { item, stateId, cleanup: cleanupFilters(item, ctx), key: rowKey(item, stateId) };
}

function inMode(row, { me, mode, includeAssigned, cleanupChip = false }) {
  if (mode === 'mine') return mine(row.item, me);
  // Closed items show only under their own chip, and cleanup chips exist to catch owned work, so both keep assigned items.
  if (!isOpen(row.item) || cleanupChip) return true;
  if (!includeAssigned && assigned(row.item)) return false;
  return row.cleanup.length > 0 || !!STATE_BY_ID[row.stateId]?.oncall;
}

const visible = (row, hidden) => !hidden?.(row.key);
const shownSdk = (row, hideUnsupported) => !hideUnsupported || !row.cleanup.includes('C4');

export function inboxRows(
  items,
  {
    now = Date.now(),
    me = null,
    mode = 'oncall',
    includeAssigned = false,
    unsupportedSdks = new Set(),
    hideUnsupported = false,
    stateId = null,
    cleanupId = null,
    hidden,
  } = {},
) {
  const ctx = { now, unsupportedSdks };
  return items
    .map((item) => rowData(item, ctx))
    .filter((row) => inMode(row, { me, mode, includeAssigned, cleanupChip: !!cleanupId }))
    .filter((row) => (stateId ? row.stateId === stateId : isOpen(row.item)))
    .filter((row) => (!cleanupId || row.cleanup.includes(cleanupId)) && (cleanupId === 'C4' || shownSdk(row, hideUnsupported)))
    .filter((row) => visible(row, hidden))
    .sort(
      (a, b) =>
        STATES.findIndex((state) => state.id === a.stateId) - STATES.findIndex((state) => state.id === b.stateId) ||
        new Date(a.item.createdAt).getTime() - new Date(b.item.createdAt).getTime(),
    );
}

export function inboxCounts(
  items,
  { now = Date.now(), me = null, mode = 'oncall', includeAssigned = false, unsupportedSdks = new Set(), hideUnsupported = false, hidden } = {},
) {
  const ctx = { now, unsupportedSdks };
  const all = items.map((item) => rowData(item, ctx)).filter((row) => visible(row, hidden));
  const stateRows = all.filter((row) => inMode(row, { me, mode, includeAssigned }) && shownSdk(row, hideUnsupported));
  const chipRows = all.filter((row) => inMode(row, { me, mode, includeAssigned, cleanupChip: true }));
  const chipShown = chipRows.filter((row) => shownSdk(row, hideUnsupported));
  return {
    states: Object.fromEntries(STATES.map(({ id }) => [id, stateRows.filter((row) => row.stateId === id).length])),
    cleanup: Object.fromEntries(
      CLEANUP_FILTERS.map(({ id }) => [id, (id === 'C4' ? chipRows : chipShown).filter((row) => isOpen(row.item) && row.cleanup.includes(id)).length]),
    ),
  };
}
