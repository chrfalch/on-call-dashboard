// Week trend for the Issues and PRs tiles: cumulative opened and closed counts per day
// of the current on-call week (Monday 00:00 local). Pure functions only (no DOM).

const nextDay = (date) => {
  const next = new Date(date);
  next.setDate(next.getDate() + 1);
  return next;
};

export function weekStart(now) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return start;
}

export function weekTrend(entries, now) {
  const start = weekStart(now);
  const timesInWeek = (key) =>
    entries
      .filter((e) => e[key])
      .map((e) => new Date(e[key]))
      .filter((t) => t >= start && t <= now);
  const openedAt = timesInWeek('createdAt');
  const closedAt = timesInWeek('closedAt');
  const countBefore = (times, end) => times.filter((t) => t < end).length;

  const days = [];
  for (let date = start; date <= now; date = nextDay(date)) {
    const end = nextDay(date);
    days.push({ date, opened: countBefore(openedAt, end), closed: countBefore(closedAt, end) });
  }

  const { opened, closed } = days.at(-1);
  const net = opened - closed;
  const direction = net > 0 ? 'up' : net < 0 ? 'down' : 'flat';
  return { start, days, opened, closed, net, direction };
}
