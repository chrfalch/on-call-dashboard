export const PANEL_DEFAULTS = {
  q: '',
  minSeverity: 0,
  includeUnrated: false,
  include: [],
  exclude: [],
  hideDrafts: false,
  checks: '',
  review: '',
  mergeable: '',
  linked: '',
  bot: '',
  assignee: '',
  waiting: '',
  idleDays: 0,
  verdict: '',
  staleDays: 0,
  newerThanDays: 0,
  user: '',
  userRole: 'either',
};
export const PANEL_KEYS = Object.keys(PANEL_DEFAULTS);

export const USER_ROLES = ['either', 'author', 'assignee'];
export const normalizeUserRole = (role) => (USER_ROLES.includes(role) ? role : 'either');
const userLogin = (user) => user.trim().replace(/^@/, '');

// For values read from the URL hash.
export function normalizeFilters(f) {
  const broken = PANEL_KEYS.filter((k) => typeof PANEL_DEFAULTS[k] === 'number' && !Number.isFinite(f[k]));
  return { ...f, ...Object.fromEntries(broken.map((k) => [k, PANEL_DEFAULTS[k]])), userRole: normalizeUserRole(f.userRole) };
}

const SEVERITIES = ['', 'trivial', 'low', 'medium', 'high', 'critical'];
const ROLE_TEXT = { either: 'author or assignee', author: 'author', assignee: 'assignee' };
const VALUE_TEXT = {
  checks: { label: 'Checks', SUCCESS: 'Checks passing', FAILURE: 'Checks failing', PENDING: 'Checks pending' },
  review: { label: 'Review', REVIEW_REQUIRED: 'Review required', APPROVED: 'Approved', CHANGES_REQUESTED: 'Changes requested' },
  mergeable: { label: 'Mergeable', MERGEABLE: 'No conflicts', CONFLICTING: 'Has conflicts' },
  linked: { label: 'Linked issue', none: 'No linked issue', some: 'Has linked issue' },
  waiting: { label: 'Waiting on', team: 'Waiting on team', never: 'Team never replied', owe: 'We owe a reply', reporter: 'Waiting on reporter', internal: 'Opened by team' },
  verdict: {
    label: 'Bot verdict',
    problem: 'Bot verdict: reproduced',
    blocked: 'Bot verdict: blocked',
    pass: 'Bot verdict: passed',
    unverified: 'Not verified yet',
    mismatch: 'Bot severity ≠ label',
    fixpr: 'Bot opened a fix PR',
  },
  bot: { label: '@expo-bot', never: '@expo-bot: never requested', requested: '@expo-bot: requested', pending: '@expo-bot: no reply yet' },
};
const valueText = (key, value) => VALUE_TEXT[key][value] ?? `${VALUE_TEXT[key].label}: ${value}`;

function assigneeText(assignee) {
  if (assignee === 'none') return 'Unassigned';
  if (assignee === 'any') return 'Assigned';
  return assignee === 'user:@me' ? 'Assigned to me' : `Assigned to ${assignee.replace(/^user:/, '')}`;
}

const labelChips = (f, key) =>
  f[key].map((name) => ({ key, id: `${key}:${name}`, text: name, label: { name, excluded: key === 'exclude' }, reset: { [key]: f[key].filter((l) => l !== name) } }));

// One chip per filter that changes the result, so a closed panel never hides one. includeUnrated and userRole
// only qualify another key, so they share its chip. `reset` is what removing the chip merges into the filters.
export function activeFilterChips(f) {
  const chip = (key, text, reset = { [key]: PANEL_DEFAULTS[key] }) => ({ key, id: key, text, reset });
  const q = f.q.trim();
  const user = userLogin(f.user);
  const severity =
    f.minSeverity === -1 ? 'No severity label'
    : f.minSeverity > 0 ? `Severity ≥ ${SEVERITIES[f.minSeverity] ?? f.minSeverity}${f.includeUnrated ? ', incl. unrated' : ''}`
    : '';
  return [
    q && chip('q', `Search: ${q}`),
    severity && chip('minSeverity', severity, { minSeverity: 0, includeUnrated: false }),
    ...labelChips(f, 'include'),
    ...labelChips(f, 'exclude'),
    f.hideDrafts && chip('hideDrafts', 'Drafts hidden'),
    ...['checks', 'review', 'mergeable', 'linked', 'waiting'].map((key) => f[key] && chip(key, valueText(key, f[key]))),
    f.idleDays && chip('idleDays', `Idle ≥ ${f.idleDays} days`),
    ...['verdict', 'bot'].map((key) => f[key] && chip(key, valueText(key, f[key]))),
    f.assignee && chip('assignee', assigneeText(f.assignee)),
    user && chip('user', `User: ${user} (${ROLE_TEXT[normalizeUserRole(f.userRole)]})`, { user: '', userRole: 'either' }),
    f.newerThanDays && chip('newerThanDays', `Created in last ${f.newerThanDays}d`),
    f.staleDays && chip('staleDays', `No activity for ${f.staleDays}d+`),
  ].filter(Boolean);
}

export const activeFilterCount = (f) => new Set(activeFilterChips(f).map((chip) => chip.key)).size;

export function severityMismatch(item) {
  const s = item.triage?.assessment?.severity;
  return !!s && !item.labels.some((l) => l.name === s.label);
}

export function matchesQuery(item, query) {
  if (!query) return true;
  const q = query.toLowerCase().trim();
  const hay = `${item.title} ${item.author.login}`.toLowerCase();
  return String(item.number) === q.replace(/^#/, '') || q.split(/\s+/).every((w) => hay.includes(w));
}

function matchesUser(item, user, role) {
  const login = userLogin(user).toLowerCase();
  if (!login) return true;
  const is = (person) => person?.login.toLowerCase() === login;
  return (role !== 'assignee' && is(item.author)) || (role !== 'author' && item.assignees.some(is));
}

// PR-only filters never drop an issue. `me` is the viewer's login, for `assignee: 'user:@me'`.
export function matchesFilters(item, f, { now = Date.now(), me = null, ignoreLabels = false } = {}) {
  if (f.minSeverity === -1) {
    if (item.severity !== 0) return false;
  } else if (f.minSeverity > 0) {
    if (item.severity < f.minSeverity && !(f.includeUnrated && item.severity === 0)) return false;
  }
  if (f.newerThanDays && now - new Date(item.createdAt) > f.newerThanDays * 864e5) return false;
  if (f.staleDays && now - new Date(item.updatedAt) < f.staleDays * 864e5) return false;
  if (!matchesQuery(item, f.q)) return false;
  if (!ignoreLabels) {
    const names = new Set(item.labels.map((l) => l.name));
    if (!f.include.every((l) => names.has(l))) return false;
    if (f.exclude.some((l) => names.has(l))) return false;
  }
  if (item.type === 'pr') {
    if (f.hideDrafts && item.isDraft) return false;
    if (f.checks && item.checks !== f.checks) return false;
    if (f.review && item.reviewDecision !== f.review) return false;
    if (f.mergeable && item.mergeable !== f.mergeable) return false;
    // linkedIssues is undefined until the server has re-synced with the new field.
    if (f.linked && item.linkedIssues) {
      if (f.linked === 'none' && item.linkedIssues.length) return false;
      if (f.linked === 'some' && !item.linkedIssues.length) return false;
    }
  }
  if (f.bot) {
    const c = item.bot.lastCommand;
    if (f.bot === 'never' && c) return false;
    if (f.bot === 'requested' && !c) return false;
    if (f.bot === 'pending' && (!c || item.bot.botRepliedAfterCommand)) return false;
  }
  const conv = item.conversation;
  if (f.waiting && conv) {
    const ok =
      f.waiting === 'never' ? conv.waitingOn === 'team' && !conv.teamReplied
      : f.waiting === 'owe' ? conv.waitingOn === 'team' && conv.teamReplied
      : conv.waitingOn === f.waiting;
    if (!ok) return false;
  }
  if (f.idleDays && conv && now - new Date(conv.since) < f.idleDays * 864e5) return false;
  if (f.verdict) {
    const t = item.triage;
    if (f.verdict === 'unverified' ? t?.verification : f.verdict === 'mismatch' ? !severityMismatch(item) : f.verdict === 'fixpr' ? !t?.fixPrs.length : t?.verification?.outcome !== f.verdict)
      return false;
  }
  if (f.assignee === 'none' && item.assignees.length) return false;
  if (f.assignee === 'any' && !item.assignees.length) return false;
  if (f.assignee.startsWith('user:')) {
    const login = (f.assignee.slice(5) === '@me' ? me : f.assignee.slice(5))?.toLowerCase();
    if (!item.assignees.some((a) => a.login.toLowerCase() === login)) return false;
  }
  return matchesUser(item, f.user, f.userRole);
}
