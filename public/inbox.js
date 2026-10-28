// Triage inbox: turns open issues/PRs into a ranked list of concrete tasks.
// Pure functions only (no DOM), so it can be unit-tested with node.
import { isUnsupportedSdk, sdkLabels } from './sdk.js';

// `oncall`: part of the on-call rotation's job (triage and routing of unowned
// work) rather than an owner's job (reviewing, merging, fixing).
export const TASK_KINDS = {
  'assign-repro': { label: 'Verified', icon: 'bug', tone: 'danger', action: 'open', oncall: true },
  merge: { label: 'Merge', icon: 'merge', tone: 'success', action: 'open', oncall: false },
  reply: { label: 'Reply', icon: 'reply', tone: 'attention', action: 'open', oncall: true },
  'first-response': { label: 'First response', icon: 'alert', tone: 'danger', action: 'open', oncall: true },
  verify: { label: 'Verify new issue', icon: 'bot', tone: 'attention', action: 'command', oncall: true },
  review: { label: 'Review PR', icon: 'eye', tone: 'attention', action: 'open', oncall: false },
  're-review': { label: 'Re-review', icon: 'eye', tone: 'attention', action: 'open', oncall: false },
  'bot-review': { label: 'Request bot review', icon: 'bot', tone: 'attention', action: 'command', oncall: true },
  'human-review': { label: 'Ready for human review', icon: 'eye', tone: 'attention', action: 'open', oncall: true },
  'fix-severity': { label: 'Fix severity', icon: 'tag', tone: 'attention', action: 'apply-severity', oncall: true },
  nudge: { label: 'Nudge author', icon: 'clock', tone: 'muted', action: 'open', oncall: false },
  'close-candidate': { label: 'Close candidate', icon: 'merge', tone: 'success', action: 'close', oncall: true },
  close: { label: 'Close stale', icon: 'trash', tone: 'muted', action: 'close', oncall: true },
  'unsupported-sdk': { label: 'Unsupported SDK', icon: 'x', tone: 'muted', action: 'close', oncall: true, chipOnly: true },
  'bot-triage': { label: 'Ask bot to triage', icon: 'bot', tone: 'attention', action: 'command', oncall: true, chipOnly: true },
};

export const MODES = {
  oncall: 'On-call: triage and route work nobody owns yet',
  mine: 'My work: items assigned to you and PRs requesting your review',
};

const SEVERITY_BONUS = { 5: 40, 4: 25, 3: 10, 2: 0, 1: -5 };
const DAY = 864e5;
export const days = (iso, now) => Math.max(0, Math.floor((now - new Date(iso).getTime()) / DAY));
export const hasLabel = (item, name) => item.labels.some((l) => l.name === name);
export const PARKED = ['Issue accepted', '✋ on hold'];
export const PLATFORM_LABEL = /^(Android|iOS|iOS \d+|iPadOS|macOS|tvOS|Platform: web|OS: .*)$/;

function missingRoutingLabels(item) {
  const missing = [];
  if (!item.labels.some((l) => PLATFORM_LABEL.test(l.name))) missing.push('no platform label');
  if (!sdkLabels(item.labels).length) missing.push('no SDK label');
  return missing;
}

// Items opened before expo-bot triaged automatically lack the labels its triage adds.
export function needsBotTriage(item) {
  if (item.type === 'pr' && item.isDraft) return false;
  if (item.triage?.assessment) return false;
  if (item.bot?.lastCommand?.command === 'triage' && !item.bot.botRepliedAfterCommand) return false;
  return missingRoutingLabels(item).length > 0;
}

export const conversationOf = (item) => item.conversation ?? { waitingOn: 'team', teamReplied: false, since: item.createdAt };

// Why a PR with requested changes is ready for another look; empty while the author has not acted.
export function reReviewReasons(item) {
  if (item.reviewDecision !== 'CHANGES_REQUESTED') return [];
  const since = item.changesRequestedAt;
  const lastHuman = conversationOf(item).lastHuman;
  // GitHub drops a reviewer from reviewRequests when they review, so finding them there again means a re-request.
  const reRequested = (item.reviewRequests ?? []).some((r) => item.changesRequestedBy?.includes(r.login));
  return [
    since && lastHuman?.role === 'reporter' && lastHuman.at > since && 'author replied',
    since && item.lastCommitAt > since && 'author pushed',
    reRequested && 'review re-requested',
  ].filter(Boolean);
}

// Candidate tasks for one item: [{ kind, base, reasons: [] }]. The best one wins.
function candidates(item, now) {
  const out = [];
  const conv = conversationOf(item);
  const waited = days(conv.since, now);
  const age = days(item.createdAt, now);
  const verdict = item.triage?.verification?.outcome;
  // A triage command only adds labels; it must not stand in for a verify.
  const botCmd = item.bot?.lastCommand?.command === 'triage' ? null : item.bot?.lastCommand;
  const internal = conv.waitingOn === 'internal';

  if (item.type === 'issue') {
    if (verdict === 'problem' && !item.assignees.length) out.push({ kind: 'assign-repro', base: 80 });
    if (!internal && conv.waitingOn === 'team' && conv.teamReplied) {
      // Conversations that went quiet long ago are backlog, not today's work.
      const base = waited <= 30 ? 60 : waited <= 180 ? 45 : 30;
      out.push({ kind: 'reply', base, reasons: [`waiting ${waited}d`] });
    }
    if (!internal && conv.waitingOn === 'team' && !conv.teamReplied) {
      // Fresh reports matter most; very old unanswered ones are backlog.
      const base = age <= 14 ? 55 : age <= 90 ? 40 : 25;
      out.push({ kind: 'first-response', base, reasons: [`no reply for ${waited}d`] });
    }
    if (!internal && !botCmd && !item.triage?.verification && age <= 30) out.push({ kind: 'verify', base: 58, reasons: [`opened ${age}d ago`] });
    const sev = item.triage?.assessment?.severity;
    if (sev && !hasLabel(item, sev.label)) out.push({ kind: 'fix-severity', base: 40, reasons: [`bot says ${sev.label}`] });
    const parked = PARKED.some((l) => hasLabel(item, l));
    const merged = (item.linkedPrs ?? []).filter((pr) => pr.state === 'MERGED' && pr.fix === true);
    if (!parked && merged.length) {
      out.push({ kind: 'close-candidate', base: 45, reasons: merged.map((pr) => `#${pr.number} merged ${days(pr.mergedAt, now)}d ago into ${pr.baseRefName}`) });
    }
    const fixPending = (item.linkedPrs ?? []).some((pr) => pr.state === 'OPEN' && pr.fix === true);
    const closable = !parked && !fixPending;
    if (closable && conv.waitingOn === 'reporter' && waited >= 14) out.push({ kind: 'close', base: 20, reasons: [`reporter silent ${waited}d`] });
    else if (closable && verdict === 'pass' && waited >= 7) out.push({ kind: 'close', base: 20, reasons: ['bot could not reproduce'] });
  } else {
    if (item.isDraft) return out;
    const green = item.checks === 'SUCCESS';
    const clean = item.mergeable === 'MERGEABLE';
    if (green && clean && item.reviewDecision === 'APPROVED') out.push({ kind: 'merge', base: 70 });
    if (green && clean && item.reviewDecision === 'REVIEW_REQUIRED' && conv.waitingOn !== 'reporter') {
      // Only a review command counts; a later verify or rebase must not hide or fake the review.
      if (!item.bot?.lastReview) out.push({ kind: 'bot-review', base: 50 });
      else if (item.bot.botRepliedAfterReview) {
        out.push({ kind: 'review', base: 55, reasons: ['bot review done'] });
        // A requested reviewer owns the review; on-call only routes the rest.
        if (!(item.reviewRequests ?? []).length) out.push({ kind: 'human-review', base: 54, reasons: ['bot review done', 'no reviewer requested'] });
      }
    }
    if (item.reviewDecision === 'APPROVED' && (item.mergeable === 'CONFLICTING' || item.checks === 'FAILURE')) {
      const reasons = [item.mergeable === 'CONFLICTING' ? 'approved but conflicting' : 'approved but checks failing'];
      // An approved PR left broken this long has no active owner, so on-call picks it up.
      if (waited >= 60) out.push({ kind: 'nudge', base: 25, oncall: true, reasons: [...reasons, `idle ${waited}d`] });
      else out.push({ kind: 'nudge', base: 25, reasons });
    }
    const reReview = reReviewReasons(item);
    if (reReview.length) out.push({ kind: 're-review', base: 56, reasons: reReview, oncall: !item.assignees.length && !(item.reviewRequests ?? []).length });
    if (item.reviewDecision === 'CHANGES_REQUESTED' && conv.waitingOn === 'reporter' && waited >= 60)
      out.push({ kind: 'close', base: 15, reasons: [`no activity ${waited}d`] });
  }
  return out;
}

// Bonuses shared by every task on the item.
function modifiers(item, now, me, mode) {
  let bonus = 0;
  const reasons = [];
  const sevBonus = SEVERITY_BONUS[item.severity] ?? 0;
  if (sevBonus) {
    bonus += sevBonus;
    reasons.push({ label: item.labels.find((l) => l.name.startsWith('severity:'))?.name });
  }
  if (item.triage?.verification?.outcome === 'problem') reasons.push({ text: 'reproduced' });
  const waited = item.conversation ? days(item.conversation.since, now) : 0;
  if (item.conversation?.waitingOn === 'team' && waited) bonus += Math.min(20, Math.round(Math.sqrt(waited) * 3));
  if (item.thumbsUp) {
    bonus += Math.min(15, item.thumbsUp * 2);
    reasons.push({ text: `👍 ${item.thumbsUp}` });
  }
  if (item.type === 'pr' && hasLabel(item, 'contributor: external')) {
    bonus += 5;
    reasons.push({ text: 'external contributor' });
  }
  if (item.type === 'pr' && item.linkedIssues?.length) {
    bonus += 5;
    reasons.push({ text: `fixes #${item.linkedIssues[0].number}` });
  }
  const assignedToMe = !!me && item.assignees.some((a) => a.login === me);
  const reviewRequested = !!me && (item.reviewRequests ?? []).some((r) => r.login === me);
  if (mode === 'mine') {
    if (assignedToMe) reasons.unshift({ text: 'assigned to you' });
    else if (reviewRequested) reasons.unshift({ text: 'your review requested' });
  }
  return { bonus, reasons, mine: assignedToMe || reviewRequested, reviewRequested, assigned: item.assignees.length > 0 };
}

// mode 'oncall': only on-call task kinds; `includeAssigned` keeps items that
//   already have an owner (otherwise they're left to that owner).
// mode 'mine': every task kind, but only for items assigned to / awaiting `me`.
// `unsupported`: SDK labels whose items only need closing, whatever else they would qualify for.
export function computeTasks(items, { me = null, now = Date.now(), mode = 'oncall', includeAssigned = false, unsupported = new Set() } = {}) {
  const tasks = [];
  for (const item of items) {
    const mod = modifiers(item, now, me, mode);
    if (mode === 'mine' && !mod.mine) continue;
    if (mode === 'oncall' && mod.assigned && !includeAssigned) continue;
    const unsupportedSdk = isUnsupportedSdk(item, unsupported);
    // Routing labels help whoever takes the best task, so this sits next to it instead of competing.
    if (!unsupportedSdk && needsBotTriage(item)) {
      tasks.push({
        key: `${item.number}:bot-triage`,
        kind: 'bot-triage',
        item,
        score: 10 + mod.bonus,
        reasons: [...missingRoutingLabels(item).map((text) => ({ text })), ...mod.reasons],
        also: [],
        mine: mod.mine,
        assigned: mod.assigned,
      });
    }
    const all = unsupportedSdk
      ? [{ kind: 'unsupported-sdk', base: 10, reasons: [sdkLabels(item.labels).join(', ')] }]
      : candidates(item, now);
    const cands = all.filter((c) => mode !== 'oncall' || (c.oncall ?? TASK_KINDS[c.kind].oncall));
    if (!cands.length) continue;
    const ranked = cands.sort((a, b) => b.base - a.base);
    const best = ranked[0];
    tasks.push({
      key: `${item.number}:${best.kind}`,
      kind: best.kind,
      item,
      score: best.base + mod.bonus + (best.kind === 're-review' && mod.reviewRequested ? 10 : 0),
      reasons: [...(best.reasons ?? []).map((text) => ({ text })), ...mod.reasons],
      also: ranked.slice(1).map((c) => c.kind),
      mine: mod.mine,
      assigned: mod.assigned,
    });
  }
  return tasks.sort((a, b) => b.score - a.score || a.item.number - b.item.number);
}

// `chipOnly` kinds stay out of the main list and show only when their chip is selected.
export const listedTasks = (tasks, kind) =>
  kind ? tasks.filter((t) => t.kind === kind) : tasks.filter((t) => !TASK_KINDS[t.kind].chipOnly);

// Done = hidden until the item changes on GitHub; snoozed = hidden until a date.
export function isHidden(task, state, now = Date.now()) {
  const s = state[task.key];
  if (!s) return false;
  if (s.snoozeUntil) return now < s.snoozeUntil;
  if (s.doneAt) return s.updatedAt === task.item.updatedAt;
  return false;
}
