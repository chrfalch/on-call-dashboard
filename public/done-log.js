// Items handled per local day for the Inbox done-today tile. Pure functions only (no DOM).

export function localDay(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function dayKey(date) {
  return `inboxDoneLog:${localDay(date)}`;
}

export function parseLog(raw) {
  try {
    const log = JSON.parse(raw);
    return Array.isArray(log) ? log : [];
  } catch {
    return [];
  }
}

export function addDone(log, items) {
  const result = [...log];
  const seen = new Set(log.map((item) => item.number));
  for (const { number, type } of items) {
    if (seen.has(number)) continue;
    seen.add(number);
    result.push({ number, type });
  }
  return result;
}

export function doneCounts(log) {
  const items = addDone([], log);
  return {
    total: items.length,
    issues: items.filter((item) => item.type === 'issue').length,
    prs: items.filter((item) => item.type === 'pr').length,
  };
}
