// Triage inbox: turns open issues/PRs into a ranked list of concrete tasks.
// Pure functions only (no DOM), so it can be unit-tested with node.

export const TASK_KINDS = {
  'assign-repro': { label: 'Assign reproduced bug', icon: 'bug', tone: 'danger', action: 'open' },
  merge: { label: 'Merge', icon: 'merge', tone: 'success', action: 'open' },
  reply: { label: 'Reply', icon: 'reply', tone: 'attention', action: 'open' },
  'first-response': { label: 'First response', icon: 'alert', tone: 'danger', action: 'open' },
  verify: { label: 'Verify new issue', icon: 'bot', tone: 'attention', action: 'command' },
  review: { label: 'Review PR', icon: 'eye', tone: 'attention', action: 'open' },
  'bot-review': { label: 'Request bot review', icon: 'bot', tone: 'attention', action: 'command' },
  'fix-severity': { label: 'Fix severity', icon: 'tag', tone: 'attention', action: 'apply-severity' },
  nudge: { label: 'Nudge author', icon: 'clock', tone: 'muted', action: 'open' },
  close: { label: 'Close stale', icon: 'trash', tone: 'muted', action: 'close' },
};

const SEVERITY_BONUS = { 5: 40, 4: 25, 3: 10, 2: 0, 1: -5 };
const DAY = 864e5;
const days = (iso, now) => Math.max(0, Math.floor((now - new Date(iso).getTime()) / DAY));
const hasLabel = (item, name) => item.labels.some((l) => l.name === name);
const PARKED = ['Issue accepted', '✋ on hold'];

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
    const parked = PARKED.some((l) => hasLabel(item, l));
    if (!parked && conv.waitingOn === 'reporter' && waited >= 14) out.push({ kind: 'close', base: 20, reasons: [`reporter silent ${waited}d`] });
    else if (!parked && verdict === 'pass' && waited >= 7) out.push({ kind: 'close', base: 20, reasons: ['bot could not reproduce'] });
  } else {
    if (item.isDraft) return out;
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
function modifiers(item, now, me) {
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
  const mine = !!me && item.assignees.some((a) => a.login === me);
  if (mine) {
    bonus += 30;
    reasons.unshift({ text: 'assigned to you' });
  }
  return { bonus, reasons, mine, othersOnly: item.assignees.length > 0 && !mine };
}

export function computeTasks(items, { me = null, now = Date.now() } = {}) {
  const tasks = [];
  for (const item of items) {
    const cands = candidates(item, now);
    if (!cands.length) continue;
    const mod = modifiers(item, now, me);
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
      assignedToOthers: mod.othersOnly,
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
