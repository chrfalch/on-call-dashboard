// Workflow states: where each issue or PR stands (`stateOf`) and which cleanup filters it meets.
// Pure functions only (no DOM), so it can be unit-tested with node.
import { conversationOf, days, hasLabel, needsBotTriage, PARKED, reReviewReasons } from './inbox.js';
import { isUnsupportedSdk } from './sdk.js';
import { VIEWS } from './views.js';

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
};

// Ids in ascending order. C6 has no rule yet, so it never matches.
export const cleanupFilters = (item, ctx) => Object.keys(CLEANUP).filter((id) => CLEANUP[id](item, ctx));
