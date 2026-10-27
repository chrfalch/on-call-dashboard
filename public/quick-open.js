export function parseItemNumber(text) {
  const match = /^#?(\d+)$/.exec(text.trim());
  const n = match ? Number(match[1]) : 0;
  return n > 0 ? n : null;
}

export const findItem = (items, n) => items.find((i) => i.number === n) ?? null;

// Starts from the defaults so no view or filter can hide the item; drafts and unsupported SDKs are shown for the same reason.
// The Inbox mode and scope stay, so the Inbox tab looks the same on the way back.
export const quickOpenFilters = (filters, defaults, item) => ({
  ...defaults,
  tab: item.type,
  sort: filters.sort,
  inboxMode: filters.inboxMode,
  inboxScope: filters.inboxScope,
  hideDrafts: false,
  hideUnsupportedSdks: false,
  q: '#' + item.number,
});
