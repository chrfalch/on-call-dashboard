// Triage inbox: turns open issues/PRs into a ranked list of concrete tasks.
// Pure functions only (no DOM), so it can be unit-tested with node.

// `oncall`: part of the on-call rotation's job (triage and routing of unowned
// work) rather than an owner's job (reviewing, merging, fixing).
export const TASK_KINDS = {
  'assign-repro': { label: 'Assign reproduced bug', icon: 'bug', tone: 'danger', action: 'open', oncall: true },
  merge: { label: 'Merge', icon: 'merge', tone: 'success', action: 'open', oncall: false },
  reply: { label: 'Reply', icon: 'reply', tone: 'attention', action: 'open', oncall: true },
  'first-response': { label: 'First response', icon: 'alert', tone: 'danger', action: 'open', oncall: true },
  verify: { label: 'Verify new issue', icon: 'bot', tone: 'attention', action: 'command', oncall: true },
  review: { label: 'Review PR', icon: 'eye', tone: 'attention', action: 'open', oncall: false },
  'bot-review': { label: 'Request bot review', icon: 'bot', tone: 'attention', action: 'command', oncall: true },
  'fix-severity': { label: 'Fix severity', icon: 'tag', tone: 'attention', action: 'apply-severity', oncall: true },
  nudge: { label: 'Nudge author', icon: 'clock', tone: 'muted', action: 'open', oncall: false },
  poke: { label: 'Poke assignee', icon: 'bell', tone: 'attention', action: 'poke', oncall: true },
  close: { label: 'Close stale', icon: 'trash', tone: 'muted', action: 'close', oncall: true },
};

export const MODES = {
  oncall: 'On-call: triage unowned work, and poke owners when someone has waited too long',
  mine: 'My work: items assigned to you and PRs requesting your review',
};

const SEVERITY_BONUS = { 5: 40, 4: 25, 3: 10, 2: 0, 1: -5 };
const DAY = 864e5;
const days = (iso, now) => Math.max(0, Math.floor((now - new Date(iso).getTime()) / DAY));
const hasLabel = (item, name) => item.labels.some((l) => l.name === name);
const PARKED = ['Issue accepted', '✋ on hold'];
const POKE_AFTER_DAYS = { default: 7, urgent: 2 }; // urgent = severity high/critical
const REPOKE_AFTER_DAYS = 7;

// Assigned, but the reporter/author has been waiting on the team too long.
function pokeCandidate(item, conv, waited, now) {
  if (!item.assignees.length || conv.waitingOn !== 'team') return null;
  const threshold = item.severity >= 4 ? POKE_AFTER_DAYS.urgent : POKE_AFTER_DAYS.default;
  if (waited < threshold) return null;
  const poke = conv.lastPoke;
  if (poke && days(poke.at, now) < REPOKE_AFTER_DAYS) return null;
  const who = item.assignees.map((a) => a.login).join(', ');
  const reasons = [`${conv.teamReplied ? 'waiting' : 'no team reply'} ${waited}d`, `assigned to ${who}`];
  if (poke) reasons.push(`poked ${days(poke.at, now)}d ago`);
  // Recent waits are actionable; ancient ones are backlog. Each unanswered
  // poke makes the next one more urgent.
  const base = (waited <= 30 ? 50 : waited <= 90 ? 40 : 30) + (poke ? 8 : 0);
  return { kind: 'poke', base, reasons };
}

// Candidate tasks for one item: [{ kind, base, reasons: [] }]. The best one wins.
function candidates(item, now) {
  const out = [];
  const conv = item.conversation ?? { waitingOn: 'team', teamReplied: false, since: item.createdAt };
  const waited = days(conv.since, now);
  const age = days(item.createdAt, now);
  const verdict = item.triage?.verification?.outcome;
  const botCmd = item.bot?.lastCommand;
  const botPending = !!botCmd && !item.bot.botRepliedAfterCommand;
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
    const poke = pokeCandidate(item, conv, waited, now);
    if (poke && !internal) out.push(poke);
    const parked = PARKED.some((l) => hasLabel(item, l));
    if (!parked && conv.waitingOn === 'reporter' && waited >= 14) out.push({ kind: 'close', base: 20, reasons: [`reporter silent ${waited}d`] });
    else if (!parked && verdict === 'pass' && waited >= 7) out.push({ kind: 'close', base: 20, reasons: ['bot could not reproduce'] });
  } else {
    if (item.isDraft) return out;
    const poke = pokeCandidate(item, conv, waited, now);
    if (poke) out.push(poke);
    const green = item.checks === 'SUCCESS';
    const clean = item.mergeable === 'MERGEABLE';
    if (green && clean && item.reviewDecision === 'APPROVED') out.push({ kind: 'merge', base: 70 });
    if (green && clean && item.reviewDecision === 'REVIEW_REQUIRED' && conv.waitingOn !== 'reporter') {
      if (!botCmd) out.push({ kind: 'bot-review', base: 50 });
      else if (!botPending) out.push({ kind: 'review', base: 55, reasons: ['bot review done'] });
    }
    if (item.reviewDecision === 'APPROVED' && (item.mergeable === 'CONFLICTING' || item.checks === 'FAILURE'))
      out.push({ kind: 'nudge', base: 25, reasons: [item.mergeable === 'CONFLICTING' ? 'approved but conflicting' : 'approved but checks failing'] });
    if (conv.waitingOn === 'reporter' && days(item.updatedAt, now) >= 60) out.push({ kind: 'close', base: 15, reasons: [`no activity ${days(item.updatedAt, now)}d`] });
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
  return { bonus, reasons, mine: assignedToMe || reviewRequested, assigned: item.assignees.length > 0 };
}

// mode 'oncall': only on-call task kinds; `includeAssigned` keeps items that
//   already have an owner (otherwise they're left to that owner).
// mode 'mine': every task kind, but only for items assigned to / awaiting `me`.
export function computeTasks(items, { me = null, now = Date.now(), mode = 'oncall', includeAssigned = false } = {}) {
  const tasks = [];
  for (const item of items) {
    const mod = modifiers(item, now, me, mode);
    if (mode === 'mine' && !mod.mine) continue;
    let cands = candidates(item, now);
    if (mode === 'oncall') {
      cands = cands.filter((c) => TASK_KINDS[c.kind].oncall);
      // Owned items: on-call doesn't do the owner's work, it pokes the owner
      // (unless explicitly asked to include assigned items).
      if (mod.assigned && !includeAssigned) cands = cands.filter((c) => c.kind === 'poke');
      if (mod.assigned && cands.some((c) => c.kind === 'poke')) cands = cands.filter((c) => !['reply', 'first-response'].includes(c.kind));
    } else {
      cands = cands.filter((c) => c.kind !== 'poke'); // you don't poke yourself
    }
    if (!cands.length) continue;
    const ranked = cands.sort((a, b) => b.base - a.base);
    const best = ranked[0];
    tasks.push({
      key: `${item.number}:${best.kind}`,
      kind: best.kind,
      item,
      score: best.base + mod.bonus,
      reasons: [...(best.reasons ?? []).map((text) => ({ text })), ...mod.reasons],
      also: ranked.slice(1).map((c) => c.kind),
      mine: mod.mine,
      assigned: mod.assigned,
    });
  }
  return tasks.sort((a, b) => b.score - a.score || a.item.number - b.item.number);
}

// Done = hidden until the item changes on GitHub; snoozed = hidden until a date.
export function isHidden(task, state, now = Date.now()) {
  const s = state[task.key];
  if (!s) return false;
  if (s.snoozeUntil) return now < s.snoozeUntil;
  if (s.doneAt) return s.updatedAt === task.item.updatedAt;
  return false;
}
