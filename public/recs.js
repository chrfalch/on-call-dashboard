// Agent recommendations in the Inbox: what to ask the server for, and what applying a
// recommendation does. Rec text is untrusted model output, so a plan only ever takes the
// draft from it; command bodies, close reasons and URLs come from ACTIONS and the item.
import { ACTIONS } from './actions.js';

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

// Includes updatedAt: the server makes a new rec when an item changes, so that needs a new request.
export const recSignature = (tasks) =>
  tasks.slice(0, MAX_TASKS).map((t) => `${t.key}@${t.item.updatedAt}`).join(' ');

export const hasPending = (response) => Object.values(response ?? {}).some((entry) => entry?.status === 'pending');

export function recFor(response, task) {
  const entry = response && Object.hasOwn(response, task.key) ? response[task.key] : undefined;
  if (entry?.status === 'done' && entry.recKey !== `${task.key}@${task.item.updatedAt}`) return undefined;
  return entry;
}

export const recAction = (rec, item) =>
  ACTIONS.find((a) => a.id === rec?.action && (a.type === item.type || a.type === 'both'));

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
