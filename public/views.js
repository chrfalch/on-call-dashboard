// Runbook views: a fixed inclusion rule plus a fixed sort per list of work.
// Pure functions only (no DOM), so it can be unit-tested with node.
// An item leaves a view only when its GitHub state changes.

import { days, hasLabel as has, PARKED } from './inbox.js';

export const WAITING_INFO = ['needs more info', '✋ on hold'];

export const GROUPS = {
  issue: [
    { id: 'oncall', title: 'On-call' },
    { id: 'team', title: 'Team' },
  ],
  pr: [
    { id: 'external', title: 'External PRs' },
    { id: 'merge', title: 'Approved' },
    { id: 'internal', title: 'Internal PRs' },
  ],
};

const asc = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
const desc = (x, y) => asc(y, x);
const unowned = (item) => item.assignees.length === 0;
const waitingOn = (item) => item.conversation?.waitingOn;
const silentDays = (item, now) => days(item.conversation.since, now);
const external = (item) => has(item, 'contributor: external');
const reviewed = (item) => (item.latestReviews ?? []).length > 0;
const green = (item) => item.checks === 'SUCCESS' && item.mergeable === 'MERGEABLE';
const blocked = (item) => item.checks === 'FAILURE' || item.mergeable === 'CONFLICTING';
const needsReview = (item) => !item.isDraft && item.reviewDecision === 'REVIEW_REQUIRED';
const approved = (item) => !item.isDraft && item.reviewDecision === 'APPROVED';

const newestFirst = (a, b) => desc(a.createdAt, b.createdAt) || desc(a.number, b.number);
const oldestFirst = (a, b) => asc(a.createdAt, b.createdAt) || asc(a.number, b.number);
const longestSilent = (a, b) => asc(a.conversation.since, b.conversation.since) || asc(a.number, b.number);
const leastRecentlyUpdated = (a, b) => asc(a.updatedAt, b.updatedAt) || asc(a.number, b.number);
const externalFirst = (a, b) => asc(!external(a), !external(b)) || leastRecentlyUpdated(a, b);

// 0: bot review done, 1: no bot command yet, 2: bot review still pending.
const botTier = (item) => (!item.bot?.lastCommand ? 1 : item.bot.botRepliedAfterCommand ? 0 : 2);

export const VIEWS = [
  {
    id: 'issue:triage-queue',
    scope: 'issue',
    group: 'oncall',
    name: 'Triage queue',
    audience: 'on-call',
    step: 'Runbook 3: needs review, unassigned',
    hint: 'Newest first. Leaves when assigned, relabeled, or the team replies.',
    match: (item) => has(item, 'needs review') && unowned(item) && waitingOn(item) === 'team',
    compare: newestFirst,
  },
  {
    id: 'issue:reproduced-unowned',
    scope: 'issue',
    group: 'oncall',
    name: 'Reproduced, nobody owns it',
    audience: 'on-call',
    step: 'Runbook 3: accept and assign an owner',
    hint: 'The bot reproduced it. Label Issue accepted and assign an owner.',
    match: (item) => item.triage?.verification?.outcome === 'problem' && unowned(item),
    compare: (a, b) =>
      desc(a.severity, b.severity) || asc(a.triage.verification.at, b.triage.verification.at) || asc(a.number, b.number),
  },
  {
    id: 'issue:accepted-unowned',
    scope: 'issue',
    group: 'oncall',
    name: 'Accepted, no owner',
    audience: 'on-call',
    step: 'Runbook 3: Issue accepted, unassigned',
    hint: 'Find the Linear task and make sure the lead or module owner has it.',
    match: (item) => has(item, 'Issue accepted') && unowned(item),
    compare: (a, b) => desc(a.severity, b.severity) || oldestFirst(a, b),
  },
  {
    id: 'issue:unlabeled-unowned',
    scope: 'issue',
    group: 'oncall',
    name: 'Fell through triage',
    audience: 'on-call',
    step: 'Runbook 3: correctly labeled',
    hint: 'No triage label and no owner. Label it or assign it.',
    match: (item) =>
      !has(item, 'needs review') &&
      !has(item, 'Issue accepted') &&
      !WAITING_INFO.some((l) => has(item, l)) &&
      unowned(item) &&
      waitingOn(item) !== 'internal',
    compare: newestFirst,
  },
  {
    id: 'issue:awaiting-reporter',
    scope: 'issue',
    group: 'oncall',
    name: 'Reporter silent 14d+',
    audience: 'on-call',
    step: 'Runbook 3: waiting on further input',
    hint: 'Close candidates. Leaves when the reporter replies or the issue is parked.',
    match: (item, { now }) =>
      waitingOn(item) === 'reporter' && silentDays(item, now) >= 14 && !PARKED.some((l) => has(item, l)),
    compare: longestSilent,
  },
  {
    id: 'issue:owner-followup',
    scope: 'issue',
    group: 'team',
    name: 'Assigned, waiting on the owner',
    audience: 'owner',
    step: 'Runbook 3: needs review, assigned',
    hint: 'The owner has not replied for 14 days or more.',
    match: (item, { now }) =>
      has(item, 'needs review') && !unowned(item) && waitingOn(item) === 'team' && silentDays(item, now) >= 14,
    compare: longestSilent,
  },
  {
    id: 'pr:external-first-review',
    scope: 'pr',
    group: 'external',
    name: 'External PRs with no review yet',
    audience: 'on-call',
    step: 'External PRs: first review',
    hint: 'Bot-reviewed first. Request a bot review, run et code-review, or route to a reviewer.',
    match: (item) =>
      needsReview(item) &&
      external(item) &&
      green(item) &&
      !reviewed(item) &&
      (item.reviewRequests ?? []).length === 0 &&
      waitingOn(item) !== 'reporter',
    compare: (a, b) => asc(botTier(a), botTier(b)) || oldestFirst(a, b),
  },
  {
    id: 'pr:external-blocked-unreviewed',
    scope: 'pr',
    group: 'external',
    name: 'External PRs that need a fix before review',
    audience: 'on-call',
    step: 'External PRs: failing or conflicting',
    hint: 'Checks fail or the branch conflicts. One nudge comment to the author.',
    match: (item) => needsReview(item) && external(item) && blocked(item) && !reviewed(item),
    compare: leastRecentlyUpdated,
  },
  {
    id: 'pr:changes-requested-author-replied',
    scope: 'pr',
    group: 'external',
    name: 'Author answered a review',
    audience: 'reviewer',
    step: 'External PRs: changes requested',
    hint: 'The author replied after changes were requested. Review again.',
    match: (item) =>
      !item.isDraft && external(item) && item.reviewDecision === 'CHANGES_REQUESTED' && waitingOn(item) === 'team',
    compare: longestSilent,
  },
  {
    id: 'pr:stale-external',
    scope: 'pr',
    group: 'external',
    name: 'External PR, author silent 60d+',
    audience: 'on-call',
    step: 'External PRs: stale',
    hint: 'Close it or nudge the author.',
    match: (item, { now }) => external(item) && waitingOn(item) === 'reporter' && days(item.updatedAt, now) >= 60,
    compare: leastRecentlyUpdated,
  },
  {
    id: 'pr:ready-to-merge',
    scope: 'pr',
    group: 'merge',
    name: 'Ready to merge',
    audience: 'reviewer',
    step: 'Approved PRs: merge',
    hint: 'Approved, green and mergeable. External first.',
    match: (item) => approved(item) && green(item),
    compare: externalFirst,
  },
  {
    id: 'pr:approved-blocked',
    scope: 'pr',
    group: 'merge',
    name: 'Approved but cannot land',
    audience: 'author',
    step: 'Approved PRs: blocked',
    hint: 'Approved, but checks fail or the branch conflicts. External first.',
    match: (item) => approved(item) && blocked(item),
    compare: externalFirst,
  },
  {
    id: 'pr:internal-review',
    scope: 'pr',
    group: 'internal',
    name: 'Internal PRs that need review',
    audience: 'team',
    step: 'Internal PRs: review',
    hint: 'Oldest first.',
    match: (item) => needsReview(item) && has(item, 'contributor: internal'),
    compare: oldestFirst,
  },
];

const select = (view, items, ctx) => items.filter((item) => item.type === view.scope && view.match(item, ctx));

export function applyView(view, items, { now = Date.now() } = {}) {
  const ctx = { now };
  return select(view, items, ctx).sort((a, b) => view.compare(a, b, ctx));
}

export function viewCounts(items, { now = Date.now() } = {}) {
  return Object.fromEntries(VIEWS.map((view) => [view.id, select(view, items, { now }).length]));
}
