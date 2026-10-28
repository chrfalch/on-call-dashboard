export function parseItemNumber(text) {
  const match = /^#?(\d+)$/.exec(text.trim());
  const n = match ? Number(match[1]) : 0;
  return n > 0 ? n : null;
}

export const findItem = (items, n) => items.find((i) => i.number === n) ?? null;
