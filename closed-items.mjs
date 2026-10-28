import { isOpen } from './public/states.js';

export const KEEP_CLOSED_DAYS = 7;

export function dropOldClosed(items, now) {
  const cutoff = now - KEEP_CLOSED_DAYS * 86_400_000;
  return new Map([...items].filter(([, item]) => isOpen(item) || (item.closedAt && Date.parse(item.closedAt) >= cutoff)));
}
