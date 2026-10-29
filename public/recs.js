// Agent recommendations in the Inbox: what to ask the server for, and what applying a
// recommendation does. Rec text is untrusted model output, so a plan only ever takes the
// draft from it; command bodies, close reasons and URLs come from ACTIONS and the item.
import { ACTIONS } from './actions.js';

// 32-bit FNV-1a of the UTF-8 bytes. The server stores and queues recs by key, so the key
// must change with the prompt; this only needs to tell prompts apart, not resist forgery.
export function promptHash(text) {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) hash = Math.imul(hash ^ byte, 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

const promptOf = (prompt) => (typeof prompt === 'string' ? prompt.trim() : '');

export function taskKey(row, { prompt } = {}) {
  const text = promptOf(prompt);
  return `${row.item.number}:${row.stateId}${text ? `:custom-${promptHash(text)}` : ''}`;
}

export function recRequest(row, { prompt } = {}) {
  const text = promptOf(prompt);
  const task = { key: taskKey(row, { prompt: text }), state: row.stateId, filters: row.cleanup };
  return { tasks: [text ? { ...task, prompt: text } : task] };
}

// A linked PR merging does not touch the issue's updatedAt, so merged PRs are part of the
// version. Items without them keep the plain updatedAt, so this key alone never invalidates their saved recs.
export function itemVersion(item) {
  const merged = (item.linkedPrs ?? []).filter((pr) => pr.state === 'MERGED').map((pr) => pr.number).sort((a, b) => a - b);
  return merged.length ? `${item.updatedAt}+merged:${merged.join(',')}` : item.updatedAt;
}

// The server keeps one rec per key and makes a new one when the item version changes.
export const recKey = (task, item) => `${task.key}@${itemVersion(item)}`;

export const ITEM_CHANGED = 'No answer for the current item. It changed, or the request was dropped. Ask again.';

export const hasPending = (response) => Object.values(response ?? {}).some((entry) => entry?.status === 'pending');

export function recFor(response, key, item) {
  const entry = response && Object.hasOwn(response, key) ? response[key] : undefined;
  if (entry?.status === 'done' && entry.recKey !== recKey({ key }, item)) return undefined;
  return entry;
}

export const recAction = (rec, item) =>
  ACTIONS.find((a) => a.id === rec?.action && (a.type === item.type || a.type === 'both'));

export function recLabel(rec, item) {
  const action = recAction(rec, item);
  if (!action) return null;
  return action.button ? { button: `${action.button} ${rec.who}`, who: null } : { button: action.label, who: action.who };
}

// Close and comment buttons name one specific step. A command button disagrees only with a
// close or a different command: I1 always offers `@expo-bot triage`, which no rec action posts,
// so a comment, a GitHub step or a wait can come next to it. Other buttons open the item or
// apply a label apart from the rec, so no rec can disagree with them.
const STEP_OF = { close: 'close', comment: 'comment', nudge: 'comment' };

export function recDisagrees(rowAction, rec, item) {
  const action = recAction(rec, item);
  if (!action || !rowAction) return null;
  const plan = applyPlan(rec, item);
  const disagrees =
    rowAction.kind === 'command' ? plan.kind === 'close' || (plan.kind === 'command' && plan.body !== rowAction.body)
    : Object.hasOwn(STEP_OF, rowAction.kind) && plan.kind !== STEP_OF[rowAction.kind];
  return disagrees ? { task: rowAction.label, agent: action.label } : null;
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
