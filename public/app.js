// Expo triage dashboard client.
const $ = (sel) => document.querySelector(sel);
const PAGE = 100;
const ACTIONS = {
  pr: { command: 'review', body: '@expo-bot review', label: 'Request review', bulk: 'Request review' },
  issue: { command: 'verify', body: '@expo-bot verify', label: 'Verify', bulk: 'Verify' },
};

const DEFAULT_FILTERS = {
  tab: 'issue',
  q: '',
  minSeverity: 0,
  includeUnrated: false,
  sort: 'severity',
  include: [],
  exclude: [],
  hideDrafts: true,
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
  preset: 'all',
};

let data = { items: [], labels: [] };
let filters = readHash();
let shown = PAGE;
let selected = new Set();
let facetQuery = '';
const collapsedGroups = new Set(JSON.parse(localStorage.getItem('collapsedGroups') || '["Package","SDK / RN","Upstream","Project","Other"]'));

// ---------- triage commands ----------
// Each card groups a few one-click filter combinations ("commands"). `f` is
// merged over DEFAULT_FILTERS, so every command starts from a clean slate.

const SEV = (name) => ({ include: [`severity: ${name}`] });
const COMMANDS = {
  issue: [
    {
      title: 'Waiting on',
      icon: 'people',
      hint: 'Who has to act next, based on the last human comment',
      items: [
        { id: 'never', label: 'No team reply yet', icon: 'alert', tone: 'danger', f: { waiting: 'never', sort: 'waiting' } },
        { id: 'owe', label: 'We owe a reply', icon: 'reply', tone: 'attention', f: { waiting: 'owe', sort: 'waiting' } },
        { id: 'reporter', label: 'Reporter', icon: 'clock', tone: 'muted', f: { waiting: 'reporter', sort: 'waiting' } },
      ],
    },
    {
      title: 'Act now',
      icon: 'flame',
      hint: 'High-signal combinations worth handling first',
      items: [
        { id: 'repro-unassigned', label: 'Reproduced, unassigned', icon: 'bug', tone: 'danger', f: { verdict: 'problem', assignee: 'none' } },
        { id: 'high-unanswered', label: 'Severity ≥ high, no reply', icon: 'alert', tone: 'danger', f: { minSeverity: 4, waiting: 'never' } },
        { id: 'medium-owe', label: 'Severity ≥ medium, awaiting us', icon: 'reply', tone: 'attention', f: { minSeverity: 3, waiting: 'team', sort: 'waiting' } },
        { id: 'accepted-unassigned', label: 'Accepted, unassigned', icon: 'person', tone: 'attention', f: { include: ['Issue accepted'], assignee: 'none' } },
      ],
    },
    {
      title: 'New issues',
      icon: 'inbox',
      hint: 'Opened in the last 7 days',
      items: [
        { id: 'new', label: 'All new this week', icon: 'issueOpen', tone: 'open', f: { newerThanDays: 7, sort: 'created' } },
        { id: 'new-unverified', label: 'Not verified yet', icon: 'bot', tone: 'attention', f: { newerThanDays: 7, bot: 'never', sort: 'created' } },
        { id: 'new-unrated', label: 'No severity yet', icon: 'tag', tone: 'attention', f: { newerThanDays: 7, minSeverity: -1, sort: 'created' } },
        { id: 'new-unanswered', label: 'No team reply yet', icon: 'alert', tone: 'danger', f: { newerThanDays: 7, waiting: 'never', sort: 'created' } },
      ],
    },
    {
      title: 'Bot verdicts',
      icon: 'bot',
      hint: 'Results of @expo-bot triage and verification',
      items: [
        { id: 'v-problem', label: 'Reproduced', icon: 'bug', tone: 'danger', f: { verdict: 'problem' } },
        { id: 'v-blocked', label: 'Blocked', icon: 'blocked', tone: 'attention', f: { verdict: 'blocked' } },
        { id: 'v-pass', label: 'Not reproduced', icon: 'checkSmall', tone: 'success', f: { verdict: 'pass' } },
        { id: 'v-fixpr', label: 'Has bot fix PR', icon: 'prSmall', tone: 'done', f: { verdict: 'fixpr' } },
        { id: 'v-mismatch', label: 'Severity ≠ label', icon: 'tag', tone: 'attention', f: { verdict: 'mismatch' } },
      ],
    },
    {
      title: 'Severity',
      icon: 'tag',
      hint: 'Exact severity label',
      items: [
        { id: 's-critical', label: 'critical', label_: 'severity: critical', f: SEV('critical') },
        { id: 's-high', label: 'high', label_: 'severity: high', f: SEV('high') },
        { id: 's-medium', label: 'medium', label_: 'severity: medium', f: SEV('medium') },
        { id: 's-low', label: 'low', label_: 'severity: low', f: SEV('low') },
        { id: 's-trivial', label: 'trivial', label_: 'severity: trivial', f: SEV('trivial') },
        { id: 's-none', label: 'No severity', icon: 'dash', tone: 'muted', f: { minSeverity: -1 } },
      ],
    },
    {
      title: 'Cleanup',
      icon: 'trash',
      hint: 'Candidates for the bulk “Close…” action',
      items: [
        { id: 'stale-reporter', label: 'Reporter silent 14d+', icon: 'clock', tone: 'muted', f: { waiting: 'reporter', idleDays: 14, sort: 'waiting', exclude: ['Issue accepted', '✋ on hold'] } },
        { id: 'needs-info-stale', label: 'Needs more info 14d+', icon: 'question', tone: 'muted', f: { include: ['needs more info'], waiting: 'reporter', idleDays: 14 } },
        { id: 'v-pass-open', label: 'Bot couldn’t reproduce', icon: 'checkSmall', tone: 'muted', f: { verdict: 'pass' } },
        { id: 'stale-label', label: 'Labelled stale', icon: 'archive', tone: 'muted', f: { include: ['stale'] } },
      ],
    },
  ],
  pr: [
    {
      title: 'Merge queue',
      icon: 'merge',
      hint: 'Non-draft PRs closest to landing',
      items: [
        { id: 'ready', label: 'Ready to merge', icon: 'checkSmall', tone: 'success', f: { checks: 'SUCCESS', review: 'APPROVED', mergeable: 'MERGEABLE', sort: 'updated' } },
        { id: 'approved-conflicts', label: 'Approved, has conflicts', icon: 'xSmall', tone: 'danger', f: { review: 'APPROVED', mergeable: 'CONFLICTING' } },
        { id: 'approved-failing', label: 'Approved, checks failing', icon: 'xSmall', tone: 'danger', f: { review: 'APPROVED', checks: 'FAILURE' } },
      ],
    },
    {
      title: 'Needs review',
      icon: 'eye',
      hint: 'Green, conflict-free PRs nobody has approved yet',
      items: [
        { id: 'review-external', label: 'External contributors', icon: 'people', tone: 'attention', f: { review: 'REVIEW_REQUIRED', checks: 'SUCCESS', mergeable: 'MERGEABLE', include: ['contributor: external'], sort: 'waiting' } },
        { id: 'review-internal', label: 'Internal', icon: 'person', tone: 'muted', f: { review: 'REVIEW_REQUIRED', checks: 'SUCCESS', mergeable: 'MERGEABLE', include: ['contributor: internal'], sort: 'waiting' } },
        { id: 'no-bot', label: 'No bot review yet', icon: 'bot', tone: 'attention', f: { bot: 'never', checks: 'SUCCESS' } },
        { id: 'bot-pending', label: 'Bot review pending', icon: 'clock', tone: 'muted', f: { bot: 'pending' } },
      ],
    },
    {
      title: 'Waiting on',
      icon: 'people',
      hint: 'Who has to act next, based on the last human comment',
      items: [
        { id: 'never', label: 'No team reply yet', icon: 'alert', tone: 'danger', f: { waiting: 'never', sort: 'waiting' } },
        { id: 'owe', label: 'We owe a reply', icon: 'reply', tone: 'attention', f: { waiting: 'owe', sort: 'waiting' } },
        { id: 'reporter', label: 'Author', icon: 'clock', tone: 'muted', f: { waiting: 'reporter', sort: 'waiting' } },
      ],
    },
    {
      title: 'Hygiene',
      icon: 'tools',
      hint: 'PRs that need a nudge before they can move',
      items: [
        { id: 'conflicts', label: 'Has conflicts', icon: 'xSmall', tone: 'danger', f: { mergeable: 'CONFLICTING' } },
        { id: 'failing', label: 'Checks failing', icon: 'xSmall', tone: 'danger', f: { checks: 'FAILURE' } },
        { id: 'no-issue', label: 'No linked issue', icon: 'link', tone: 'attention', f: { linked: 'none' } },
        { id: 'stale-pr', label: 'No activity 30d+', icon: 'archive', tone: 'muted', f: { staleDays: 30, sort: 'created-asc' } },
      ],
    },
  ],
};

function findCommand(id) {
  return COMMANDS[filters.tab].flatMap((c) => c.items).find((c) => c.id === id);
}

function applyCommand(cmd) {
  // Clicking the active command again resets to all open items.
  if (filters.preset === cmd.id) {
    filters = { ...DEFAULT_FILTERS, tab: filters.tab };
    shown = PAGE;
    return render();
  }
  filters = { ...DEFAULT_FILTERS, tab: filters.tab, ...cmd.f, preset: cmd.id };
  shown = PAGE;
  render();
}

// ---------- url state ----------

function readHash() {
  const f = { ...DEFAULT_FILTERS };
  const params = new URLSearchParams(location.hash.slice(1));
  for (const [k, v] of params) {
    if (!(k in DEFAULT_FILTERS)) continue;
    const def = DEFAULT_FILTERS[k];
    if (Array.isArray(def)) f[k] = params.getAll(k);
    else if (typeof def === 'number') f[k] = Number(v);
    else if (typeof def === 'boolean') f[k] = v === '1';
    else f[k] = v;
  }
  return f;
}

function writeHash() {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    const def = DEFAULT_FILTERS[k];
    if (Array.isArray(v)) v.forEach((x) => params.append(k, x));
    else if (v !== def) params.set(k, typeof v === 'boolean' ? (v ? '1' : '0') : v);
  }
  history.replaceState(null, '', '#' + params.toString());
}

// ---------- label colors (GitHub's algorithm) ----------

function hexToRgb(hex) {
  const n = parseInt(hex, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  return [h, s * 100, l * 100];
}
const darkMode = matchMedia('(prefers-color-scheme: dark)');
function labelStyle(color) {
  const [r, g, b] = hexToRgb(color || 'ededed');
  const perceived = (r * 0.2126 + g * 0.7152 + b * 0.0722) / 255;
  const [h, s, l] = rgbToHsl(r, g, b);
  if (darkMode.matches) {
    const lightenBy = Math.max(0, (0.6 - perceived) * 100);
    const tl = Math.min(100, l + lightenBy);
    return `background:rgba(${r},${g},${b},0.18);color:hsl(${h},${s}%,${tl}%);border-color:hsla(${h},${s}%,${tl}%,0.3)`;
  }
  const fg = perceived > 0.453 ? '#1f2328' : '#ffffff';
  const border = perceived > 0.96 ? `hsl(${h},${s}%,${Math.max(0, l - 25)}%)` : 'transparent';
  return `background:#${color};color:${fg};border-color:${border}`;
}

function labelHtml(l, opts = {}) {
  const active = filters.include.includes(l.name) ? ' active' : '';
  const excl = filters.exclude.includes(l.name) ? ' excluded' : '';
  return `<a class="IssueLabel${active}${excl}" style="${labelStyle(l.color)}" data-label="${esc(l.name)}" title="${esc(
    l.description || l.name
  )}">${esc(l.name)}${opts.removable ? ' <span class="chip-remove" data-remove="1">×</span>' : ''}</a>`;
}

function assigneeChipHtml(a) {
  const active = filters.assignee === `user:${a.login}` ? ' active' : '';
  return `<a class="AssigneeChip${active}" data-assignee="${esc(a.login)}" title="Assigned to ${esc(a.login)} — click to filter"><img src="${a.avatarUrl}&s=32" alt="" loading="lazy">assigned: ${esc(a.login)}</a>`;
}

// ---------- helpers ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function ago(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [u, n] of units) if (s >= n) { const v = Math.floor(s / n); return `${v} ${u}${v > 1 ? 's' : ''} ago`; }
}
function labelGroup(name) {
  if (name.startsWith('severity:')) return 'Severity';
  if (/^(Android|iOS|iOS \d+|iPadOS|macOS|tvOS|Platform: web|OS: .*)$/.test(name)) return 'Platform';
  if (name.startsWith('📦')) return 'Package';
  if (/^(bot:|ai-)/.test(name)) return 'Bot';
  if (/^(contributor:|partner:)/.test(name)) return 'Contributor';
  if (/^(sdk-\d+|React Native \d)/.test(name)) return 'SDK / RN';
  if (name.startsWith('Upstream:')) return 'Upstream';
  if (name.startsWith('project:')) return 'Project';
  if (
    /^(Needs triage|needs review|needs validation|needs more info|Issue accepted|investigating|incomplete issue|invalid issue|pending closure|⭐️|known issue|ready for human review|in progress|✋ on hold|don't merge|stale|status:|intended behavior|won't fix|duplicate|outdated|Launch-blocking|must be fixed)/.test(
      name
    )
  )
    return 'Status';
  if (/^(bug|enhancement|docs|security|accessibility|rfc|🧹 chore|dependencies|breaking:|Version bump PR|good|help wanted)/.test(name)) return 'Type';
  return 'Other';
}
const GROUP_ORDER = ['Severity', 'Status', 'Type', 'Platform', 'Bot', 'Contributor', 'Package', 'SDK / RN', 'Upstream', 'Project', 'Other'];

const icons = {
  // From @primer/octicons.
  people: `<svg version="1.1" width="16" height="16" viewBox="0 0 16 16" class="octicon octicon-people octicon" data-component="Octicon"><path d="M2 5.5a3.5 3.5 0 1 1 5.898 2.549 5.508 5.508 0 0 1 3.034 4.084.75.75 0 1 1-1.482.235 4 4 0 0 0-7.9 0 .75.75 0 0 1-1.482-.236A5.507 5.507 0 0 1 3.102 8.05 3.493 3.493 0 0 1 2 5.5ZM11 4a3.001 3.001 0 0 1 2.22 5.018 5.01 5.01 0 0 1 2.56 3.012.749.749 0 0 1-.885.954.752.752 0 0 1-.549-.514 3.507 3.507 0 0 0-2.522-2.372.75.75 0 0 1-.574-.73v-.352a.75.75 0 0 1 .416-.672A1.5 1.5 0 0 0 11 5.5.75.75 0 0 1 11 4Zm-5.5-.5a2 2 0 1 0-.001 3.999A2 2 0 0 0 5.5 3.5Z"></path></svg>`,
  flame: `<svg version="1.1" width="16" height="16" viewBox="0 0 16 16" class="octicon octicon-flame octicon" data-component="Octicon"><path d="M9.533.753V.752c.217 2.385 1.463 3.626 2.653 4.81C13.37 6.74 14.498 7.863 14.498 10c0 3.5-3 6-6.5 6S1.5 13.512 1.5 10c0-1.298.536-2.56 1.425-3.286.376-.308.862 0 1.035.454C4.46 8.487 5.581 8.419 6 8c.282-.282.341-.811-.003-1.5C4.34 3.187 7.035.75 8.77.146c.39-.137.726.194.763.607ZM7.998 14.5c2.832 0 5-1.98 5-4.5 0-1.463-.68-2.19-1.879-3.383l-.036-.037c-1.013-1.008-2.3-2.29-2.834-4.434-.322.256-.63.579-.864.953-.432.696-.621 1.58-.046 2.73.473.947.67 2.284-.278 3.232-.61.61-1.545.84-2.403.633a2.79 2.79 0 0 1-1.436-.874A3.198 3.198 0 0 0 3 10c0 2.53 2.164 4.5 4.998 4.5Z"></path></svg>`,
  inbox: `<svg version="1.1" width="16" height="16" viewBox="0 0 16 16" class="octicon octicon-inbox octicon" data-component="Octicon"><path d="M2.8 2.06A1.75 1.75 0 0 1 4.41 1h7.18c.7 0 1.333.417 1.61 1.06l2.74 6.395c.04.093.06.194.06.295v4.5A1.75 1.75 0 0 1 14.25 15H1.75A1.75 1.75 0 0 1 0 13.25v-4.5c0-.101.02-.202.06-.295Zm1.61.44a.25.25 0 0 0-.23.152L1.887 8H4.75a.75.75 0 0 1 .6.3L6.625 10h2.75l1.275-1.7a.75.75 0 0 1 .6-.3h2.863L11.82 2.652a.25.25 0 0 0-.23-.152Zm10.09 7h-2.875l-1.275 1.7a.75.75 0 0 1-.6.3h-3.5a.75.75 0 0 1-.6-.3L4.375 9.5H1.5v3.75c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25Z"></path></svg>`,
  bug: `<svg version="1.1" width="16" height="16" viewBox="0 0 16 16" class="octicon octicon-bug octicon" data-component="Octicon"><path d="M4.72.22a.75.75 0 0 1 1.06 0l1 .999a3.488 3.488 0 0 1 2.441 0l.999-1a.748.748 0 0 1 1.265.332.75.75 0 0 1-.205.729l-.775.776c.616.63.995 1.493.995 2.444v.327c0 .1-.009.197-.025.292.408.14.764.392 1.029.722l1.968-.787a.75.75 0 0 1 .556 1.392L13 7.258V9h2.25a.75.75 0 0 1 0 1.5H13v.5c0 .409-.049.806-.141 1.186l2.17.868a.75.75 0 0 1-.557 1.392l-2.184-.873A4.997 4.997 0 0 1 8 16a4.997 4.997 0 0 1-4.288-2.427l-2.183.873a.75.75 0 0 1-.558-1.392l2.17-.868A5.036 5.036 0 0 1 3 11v-.5H.75a.75.75 0 0 1 0-1.5H3V7.258L.971 6.446a.75.75 0 0 1 .558-1.392l1.967.787c.265-.33.62-.583 1.03-.722a1.677 1.677 0 0 1-.026-.292V4.5c0-.951.38-1.814.995-2.444L4.72 1.28a.75.75 0 0 1 0-1.06Zm.53 6.28a.75.75 0 0 0-.75.75V11a3.5 3.5 0 1 0 7 0V7.25a.75.75 0 0 0-.75-.75ZM6.173 5h3.654A.172.172 0 0 0 10 4.827V4.5a2 2 0 1 0-4 0v.327c0 .096.077.173.173.173Z"></path></svg>`,
  blocked: `<svg version="1.1" width="16" height="16" viewBox="0 0 16 16" class="octicon octicon-blocked octicon" data-component="Octicon"><path d="M4.467.22a.749.749 0 0 1 .53-.22h6.006c.199 0 .389.079.53.22l4.247 4.247c.141.14.22.331.22.53v6.006a.749.749 0 0 1-.22.53l-4.247 4.247a.749.749 0 0 1-.53.22H4.997a.749.749 0 0 1-.53-.22L.22 11.533a.749.749 0 0 1-.22-.53V4.997c0-.199.079-.389.22-.53Zm.84 1.28L1.5 5.308v5.384L5.308 14.5h5.384l3.808-3.808V5.308L10.692 1.5ZM4 7.75A.75.75 0 0 1 4.75 7h6.5a.75.75 0 0 1 0 1.5h-6.5A.75.75 0 0 1 4 7.75Z"></path></svg>`,
  tag: `<svg version="1.1" width="16" height="16" viewBox="0 0 16 16" class="octicon octicon-tag octicon" data-component="Octicon"><path d="M1 7.775V2.75C1 1.784 1.784 1 2.75 1h5.025c.464 0 .91.184 1.238.513l6.25 6.25a1.75 1.75 0 0 1 0 2.474l-5.026 5.026a1.75 1.75 0 0 1-2.474 0l-6.25-6.25A1.752 1.752 0 0 1 1 7.775Zm1.5 0c0 .066.026.13.073.177l6.25 6.25a.25.25 0 0 0 .354 0l5.025-5.025a.25.25 0 0 0 0-.354l-6.25-6.25a.25.25 0 0 0-.177-.073H2.75a.25.25 0 0 0-.25.25ZM6 5a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z"></path></svg>`,
  dash: `<svg version="1.1" width="16" height="16" viewBox="0 0 16 16" class="octicon octicon-dash octicon" data-component="Octicon"><path d="M2 7.75A.75.75 0 0 1 2.75 7h10a.75.75 0 0 1 0 1.5h-10A.75.75 0 0 1 2 7.75Z"></path></svg>`,
  trash: `<svg version="1.1" width="16" height="16" viewBox="0 0 16 16" class="octicon octicon-trash octicon" data-component="Octicon"><path d="M11 1.75V3h2.25a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75ZM4.496 6.675l.66 6.6a.25.25 0 0 0 .249.225h5.19a.25.25 0 0 0 .249-.225l.66-6.6a.75.75 0 0 1 1.492.149l-.66 6.6A1.748 1.748 0 0 1 10.595 15h-5.19a1.75 1.75 0 0 1-1.741-1.575l-.66-6.6a.75.75 0 1 1 1.492-.15ZM6.5 1.75V3h3V1.75a.25.25 0 0 0-.25-.25h-2.5a.25.25 0 0 0-.25.25Z"></path></svg>`,
  question: `<svg version="1.1" width="16" height="16" viewBox="0 0 16 16" class="octicon octicon-question octicon" data-component="Octicon"><path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.92 6.085h.001a.749.749 0 1 1-1.342-.67c.169-.339.436-.701.849-.977C6.845 4.16 7.369 4 8 4a2.756 2.756 0 0 1 1.637.525c.503.377.863.965.863 1.725 0 .448-.115.83-.329 1.15-.205.307-.47.513-.692.662-.109.072-.22.138-.313.195l-.006.004a6.24 6.24 0 0 0-.26.16.952.952 0 0 0-.276.245.75.75 0 0 1-1.248-.832c.184-.264.42-.489.692-.661.103-.067.207-.132.313-.195l.007-.004c.1-.061.182-.11.258-.161a.969.969 0 0 0 .277-.245C8.96 6.514 9 6.427 9 6.25a.612.612 0 0 0-.262-.525A1.27 1.27 0 0 0 8 5.5c-.369 0-.595.09-.74.187a1.01 1.01 0 0 0-.34.398ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"></path></svg>`,
  archive: `<svg version="1.1" width="16" height="16" viewBox="0 0 16 16" class="octicon octicon-archive octicon" data-component="Octicon"><path d="M0 2.75C0 1.784.784 1 1.75 1h12.5c.966 0 1.75.784 1.75 1.75v1.5A1.75 1.75 0 0 1 14.25 6H1.75A1.75 1.75 0 0 1 0 4.25ZM1.75 7a.75.75 0 0 1 .75.75v5.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-5.5a.75.75 0 0 1 1.5 0v5.5A1.75 1.75 0 0 1 13.25 15H2.75A1.75 1.75 0 0 1 1 13.25v-5.5A.75.75 0 0 1 1.75 7Zm0-4.5a.25.25 0 0 0-.25.25v1.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-1.5a.25.25 0 0 0-.25-.25ZM6.25 8h3.5a.75.75 0 0 1 0 1.5h-3.5a.75.75 0 0 1 0-1.5Z"></path></svg>`,
  merge: `<svg version="1.1" width="16" height="16" viewBox="0 0 16 16" class="octicon octicon-git-merge octicon" data-component="Octicon"><path d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0 0 .005V3.25Z"></path></svg>`,
  eye: `<svg version="1.1" width="16" height="16" viewBox="0 0 16 16" class="octicon octicon-eye octicon" data-component="Octicon"><path d="M8 2c1.981 0 3.671.992 4.933 2.078 1.27 1.091 2.187 2.345 2.637 3.023a1.62 1.62 0 0 1 0 1.798c-.45.678-1.367 1.932-2.637 3.023C11.67 13.008 9.981 14 8 14c-1.981 0-3.671-.992-4.933-2.078C1.797 10.83.88 9.576.43 8.898a1.62 1.62 0 0 1 0-1.798c.45-.677 1.367-1.931 2.637-3.022C4.33 2.992 6.019 2 8 2ZM1.679 7.932a.12.12 0 0 0 0 .136c.411.622 1.241 1.75 2.366 2.717C5.176 11.758 6.527 12.5 8 12.5c1.473 0 2.825-.742 3.955-1.715 1.124-.967 1.954-2.096 2.366-2.717a.12.12 0 0 0 0-.136c-.412-.621-1.242-1.75-2.366-2.717C10.824 4.242 9.473 3.5 8 3.5c-1.473 0-2.825.742-3.955 1.715-1.124.967-1.954 2.096-2.366 2.717ZM8 10a2 2 0 1 1-.001-3.999A2 2 0 0 1 8 10Z"></path></svg>`,
  person: `<svg version="1.1" width="16" height="16" viewBox="0 0 16 16" class="octicon octicon-person octicon" data-component="Octicon"><path d="M10.561 8.073a6.005 6.005 0 0 1 3.432 5.142.75.75 0 1 1-1.498.07 4.5 4.5 0 0 0-8.99 0 .75.75 0 0 1-1.498-.07 6.004 6.004 0 0 1 3.431-5.142 3.999 3.999 0 1 1 5.123 0ZM10.5 5a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z"></path></svg>`,
  tools: `<svg version="1.1" width="16" height="16" viewBox="0 0 16 16" class="octicon octicon-tools octicon" data-component="Octicon"><path d="M5.433 2.304A4.492 4.492 0 0 0 3.5 6c0 1.598.832 3.002 2.09 3.802.518.328.929.923.902 1.64v.008l-.164 3.337a.75.75 0 1 1-1.498-.073l.163-3.33c.002-.085-.05-.216-.207-.316A5.996 5.996 0 0 1 2 6a5.993 5.993 0 0 1 2.567-4.92 1.482 1.482 0 0 1 1.673-.04c.462.296.76.827.76 1.423v2.82c0 .082.041.16.11.206l.75.51a.25.25 0 0 0 .28 0l.75-.51A.249.249 0 0 0 9 5.282V2.463c0-.596.298-1.127.76-1.423a1.482 1.482 0 0 1 1.673.04A5.993 5.993 0 0 1 14 6a5.996 5.996 0 0 1-2.786 5.068c-.157.1-.209.23-.207.315l.163 3.33a.752.752 0 0 1-1.094.714.75.75 0 0 1-.404-.64l-.164-3.345c-.027-.717.384-1.312.902-1.64A4.495 4.495 0 0 0 12.5 6a4.492 4.492 0 0 0-1.933-3.696c-.024.017-.067.067-.067.16v2.818a1.75 1.75 0 0 1-.767 1.448l-.75.51a1.75 1.75 0 0 1-1.966 0l-.75-.51A1.75 1.75 0 0 1 5.5 5.282V2.463c0-.092-.043-.142-.067-.159Z"></path></svg>`,
  link: `<svg version="1.1" width="16" height="16" viewBox="0 0 16 16" class="octicon octicon-link octicon" data-component="Octicon"><path d="m7.775 3.275 1.25-1.25a3.5 3.5 0 1 1 4.95 4.95l-2.5 2.5a3.5 3.5 0 0 1-4.95 0 .751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018 1.998 1.998 0 0 0 2.83 0l2.5-2.5a2.002 2.002 0 0 0-2.83-2.83l-1.25 1.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042Zm-4.69 9.64a1.998 1.998 0 0 0 2.83 0l1.25-1.25a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042l-1.25 1.25a3.5 3.5 0 1 1-4.95-4.95l2.5-2.5a3.5 3.5 0 0 1 4.95 0 .751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018 1.998 1.998 0 0 0-2.83 0l-2.5 2.5a1.998 1.998 0 0 0 0 2.83Z"></path></svg>`,
  clock: `<svg version="1.1" width="16" height="16" viewBox="0 0 16 16" class="octicon octicon-clock octicon" data-component="Octicon"><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm7-3.25v2.992l2.028.812a.75.75 0 0 1-.557 1.392l-2.5-1A.751.751 0 0 1 7 8.25v-3.5a.75.75 0 0 1 1.5 0Z"></path></svg>`,
  alert: `<svg version="1.1" width="16" height="16" viewBox="0 0 16 16" class="octicon octicon-alert octicon" data-component="Octicon"><path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"></path></svg>`,
  reply: `<svg version="1.1" width="16" height="16" viewBox="0 0 16 16" class="octicon octicon-reply octicon" data-component="Octicon"><path d="M6.78 1.97a.75.75 0 0 1 0 1.06L3.81 6h6.44A4.75 4.75 0 0 1 15 10.75v2.5a.75.75 0 0 1-1.5 0v-2.5a3.25 3.25 0 0 0-3.25-3.25H3.81l2.97 2.97a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L1.47 7.28a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0Z"></path></svg>`,
  prSmall: `<svg version="1.1" width="16" height="16" viewBox="0 0 16 16" class="octicon octicon-git-pull-request octicon" data-component="Octicon"><path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z"></path></svg>`,
  issueOpen: `<svg version="1.1" width="16" height="16" viewBox="0 0 16 16" class="octicon octicon-issue-opened octicon" data-component="Octicon"><path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"></path><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z"></path></svg>`,
  checkSmall: `<svg version="1.1" width="16" height="16" viewBox="0 0 16 16" class="octicon octicon-check octicon" data-component="Octicon"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"></path></svg>`,
  xSmall: `<svg version="1.1" width="16" height="16" viewBox="0 0 16 16" class="octicon octicon-x octicon" data-component="Octicon"><path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"></path></svg>`,
  issue: `<svg class="octicon state-icon open" viewBox="0 0 16 16" width="16" height="16"><path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"/><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z"/></svg>`,
  pr: `<svg class="octicon state-icon open" viewBox="0 0 16 16" width="16" height="16"><path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z"/></svg>`,
  draft: `<svg class="octicon state-icon draft" viewBox="0 0 16 16" width="16" height="16"><path d="M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 14a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM14 7.5a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Zm0-4.25a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Z"/></svg>`,
  issueSmall: `<svg class="octicon" viewBox="0 0 16 16" width="14" height="14"><path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"/><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z"/></svg>`,
  check: `<svg class="octicon" viewBox="0 0 16 16" width="16" height="16"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/></svg>`,
  x: `<svg class="octicon" viewBox="0 0 16 16" width="16" height="16"><path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/></svg>`,
  dot: `<svg class="octicon" viewBox="0 0 16 16" width="16" height="16"><path d="M8 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z"/></svg>`,
  comment: `<svg class="octicon" viewBox="0 0 16 16" width="16" height="16"><path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.573 2.573A1.458 1.458 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h4.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>`,
  bot: `<svg class="octicon" viewBox="0 0 16 16" width="16" height="16"><path d="M5.75 7.5a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5a.75.75 0 0 1 .75-.75Zm5.25.75a.75.75 0 0 0-1.5 0v1.5a.75.75 0 0 0 1.5 0v-1.5Z"/><path d="M6.25 0h2A.75.75 0 0 1 9 .75V3.5h3.25a2.25 2.25 0 0 1 2.25 2.25V8h.75a.75.75 0 0 1 0 1.5h-.75v2.75a2.25 2.25 0 0 1-2.25 2.25h-8.5a2.25 2.25 0 0 1-2.25-2.25V9.5H.75a.75.75 0 0 1 0-1.5h.75V5.75A2.25 2.25 0 0 1 3.75 3.5H7.5v-2H6.25a.75.75 0 0 1 0-1.5ZM3 5.75v6.5c0 .414.336.75.75.75h8.5a.75.75 0 0 0 .75-.75v-6.5a.75.75 0 0 0-.75-.75h-8.5a.75.75 0 0 0-.75.75Z"/></svg>`,
};

// ---------- filtering ----------

function matches(item, f, { ignoreLabels = false } = {}) {
  if (item.type !== f.tab) return false;
  if (f.minSeverity === -1) {
    if (item.severity !== 0) return false;
  } else if (f.minSeverity > 0) {
    if (item.severity < f.minSeverity && !(f.includeUnrated && item.severity === 0)) return false;
  }
  if (f.newerThanDays && Date.now() - new Date(item.createdAt) > f.newerThanDays * 864e5) return false;
  if (f.staleDays && Date.now() - new Date(item.updatedAt) < f.staleDays * 864e5) return false;
  if (f.q) {
    const q = f.q.toLowerCase().trim();
    const num = q.replace(/^#/, '');
    const hay = `${item.title} ${item.author.login}`.toLowerCase();
    if (!(String(item.number) === num || q.split(/\s+/).every((w) => hay.includes(w)))) return false;
  }
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
  if (f.idleDays && conv && Date.now() - new Date(conv.since) < f.idleDays * 864e5) return false;
  if (f.verdict) {
    const t = item.triage;
    if (f.verdict === 'unverified' ? t?.verification : f.verdict === 'mismatch' ? !severityMismatch(item) : f.verdict === 'fixpr' ? !t?.fixPrs.length : t?.verification?.outcome !== f.verdict)
      return false;
  }
  if (f.assignee === 'none' && item.assignees.length) return false;
  if (f.assignee === 'any' && !item.assignees.length) return false;
  if (f.assignee.startsWith('user:')) {
    const login = f.assignee.slice(5) === '@me' ? me?.login : f.assignee.slice(5);
    if (!item.assignees.some((a) => a.login === login)) return false;
  }
  return true;
}

function sortItems(items) {
  const by = {
    severity: (a, b) => b.severity - a.severity || b.updatedAt.localeCompare(a.updatedAt),
    updated: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
    created: (a, b) => b.createdAt.localeCompare(a.createdAt),
    'created-asc': (a, b) => a.createdAt.localeCompare(b.createdAt),
    comments: (a, b) => b.commentCount - a.commentCount,
    reactions: (a, b) => b.thumbsUp - a.thumbsUp || b.commentCount - a.commentCount,
    waiting: (a, b) => (a.conversation?.since ?? '').localeCompare(b.conversation?.since ?? ''),
  }[filters.sort];
  return items.sort(by || (() => 0));
}

// ---------- rendering ----------

function render() {
  writeHash();
  syncControls();

  const visible = sortItems(data.items.filter((i) => matches(i, filters)));
  const tabCount = (tab) => data.items.filter((i) => matches(i, { ...filters, tab })).length;
  $('#count-issue').textContent = tabCount('issue');
  $('#count-pr').textContent = tabCount('pr');
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('selected', t.dataset.tab === filters.tab));
  $('#pr-filters').hidden = filters.tab !== 'pr';

  renderCommands();
  renderActiveFilters();
  renderFacets();

  // Drop selections that are no longer visible.
  const visibleNums = new Set(visible.map((i) => i.number));
  selected = new Set([...selected].filter((n) => visibleNums.has(n)));

  const noun = filters.tab === 'pr' ? 'pull request' : 'issue';
  $('#result-count').textContent = `${visible.length} open ${noun}${visible.length === 1 ? '' : 's'}`;
  $('#list').innerHTML = visible.length
    ? visible.slice(0, shown).map(rowHtml).join('')
    : `<li class="empty">${data.items.length ? 'No results match your filters.' : 'Loading from GitHub… (first sync takes ~1–2 minutes)'}</li>`;
  $('#more').innerHTML =
    visible.length > shown ? `<button class="btn btn-sm" id="more-btn">Show ${Math.min(PAGE, visible.length - shown)} more (${visible.length - shown} remaining)</button>` : '';
  updateBulk(visible);
}

function rowHtml(i) {
  const action = ACTIONS[i.type];
  const icon = i.type === 'pr' ? (i.isDraft ? icons.draft : icons.pr) : icons.issue;
  const meta = [`<a href="${i.url}" target="_blank" rel="noreferrer">#${i.number}</a> opened ${ago(i.createdAt)} by <a href="https://github.com/${esc(i.author.login)}" target="_blank" rel="noreferrer">${esc(i.author.login)}</a>`];
  meta.push(`<span class="sep">·</span> updated ${ago(i.updatedAt)}`);
  if (i.type === 'pr') {
    if (i.isDraft) meta.push(`<span class="status">Draft</span>`);
    if (i.checks === 'SUCCESS') meta.push(`<span class="status success" title="Checks passing">${icons.check} checks</span>`);
    else if (i.checks === 'FAILURE' || i.checks === 'ERROR') meta.push(`<span class="status failure" title="Checks failing">${icons.x} checks</span>`);
    else if (i.checks) meta.push(`<span class="status pending" title="Checks ${i.checks.toLowerCase()}">${icons.dot} checks</span>`);
    if (i.reviewDecision === 'APPROVED') meta.push(`<span class="status approved">${icons.check} Approved</span>`);
    else if (i.reviewDecision === 'CHANGES_REQUESTED') meta.push(`<span class="status changes">Changes requested</span>`);
    else if (i.reviewDecision === 'REVIEW_REQUIRED') meta.push(`<span class="status">Review required</span>`);
    if (i.mergeable === 'CONFLICTING') meta.push(`<span class="status conflict">Conflicts</span>`);
    for (const li of i.linkedIssues || []) {
      meta.push(`<a class="status" href="${li.url}" target="_blank" rel="noreferrer" title="Linked issue: ${esc(li.title)}">${icons.issueSmall} #${li.number}</a>`);
    }
    meta.push(`<span class="diffstat"><span class="add">+${i.additions}</span> <span class="del">−${i.deletions}</span></span>`);
  }
  if (i.thumbsUp) meta.push(`<span>👍 ${i.thumbsUp}</span>`);
  meta.push(waitingHtml(i));
  const c = i.bot.lastCommand;
  if (c) {
    const replied = i.bot.botRepliedAfterCommand;
    const outcome = replied && i.bot.lastBotReply.outcome ? ` · ${esc(i.bot.lastBotReply.outcome)}` : '';
    meta.push(
      `<span class="bot-status ${replied ? 'replied' : 'pending'}" title="Last @expo-bot command by ${esc(c.by)} ${ago(c.at)}${
        replied ? `; bot replied ${ago(i.bot.lastBotReply.at)}` : '; no bot reply yet'
      }">${icons.bot} ${esc(c.command)} ${ago(c.at)}${replied ? ' ✓' + outcome : ' …'}</span>`
    );
  }
  const people = (i.latestReviews || []).filter((r) => r.login);
  const seen = new Set();
  const avatars = people
    .filter((p) => !seen.has(p.login) && seen.add(p.login))
    .slice(0, 4)
    .map((p) => `<img class="avatar" src="${p.avatarUrl}&s=40" alt="${esc(p.login)}" title="Reviewed by ${esc(p.login)}" loading="lazy">`)
    .join('');
  const posted = postedThisSession.has(i.number);
  return `<li class="row${selected.has(i.number) ? ' selected' : ''}" data-number="${i.number}">
    <input type="checkbox" class="row-check" ${selected.has(i.number) ? 'checked' : ''} />
    ${icon}
    <div class="row-main">
      <a class="row-title" href="${i.url}" target="_blank" rel="noreferrer">${esc(i.title)}</a>
      <span class="labels">${i.assignees.map(assigneeChipHtml).join('')}${i.labels.map((l) => labelHtml(l)).join('')}</span>
      <div class="meta">${meta.join(' ')}</div>
      ${triageHtml(i)}
    </div>
    <div class="row-side">
      <span class="avatars">${avatars}</span>
      <span class="comments-count">${i.commentCount ? `${icons.comment} ${i.commentCount}` : ''}</span>
      <button class="btn btn-action${posted ? ' done' : ''}" data-action="${i.number}" title="Comment “${action.body}” on #${i.number}">${posted ? '✓ Requested' : action.label}</button>
    </div>
  </li>`;
}

function waitingHtml(i) {
  const c = i.conversation;
  if (!c || c.waitingOn === 'internal') return '';
  const days = Math.floor((Date.now() - new Date(c.since)) / 864e5);
  const dur = days < 1 ? 'today' : `${days}d`;
  const last = c.lastHuman ? `Last human comment by ${c.lastHuman.login} (${c.lastHuman.role}) ${ago(c.lastHuman.at)}` : 'No human comments yet';
  if (c.waitingOn === 'reporter') return `<span class="waiting reporter" title="${esc(last)}">${icons.clock} waiting on ${i.type === 'pr' ? 'author' : 'reporter'} · ${dur}</span>`;
  if (!c.teamReplied) return `<span class="waiting never" title="${esc(last)}">${icons.alert} no team reply yet · ${dur}</span>`;
  return `<span class="waiting team" title="${esc(last)}">${icons.reply} we owe a reply · ${dur}</span>`;
}

function severityMismatch(item) {
  const s = item.triage?.assessment?.severity;
  return !!s && !item.labels.some((l) => l.name === s.label);
}

const OUTCOME_TEXT = { problem: 'Reproduced', blocked: 'Blocked', pass: 'Not reproduced' };
const expanded = new Set();

function triageHtml(i) {
  const t = i.triage;
  if (!t) return '';
  const a = t.assessment;
  const v = t.verification;
  const parts = [];
  if (a) {
    let sev = '';
    if (a.severity) {
      const color = data.labels.find((l) => l.name === a.severity.label)?.color;
      sev = ` · suggests ${labelHtml({ name: a.severity.label, color })}`;
      if (severityMismatch(i)) sev += ` <button class="btn btn-xs" data-apply-severity="${i.number}" title="Replace the current severity label with ${esc(a.severity.label)}">Apply</button>`;
    }
    parts.push(`<span>${icons.bot} <a href="${a.url}" target="_blank" rel="noreferrer">${esc(a.kind ?? 'Assessed')}${a.confidence != null ? ` · ${a.confidence}%` : ''}</a>${sev}</span>`);
  }
  if (v) {
    parts.push(
      `<a href="${v.url}" target="_blank" rel="noreferrer" class="verdict ${esc(v.outcome)}">${esc(OUTCOME_TEXT[v.outcome] ?? v.outcome)}</a>` +
        (v.headline ? `<span class="verdict-headline" title="${esc(v.headline)}">${esc(v.headline[0].toUpperCase() + v.headline.slice(1))}</span>` : '')
    );
  }
  for (const n of t.fixPrs) parts.push(`<a href="https://github.com/${data.repo}/pull/${n}" target="_blank" rel="noreferrer">🔧 fix PR #${n}</a>`);
  const hasDetails = a?.impact || a?.scope || v?.maintainer || v?.reporter;
  if (hasDetails) parts.push(`<button class="details-toggle" data-details="${i.number}">${expanded.has(i.number) ? 'hide details ▴' : 'details ▾'}</button>`);
  const details =
    hasDetails && expanded.has(i.number)
      ? `<div class="triage-details">${[
          a?.impact && `<p><strong>Impact:</strong> ${esc(a.impact)}</p>`,
          a?.scope && `<p><strong>Scope:</strong> ${esc(a.scope)}</p>`,
          v?.maintainer && `<p><strong>For maintainers:</strong> ${esc(v.maintainer)}</p>`,
          v?.reporter && `<p><strong>For reporter:</strong> ${esc(v.reporter)}</p>`,
        ]
          .filter(Boolean)
          .join('')}</div>`
      : '';
  return `<div class="triage">${parts.join('')}</div>${details}`;
}

function renderCommands() {
  const collapsed = localStorage.getItem('commandsCollapsed') === '1';
  const tabItems = data.items.filter((i) => i.type === filters.tab);
  const count = (f) => tabItems.filter((i) => matches(i, { ...DEFAULT_FILTERS, tab: filters.tab, ...f })).length;
  const cards = COMMANDS[filters.tab]
    .map((card) => {
      const rows = card.items
        .map((cmd) => {
          const n = count(cmd.f);
          const color = cmd.label_ && data.labels.find((l) => l.name === cmd.label_)?.color;
          const name = cmd.label_ ? labelHtml({ name: cmd.label_, color }).replace('<a ', '<span ').replace('</a>', '</span>') : `${icons[cmd.icon] ?? ''}<span>${esc(cmd.label)}</span>`;
          return `<button class="cmd tone-${cmd.tone ?? 'muted'}${filters.preset === cmd.id ? ' selected' : ''}${n ? '' : ' zero'}" data-cmd="${cmd.id}">
            <span class="cmd-name">${name}</span><span class="cmd-count">${n}</span>
          </button>`;
        })
        .join('');
      return `<div class="cmd-card"><h4 title="${esc(card.hint)}">${icons[card.icon] ?? ''} ${esc(card.title)}</h4>${rows}</div>`;
    })
    .join('');
  $('#presets').innerHTML = `<div class="cmd-header">
      <button class="cmd-toggle" id="cmd-toggle">${collapsed ? '▸' : '▾'} Triage commands</button>
      <span class="muted">Click a command to apply its filters; click again to reset.</span>
    </div>
    ${collapsed ? '' : `<div class="cmd-grid">${cards}</div>`}`;
}

function renderActiveFilters() {
  const colorOf = Object.fromEntries(data.labels.map((l) => [l.name, l.color]));
  const chips = [
    ...filters.include.map((n) => labelHtml({ name: n, color: colorOf[n] }, { removable: true })),
    ...filters.exclude.map((n) => labelHtml({ name: n, color: colorOf[n] }, { removable: true })),
  ];
  if (filters.newerThanDays) chips.push(`<span class="muted">created in last ${filters.newerThanDays}d</span>`);
  if (filters.staleDays) chips.push(`<span class="muted">no activity for ${filters.staleDays}d+</span>`);
  if (filters.minSeverity === -1) chips.push(`<span class="muted">no severity label</span>`);
  $('#active-filters').innerHTML = chips.length || isFiltered() ? chips.join('') + `<button class="clear-link" id="clear-filters">✕ Clear filters</button>` : '';
}

function isFiltered() {
  return Object.entries(DEFAULT_FILTERS).some(([k, v]) => k !== 'tab' && k !== 'sort' && k !== 'preset' && JSON.stringify(filters[k]) !== JSON.stringify(v));
}

function renderFacets() {
  // Counts are computed against the current filters *except* labels, plus the
  // currently-included labels, so they show how many results each label would leave.
  const base = data.items.filter((i) => matches(i, filters, { ignoreLabels: true }));
  const pool = base.filter((i) => {
    const names = new Set(i.labels.map((l) => l.name));
    return filters.include.every((l) => names.has(l)) && !filters.exclude.some((l) => names.has(l));
  });
  const counts = new Map();
  for (const i of pool) for (const l of i.labels) counts.set(l.name, (counts.get(l.name) || 0) + 1);
  const groups = new Map();
  const q = facetQuery.toLowerCase();
  for (const l of data.labels) {
    const n = counts.get(l.name) || 0;
    const pinned = filters.include.includes(l.name) || filters.exclude.includes(l.name);
    if (!n && !pinned) continue;
    if (q && !l.name.toLowerCase().includes(q)) continue;
    const g = labelGroup(l.name);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push({ ...l, n });
  }
  const sevOrder = (name) => -(['severity: trivial', 'severity: low', 'severity: medium', 'severity: high', 'severity: critical'].indexOf(name));
  $('#facets').innerHTML = GROUP_ORDER.filter((g) => groups.has(g))
    .map((g) => {
      const ls = groups.get(g).sort((a, b) => (g === 'Severity' ? sevOrder(a.name) - sevOrder(b.name) : b.n - a.n));
      const collapsed = collapsedGroups.has(g) && !q;
      return `<div class="facet-group${collapsed ? ' collapsed' : ''}" data-group="${esc(g)}">
        <h4><span>${esc(g)}</span><span>${collapsed ? '▸' : '▾'} ${ls.length}</span></h4>
        ${ls.map((l) => `<div class="facet">${labelHtml(l)}<span class="count">${l.n}</span></div>`).join('')}
      </div>`;
    })
    .join('');
}

function syncControls() {
  $('#search').value !== filters.q && document.activeElement !== $('#search') && ($('#search').value = filters.q);
  $('#min-severity').value = String(Math.max(0, filters.minSeverity));
  $('#include-unrated').checked = filters.includeUnrated;
  $('#include-unrated').parentElement.style.visibility = filters.minSeverity > 0 ? 'visible' : 'hidden';
  $('#sort').value = filters.sort;
  $('#hide-drafts').checked = filters.hideDrafts;
  $('#checks').value = filters.checks;
  $('#review').value = filters.review;
  $('#mergeable').value = filters.mergeable;
  $('#linked').value = filters.linked;
  $('#bot-filter').value = filters.bot;
  $('#waiting').value = filters.waiting;
  $('#idle').value = String(filters.idleDays);
  $('#verdict').value = filters.verdict;
  renderAssigneeOptions();
  $('#assignee-filter').value = filters.assignee;
}

function renderAssigneeOptions() {
  const counts = new Map();
  for (const i of data.items) if (i.type === filters.tab) for (const a of i.assignees) counts.set(a.login, (counts.get(a.login) || 0) + 1);
  const users = [...counts].sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: 'base' }));
  // Keep a filtered-on user selectable even if they have nothing on this tab.
  const current = filters.assignee.startsWith('user:') ? filters.assignee.slice(5) : null;
  if (current && current !== '@me' && !counts.has(current)) users.push([current, 0]);
  $('#assignee-filter').innerHTML = [
    '<option value="">Any</option>',
    '<option value="none">Unassigned</option>',
    '<option value="any">Assigned</option>',
    me ? '<option value="user:@me">Assigned to me</option>' : '',
    '<optgroup label="Assigned to">',
    ...users.map(([login, n]) => `<option value="user:${esc(login)}">${esc(login)} (${n})</option>`),
    '</optgroup>',
  ].join('');
}

function updateBulk(visible) {
  const action = ACTIONS[filters.tab];
  const btn = $('#bulk-btn');
  btn.disabled = !selected.size;
  btn.textContent = selected.size ? `${action.bulk} (${selected.size})` : `${action.bulk} — select items`;
  $('#bulk-close-btn').disabled = !selected.size;
  $('#bulk-close-btn').textContent = selected.size ? `Close… (${selected.size})` : 'Close…';
  const sa = $('#select-all');
  const pageNums = visible.slice(0, shown).map((i) => i.number);
  sa.checked = pageNums.length > 0 && pageNums.every((n) => selected.has(n));
  sa.indeterminate = !sa.checked && pageNums.some((n) => selected.has(n));
}

// ---------- GitHub actions (run in the browser with the user's own token) ----------

const postedThisSession = new Map(); // number -> comment id

function getToken() {
  return localStorage.getItem('ghToken');
}

async function gh(path, opts = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${getToken()}`,
      'x-github-api-version': '2022-11-28',
      ...(opts.body ? { 'content-type': 'application/json' } : {}),
    },
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(`${res.status} ${j.message || res.statusText}`);
  }
  return res.status === 204 ? null : res.json();
}

async function postCommand(numbers) {
  if (!getToken()) {
    openTokenDialog();
    return;
  }
  const items = numbers.map((n) => data.items.find((i) => i.number === n)).filter(Boolean);
  const results = await Promise.allSettled(
    items.map(async (item) => {
      const action = ACTIONS[item.type];
      const comment = await gh(`/repos/${data.repo}/issues/${item.number}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body: action.body }),
      });
      postedThisSession.set(item.number, comment.id);
      item.bot = {
        ...item.bot,
        lastCommand: { command: action.command, by: me?.login, at: new Date().toISOString() },
        botRepliedAfterCommand: false,
      };
      return item;
    })
  );
  const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  const failed = results.filter((r) => r.status === 'rejected');
  selected = new Set([...selected].filter((n) => !ok.some((i) => i.number === n)));
  render();
  if (ok.length) {
    toast(
      ok.length === 1 ? `Posted “${ACTIONS[ok[0].type].body}” on #${ok[0].number}` : `Posted on ${ok.length} items`,
      { undo: () => undo(ok) }
    );
  }
  if (failed.length) toast(`Failed on ${failed.length}: ${failed[0].reason.message}`, { error: true });
}

async function undo(items) {
  await Promise.allSettled(
    items.map(async (item) => {
      const id = postedThisSession.get(item.number);
      if (!id) return;
      await gh(`/repos/${data.repo}/issues/comments/${id}`, { method: 'DELETE' });
      postedThisSession.delete(item.number);
    })
  );
  toast('Undone — comments deleted');
  refresh();
}

function requireToken() {
  if (getToken()) return true;
  openTokenDialog();
  return false;
}

async function applySeverity(item) {
  if (!requireToken()) return;
  const target = item.triage.assessment.severity.label;
  const removed = item.labels.filter((l) => l.name.startsWith('severity:') && l.name !== target);
  const enc = (n) => encodeURIComponent(n);
  try {
    await gh(`/repos/${data.repo}/issues/${item.number}/labels`, { method: 'POST', body: JSON.stringify({ labels: [target] }) });
    for (const l of removed) await gh(`/repos/${data.repo}/issues/${item.number}/labels/${enc(l.name)}`, { method: 'DELETE' });
  } catch (e) {
    return toast(`Couldn't change labels on #${item.number}: ${e.message}`, { error: true });
  }
  const before = item.labels;
  item.labels = [...item.labels.filter((l) => !removed.includes(l)), data.labels.find((l) => l.name === target) ?? { name: target, color: 'ededed' }];
  item.severity = SEVERITY_RANK[target] ?? 0;
  render();
  toast(`#${item.number}: ${removed.length ? `${removed.map((l) => l.name).join(', ')} → ` : ''}${target}`, {
    undo: async () => {
      await gh(`/repos/${data.repo}/issues/${item.number}/labels/${enc(target)}`, { method: 'DELETE' }).catch(() => {});
      if (removed.length) await gh(`/repos/${data.repo}/issues/${item.number}/labels`, { method: 'POST', body: JSON.stringify({ labels: removed.map((l) => l.name) }) });
      item.labels = before;
      item.severity = Math.max(0, ...before.map((l) => SEVERITY_RANK[l.name] ?? 0));
      render();
      toast('Labels restored');
    },
  });
}
const SEVERITY_RANK = { 'severity: trivial': 1, 'severity: low': 2, 'severity: medium': 3, 'severity: high': 4, 'severity: critical': 5 };

const CLOSE_TEMPLATES = {
  issue: [
    {
      name: 'No response from reporter',
      reason: 'not_planned',
      body: "Closing this since we haven't heard back. If this is still a problem on the latest SDK, please open a new issue with a minimal reproduction and we'll take another look. Thanks!",
    },
    {
      name: 'Missing minimal reproduction',
      reason: 'not_planned',
      body: "We need a minimal reproducible example to investigate this, so we're closing the issue for now. Please open a new issue with a minimal repro (e.g. a GitHub repo or Snack) and we'll be happy to take a look.",
    },
    {
      name: 'Fixed in a newer SDK',
      reason: 'completed',
      body: 'This is fixed in the latest SDK. Please upgrade and open a new issue if you still run into it. Thanks!',
    },
    {
      name: 'Upstream (React Native)',
      reason: 'not_planned',
      body: 'This behavior comes from React Native itself rather than Expo, so it needs to be reported upstream at https://github.com/facebook/react-native/issues. Thanks!',
    },
    { name: 'Custom…', reason: 'not_planned', body: '' },
  ],
  pr: [
    { name: 'Stale / no response', reason: 'not_planned', body: "Closing this since there hasn't been activity in a while. Feel free to reopen or open a new PR if you'd like to pick it back up. Thanks for the contribution!" },
    { name: 'Custom…', reason: 'not_planned', body: '' },
  ],
};

function openCloseDialog() {
  if (!requireToken()) return;
  const tpls = CLOSE_TEMPLATES[filters.tab];
  const sel = $('#close-template');
  sel.innerHTML = tpls.map((t, idx) => `<option value="${idx}">${esc(t.name)}</option>`).join('');
  const pick = () => {
    const t = tpls[Number(sel.value)];
    $('#close-body').value = t.body;
    $('#close-reason').value = t.reason;
  };
  sel.onchange = pick;
  pick();
  $('#close-reason').querySelector('[value=duplicate]').disabled = filters.tab === 'pr';
  $('#close-title').textContent = `Comment & close ${selected.size} ${filters.tab === 'pr' ? 'pull request' : 'issue'}${selected.size === 1 ? '' : 's'}`;
  $('#close-dialog').showModal();
}

$('#close-dialog').addEventListener('close', () => {
  if ($('#close-dialog').returnValue !== 'close') return;
  closeItems([...selected], $('#close-body').value.trim(), $('#close-reason').value);
});

async function closeItems(numbers, body, reason) {
  const items = numbers.map((n) => data.items.find((i) => i.number === n)).filter(Boolean);
  const results = await Promise.allSettled(
    items.map(async (item) => {
      const comment = body
        ? await gh(`/repos/${data.repo}/issues/${item.number}/comments`, { method: 'POST', body: JSON.stringify({ body }) })
        : null;
      const patch = item.type === 'pr' ? { state: 'closed' } : { state: 'closed', state_reason: reason };
      await gh(`/repos/${data.repo}/${item.type === 'pr' ? 'pulls' : 'issues'}/${item.number}`, { method: 'PATCH', body: JSON.stringify(patch) });
      return { item, commentId: comment?.id };
    })
  );
  const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  const failed = results.filter((r) => r.status === 'rejected');
  const closed = new Set(ok.map((r) => r.item.number));
  data.items = data.items.filter((i) => !closed.has(i.number));
  selected = new Set([...selected].filter((n) => !closed.has(n)));
  render();
  if (ok.length) {
    toast(`Closed ${ok.length === 1 ? `#${ok[0].item.number}` : `${ok.length} items`}`, {
      undo: async () => {
        await Promise.allSettled(
          ok.map(async ({ item, commentId }) => {
            await gh(`/repos/${data.repo}/${item.type === 'pr' ? 'pulls' : 'issues'}/${item.number}`, { method: 'PATCH', body: JSON.stringify({ state: 'open' }) });
            if (commentId) await gh(`/repos/${data.repo}/issues/comments/${commentId}`, { method: 'DELETE' });
            data.items.push(item);
          })
        );
        render();
        toast('Reopened and removed the comment');
      },
    });
  }
  if (failed.length) toast(`Failed on ${failed.length}: ${failed[0].reason.message}`, { error: true });
}

function toast(msg, { undo, error } = {}) {
  const el = document.createElement('div');
  el.className = `toast${error ? ' error' : ''}`;
  el.innerHTML = `<span>${esc(msg)}</span>`;
  if (undo) {
    const b = document.createElement('button');
    b.textContent = 'Undo';
    b.onclick = () => { el.remove(); undo(); };
    el.append(b);
  }
  $('#toasts').append(el);
  setTimeout(() => el.remove(), undo ? 10000 : 5000);
}

// ---------- auth ----------

let me = null;
async function loadMe() {
  if (!getToken()) {
    me = null;
    $('#token-btn').textContent = 'Sign in';
    return;
  }
  try {
    me = await gh('/user');
    $('#token-btn').innerHTML = `<img class="avatar" src="${me.avatar_url}&s=40" alt=""> ${esc(me.login)}`;
  } catch (e) {
    me = null;
    $('#token-btn').textContent = 'Token invalid — sign in';
  }
}

function openTokenDialog() {
  $('#token-input').value = '';
  $('#token-error').textContent = '';
  $('#signout-btn').style.display = getToken() ? '' : 'none';
  $('#token-dialog').showModal();
}

$('#token-dialog').addEventListener('close', async () => {
  const v = $('#token-dialog').returnValue;
  if (v === 'signout') localStorage.removeItem('ghToken');
  if (v === 'save' && $('#token-input').value.trim()) localStorage.setItem('ghToken', $('#token-input').value.trim());
  await loadMe();
  render();
  if (v === 'save' && !me) {
    openTokenDialog();
    $('#token-error').textContent = 'That token was rejected by GitHub.';
  }
});

// ---------- data ----------

async function refresh(force = false) {
  if (force) await fetch('/api/refresh', { method: 'POST' });
  const res = await fetch('/api/items');
  const d = await res.json();
  data = d;
  // Keep optimistic bot state for anything we posted until the server catches up.
  for (const item of data.items) {
    if (postedThisSession.has(item.number) && !item.bot.lastCommand) {
      item.bot.lastCommand = { command: ACTIONS[item.type].command, by: me?.login, at: new Date().toISOString() };
    }
  }
  $('#repo-link').href = `https://github.com/${d.repo}`;
  const st = $('#sync-status');
  st.classList.toggle('error', !!d.syncError);
  st.textContent = d.syncError
    ? `Sync error: ${d.syncError.slice(0, 80)}`
    : d.syncing && !d.items.length
      ? 'Syncing…'
      : d.lastSync
        ? `Synced ${ago(d.lastSync)}${d.syncing ? ' · syncing…' : ''}`
        : '';
  render();
  if (!d.items.length || d.syncing) setTimeout(refresh, 4000);
}

// ---------- events ----------

document.addEventListener('click', (e) => {
  const t = e.target;
  // Before the label handler: severity commands render a label inside the button.
  const cmd = t.closest('[data-cmd]');
  if (cmd) return applyCommand(findCommand(cmd.dataset.cmd));
  const chip = t.closest('.AssigneeChip');
  if (chip) {
    e.preventDefault();
    const v = `user:${chip.dataset.assignee}`;
    filters.assignee = filters.assignee === v ? '' : v;
    filters.preset = '';
    shown = PAGE;
    return render();
  }
  const label = t.closest('.IssueLabel');
  if (label) {
    e.preventDefault();
    const name = label.dataset.label;
    const removing = t.dataset.remove || filters.include.includes(name) || filters.exclude.includes(name);
    filters.include = filters.include.filter((l) => l !== name);
    filters.exclude = filters.exclude.filter((l) => l !== name);
    if (!removing) (e.altKey ? filters.exclude : filters.include).push(name);
    filters.preset = '';
    shown = PAGE;
    return render();
  }
  const tab = t.closest('.tab');
  if (tab) {
    e.preventDefault();
    filters = { ...filters, tab: tab.dataset.tab, preset: 'all', include: [], exclude: [], checks: '', review: '', mergeable: '', linked: '', bot: '', waiting: '', idleDays: 0, verdict: '', staleDays: 0, newerThanDays: 0 };
    selected.clear();
    shown = PAGE;
    return render();
  }
  if (t.closest('#cmd-toggle')) {
    localStorage.setItem('commandsCollapsed', localStorage.getItem('commandsCollapsed') === '1' ? '0' : '1');
    return renderCommands();
  }
  const groupHead = t.closest('.facet-group h4');
  if (groupHead) {
    const g = groupHead.parentElement.dataset.group;
    collapsedGroups.has(g) ? collapsedGroups.delete(g) : collapsedGroups.add(g);
    localStorage.setItem('collapsedGroups', JSON.stringify([...collapsedGroups]));
    return renderFacets();
  }
  if (t.id === 'more-btn') { shown += PAGE; return render(); }
  if (t.id === 'clear-filters') { filters = { ...DEFAULT_FILTERS, tab: filters.tab, sort: filters.sort }; return render(); }
  const details = t.closest('[data-details]');
  if (details) {
    const n = Number(details.dataset.details);
    expanded.has(n) ? expanded.delete(n) : expanded.add(n);
    return render();
  }
  const applyBtn = t.closest('[data-apply-severity]');
  if (applyBtn) {
    applyBtn.disabled = true;
    return applySeverity(data.items.find((i) => i.number === Number(applyBtn.dataset.applySeverity)));
  }
  const actionBtn = t.closest('[data-action]');
  if (actionBtn) {
    const n = Number(actionBtn.dataset.action);
    if (postedThisSession.has(n)) return;
    actionBtn.disabled = true;
    actionBtn.textContent = 'Posting…';
    return postCommand([n]).finally(() => render());
  }
});

$('#list').addEventListener('change', (e) => {
  if (!e.target.classList.contains('row-check')) return;
  const n = Number(e.target.closest('.row').dataset.number);
  e.target.checked ? selected.add(n) : selected.delete(n);
  e.target.closest('.row').classList.toggle('selected', e.target.checked);
  updateBulk(sortItems(data.items.filter((i) => matches(i, filters))));
});

$('#select-all').addEventListener('change', (e) => {
  const visible = sortItems(data.items.filter((i) => matches(i, filters))).slice(0, shown);
  visible.forEach((i) => (e.target.checked ? selected.add(i.number) : selected.delete(i.number)));
  render();
});

$('#bulk-btn').addEventListener('click', () => {
  const action = ACTIONS[filters.tab];
  if (!confirm(`Post “${action.body}” on ${selected.size} ${filters.tab === 'pr' ? 'pull requests' : 'issues'}?`)) return;
  postCommand([...selected]);
});

let searchTimer;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { filters.q = e.target.value; shown = PAGE; render(); }, 120);
});
$('#facet-search').addEventListener('input', (e) => { facetQuery = e.target.value; renderFacets(); });

const bind = (id, key, parse = (v) => v) =>
  $(id).addEventListener('change', (e) => {
    filters[key] = parse(e.target.type === 'checkbox' ? e.target.checked : e.target.value);
    filters.preset = '';
    shown = PAGE;
    render();
  });
bind('#min-severity', 'minSeverity', Number);
bind('#include-unrated', 'includeUnrated');
bind('#sort', 'sort');
bind('#hide-drafts', 'hideDrafts');
bind('#checks', 'checks');
bind('#review', 'review');
bind('#mergeable', 'mergeable');
bind('#linked', 'linked');
bind('#bot-filter', 'bot');
bind('#assignee-filter', 'assignee');
bind('#waiting', 'waiting');
bind('#idle', 'idleDays', Number);
bind('#verdict', 'verdict');
$('#bulk-close-btn').addEventListener('click', openCloseDialog);

$('#refresh-btn').addEventListener('click', async () => {
  $('#refresh-btn').disabled = true;
  await refresh(true);
  setTimeout(() => { $('#refresh-btn').disabled = false; refresh(); }, 5000);
});
$('#token-btn').addEventListener('click', openTokenDialog);
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
    e.preventDefault();
    $('#search').focus();
  }
});
window.addEventListener('hashchange', () => { filters = readHash(); render(); });
darkMode.addEventListener('change', render);

loadMe().then(render);
refresh();
setInterval(refresh, 60_000);
