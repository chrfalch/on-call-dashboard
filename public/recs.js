// Agent recommendations in the Inbox: what to ask the server for, and what applying a
// recommendation does. Rec text is untrusted model output, so a plan only ever takes the
// draft from it; command bodies, close reasons and URLs come from ACTIONS and the item.
import { ACTIONS } from './actions.js';
import { TASK_KINDS } from './inbox.js';

const MAX_TASKS = 30;

export function recRequest(tasks) {
  return {
    tasks: tasks.slice(0, MAX_TASKS).map(({ key, kind, reasons }) => ({
      key,
      kind,
      reasons: reasons.map((r) => ({ text: r.text ?? r.label })).filter((r) => r.text),
    })),
  };
}

// A linked PR merging does not touch the issue's updatedAt, so merged PRs are part of the
// version. Items without them keep the plain updatedAt, so this key alone never invalidates their saved recs.
export function itemVersion(item) {
  const merged = (item.linkedPrs ?? []).filter((pr) => pr.state === 'MERGED').map((pr) => pr.number).sort((a, b) => a - b);
  return merged.length ? `${item.updatedAt}+merged:${merged.join(',')}` : item.updatedAt;
}

// The server keeps one rec per key and makes a new one when the item version changes.
export const recKey = (task, item) => `${task.key}@${itemVersion(item)}`;

// Includes the item version: a new version means a new rec, so that needs a new request.
export const recSignature = (tasks) => tasks.slice(0, MAX_TASKS).map((t) => recKey(t, t.item)).join(' ');

export const hasPending = (response) => Object.values(response ?? {}).some((entry) => entry?.status === 'pending');

export function recFor(response, task) {
  const entry = response && Object.hasOwn(response, task.key) ? response[task.key] : undefined;
  if (entry?.status === 'done' && entry.recKey !== recKey(task, task.item)) return undefined;
  return entry;
}

export const recAction = (rec, item) =>
  ACTIONS.find((a) => a.id === rec?.action && (a.type === item.type || a.type === 'both'));

export function recLabel(rec, item) {
  const action = recAction(rec, item);
  if (!action) return null;
  return action.button ? { button: `${action.button} ${rec.who}`, who: null } : { button: action.label, who: action.who };
}

const TASK_COMMAND = { verify: 'verify', 'bot-review': 'request-review' };

// Only close and bot-command tasks name one specific action. Tasks that open the item leave
// the next step open, so no rec can disagree with them.
export function recDisagrees(task, rec) {
  const kind = Object.hasOwn(TASK_KINDS, task.kind) ? TASK_KINDS[task.kind] : undefined;
  const action = recAction(rec, task.item);
  if (!kind || !action || (kind.action === 'command' && !TASK_COMMAND[task.kind])) return null;
  const agrees =
    kind.action === 'close' ? action.apply === 'close'
    : kind.action === 'command' ? action.id === TASK_COMMAND[task.kind]
    : true;
  return agrees ? null : { task: kind.label, agent: action.label };
}

export function applyPlan(rec, item) {
  const action = recAction(rec, item);
  const draft = typeof rec?.draft === 'string' ? rec.draft : '';
  switch (action?.apply) {
    case 'command':
      return { kind: 'command', body: action.body };
    case 'comment':
      return { kind: 'comment', body: draft };
    case 'close':
      return { kind: 'close', reason: action.reason, body: draft };
    case 'github':
      return { kind: 'github', url: item.url };
    default:
      return { kind: 'none' };
  }
}
