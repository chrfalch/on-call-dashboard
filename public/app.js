// Expo triage dashboard client.
import { MODES, PLATFORM_LABEL } from './inbox.js';
import { VIEWS, GROUPS, applyView, viewCounts } from './views.js';
import { CHIP_TIPS, OUTCOME_TEXT, OUTCOME_TIPS, STATE_TIPS, CLEANUP_TIPS, tooltip } from './tooltips.js';
import { weekTrend } from './trends.js';
import { dayKey, parseLog, addDone, doneCounts, weekDone } from './done-log.js';
import { isUnsupportedSdk, parseUnsupportedSdks, sdkLabels } from './sdk.js';
import { findItem, parseItemNumber } from './quick-open.js';
import { isOpen, STATES, STATE_CHIPS, CLEANUP_FILTERS, stateAction, cleanupAction, inboxRows, inboxCounts } from './states.js';

const $ = (sel) => document.querySelector(sel);
const PAGE = 100;
const ACTIONS = {
  pr: { command: 'review', body: '@expo-bot review', label: 'Request review', bulk: 'Request review' },
  issue: { command: 'verify', body: '@expo-bot verify', label: 'Verify', bulk: 'Verify' },
};
const TRIAGE = { command: 'triage', body: '@expo-bot triage', label: 'Triage', bulk: 'Triage' };

const DEFAULT_FILTERS = {
  tab: 'inbox',
  inboxMode: 'oncall',
  state: '',
  cleanup: '',
  inboxOthers: true,
  inboxHidden: false,
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
  view: '',
  hideUnsupportedSdks: true,
};
const KEPT_ON_CLEAR = ['tab', 'sort', 'hideUnsupportedSdks'];

let data = { items: [], labels: [] };
let filters = readHash();
let shown = PAGE;
let selected = new Set();
let facetQuery = '';
const collapsedGroups = new Set(JSON.parse(localStorage.getItem('collapsedGroups') || '["Package","SDK / RN","Upstream","Project","Other"]'));
// Stores the unsupported set, so a new SDK label starts out supported.
const unsupportedSdks = parseUnsupportedSdks(localStorage.getItem('unsupportedSdks'));

// ---------- runbook views ----------

// On-call focuses on external work; internal PRs stay listed, but quieter.
const QUIET_GROUPS = new Set(['internal']);

function activeView(f = filters) {
  return VIEWS.find((v) => v.id === f.view && v.scope === f.tab);
}

// A view replaces every filter except search, so selecting one starts from a clean slate.
function selectView(id) {
  filters = { ...DEFAULT_FILTERS, tab: filters.tab, sort: filters.sort, q: filters.q, hideUnsupportedSdks: filters.hideUnsupportedSdks, view: filters.view === id ? '' : id };
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
  // The Issues and PRs list pages are gone; old links with tab=issue|pr open the Inbox.
  f.tab = 'inbox';
  if (!activeView(f)) f.view = '';
  if (f.state && !STATE_CHIPS.some((state) => state.id === f.state)) f.state = '';
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
  const title = opts.title ?? tooltip(CHIP_TIPS.label, l.description || (opts.filterable === false ? 'GitHub label.' : CHIP_TIPS.label.meaning));
  return `<a class="IssueLabel${active}${excl}" style="${labelStyle(l.color)}" data-label="${esc(l.name)}" title="${esc(title)}">${esc(l.name)}${opts.removable ? ' <span class="chip-remove" data-remove="1">×</span>' : ''}</a>`;
}

function assigneeChipHtml(a, { filterable = true } = {}) {
  const active = filters.assignee === `user:${a.login}` ? ' active' : '';
  return `<a class="AssigneeChip${active}" data-assignee="${esc(a.login)}" ${tipAttr(CHIP_TIPS.assignee, `Assigned to ${a.login}${filterable ? ' — click to filter' : ''}`)}><img src="${a.avatarUrl}&s=32" alt="" loading="lazy">assigned: ${esc(a.login)}</a>`;
}

// ---------- helpers ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
const tipAttr = (tip, meaning) => `title="${esc(tooltip(tip, meaning))}"`;
// SVG elements ignore the title attribute; they take a <title> child instead.
const titled = (svg, tip) => svg.replace('>', `><title>${esc(tooltip(tip))}</title>`);
function ago(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [u, n] of units) if (s >= n) { const v = Math.floor(s / n); return `${v} ${u}${v > 1 ? 's' : ''} ago`; }
}
function labelGroup(name) {
  if (name.startsWith('severity:')) return 'Severity';
  if (PLATFORM_LABEL.test(name)) return 'Platform';
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
  bug: `<svg version="1.1" width="16" height="16" viewBox="0 0 16 16" class="octicon octicon-bug octicon" data-component="Octicon"><path d="M4.72.22a.75.75 0 0 1 1.06 0l1 .999a3.488 3.488 0 0 1 2.441 0l.999-1a.748.748 0 0 1 1.265.332.75.75 0 0 1-.205.729l-.775.776c.616.63.995 1.493.995 2.444v.327c0 .1-.009.197-.025.292.408.14.764.392 1.029.722l1.968-.787a.75.75 0 0 1 .556 1.392L13 7.258V9h2.25a.75.75 0 0 1 0 1.5H13v.5c0 .409-.049.806-.141 1.186l2.17.868a.75.75 0 0 1-.557 1.392l-2.184-.873A4.997 4.997 0 0 1 8 16a4.997 4.997 0 0 1-4.288-2.427l-2.183.873a.75.75 0 0 1-.558-1.392l2.17-.868A5.036 5.036 0 0 1 3 11v-.5H.75a.75.75 0 0 1 0-1.5H3V7.258L.971 6.446a.75.75 0 0 1 .558-1.392l1.967.787c.265-.33.62-.583 1.03-.722a1.677 1.677 0 0 1-.026-.292V4.5c0-.951.38-1.814.995-2.444L4.72 1.28a.75.75 0 0 1 0-1.06Zm.53 6.28a.75.75 0 0 0-.75.75V11a3.5 3.5 0 1 0 7 0V7.25a.75.75 0 0 0-.75-.75ZM6.173 5h3.654A.172.172 0 0 0 10 4.827V4.5a2 2 0 1 0-4 0v.327c0 .096.077.173.173.173Z"></path></svg>`,
  tag: `<svg version="1.1" width="16" height="16" viewBox="0 0 16 16" class="octicon octicon-tag octicon" data-component="Octicon"><path d="M1 7.775V2.75C1 1.784 1.784 1 2.75 1h5.025c.464 0 .91.184 1.238.513l6.25 6.25a1.75 1.75 0 0 1 0 2.474l-5.026 5.026a1.75 1.75 0 0 1-2.474 0l-6.25-6.25A1.752 1.752 0 0 1 1 7.775Zm1.5 0c0 .066.026.13.073.177l6.25 6.25a.25.25 0 0 0 .354 0l5.025-5.025a.25.25 0 0 0 0-.354l-6.25-6.25a.25.25 0 0 0-.177-.073H2.75a.25.25 0 0 0-.25.25ZM6 5a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z"></path></svg>`,
  trash: `<svg version="1.1" width="16" height="16" viewBox="0 0 16 16" class="octicon octicon-trash octicon" data-component="Octicon"><path d="M11 1.75V3h2.25a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75ZM4.496 6.675l.66 6.6a.25.25 0 0 0 .249.225h5.19a.25.25 0 0 0 .249-.225l.66-6.6a.75.75 0 0 1 1.492.149l-.66 6.6A1.748 1.748 0 0 1 10.595 15h-5.19a1.75 1.75 0 0 1-1.741-1.575l-.66-6.6a.75.75 0 1 1 1.492-.15ZM6.5 1.75V3h3V1.75a.25.25 0 0 0-.25-.25h-2.5a.25.25 0 0 0-.25.25Z"></path></svg>`,
  merge: `<svg version="1.1" width="16" height="16" viewBox="0 0 16 16" class="octicon octicon-git-merge octicon" data-component="Octicon"><path d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0 0 .005V3.25Z"></path></svg>`,
  eye: `<svg version="1.1" width="16" height="16" viewBox="0 0 16 16" class="octicon octicon-eye octicon" data-component="Octicon"><path d="M8 2c1.981 0 3.671.992 4.933 2.078 1.27 1.091 2.187 2.345 2.637 3.023a1.62 1.62 0 0 1 0 1.798c-.45.678-1.367 1.932-2.637 3.023C11.67 13.008 9.981 14 8 14c-1.981 0-3.671-.992-4.933-2.078C1.797 10.83.88 9.576.43 8.898a1.62 1.62 0 0 1 0-1.798c.45-.677 1.367-1.931 2.637-3.022C4.33 2.992 6.019 2 8 2ZM1.679 7.932a.12.12 0 0 0 0 .136c.411.622 1.241 1.75 2.366 2.717C5.176 11.758 6.527 12.5 8 12.5c1.473 0 2.825-.742 3.955-1.715 1.124-.967 1.954-2.096 2.366-2.717a.12.12 0 0 0 0-.136c-.412-.621-1.242-1.75-2.366-2.717C10.824 4.242 9.473 3.5 8 3.5c-1.473 0-2.825.742-3.955 1.715-1.124.967-1.954 2.096-2.366 2.717ZM8 10a2 2 0 1 1-.001-3.999A2 2 0 0 1 8 10Z"></path></svg>`,
  clock: `<svg version="1.1" width="16" height="16" viewBox="0 0 16 16" class="octicon octicon-clock octicon" data-component="Octicon"><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm7-3.25v2.992l2.028.812a.75.75 0 0 1-.557 1.392l-2.5-1A.751.751 0 0 1 7 8.25v-3.5a.75.75 0 0 1 1.5 0Z"></path></svg>`,
  alert: `<svg version="1.1" width="16" height="16" viewBox="0 0 16 16" class="octicon octicon-alert octicon" data-component="Octicon"><path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"></path></svg>`,
  reply: `<svg version="1.1" width="16" height="16" viewBox="0 0 16 16" class="octicon octicon-reply octicon" data-component="Octicon"><path d="M6.78 1.97a.75.75 0 0 1 0 1.06L3.81 6h6.44A4.75 4.75 0 0 1 15 10.75v2.5a.75.75 0 0 1-1.5 0v-2.5a3.25 3.25 0 0 0-3.25-3.25H3.81l2.97 2.97a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L1.47 7.28a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0Z"></path></svg>`,
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

function matchesQuery(item, query) {
  if (!query) return true;
  const q = query.toLowerCase().trim();
  const hay = `${item.title} ${item.author.login}`.toLowerCase();
  return String(item.number) === q.replace(/^#/, '') || q.split(/\s+/).every((w) => hay.includes(w));
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

// Every list and count reads this. Lookups and write actions keep using the full data.items.
function shownItems() {
  return data.items.filter((i) => isOpen(i) && (!filters.hideUnsupportedSdks || !isUnsupportedSdk(i, unsupportedSdks)));
}

function visibleItems() {
  const view = activeView();
  if (view) return applyView(view, shownItems().filter((i) => matchesQuery(i, filters.q)), { now: Date.now() });
  return sortItems(shownItems().filter((i) => matches(i, filters)));
}

// ---------- rendering ----------

function render() {
  writeHash();
  syncControls();
  const inInbox = filters.tab === 'inbox';
  $('#inbox').hidden = !inInbox;
  $('#browse').hidden = inInbox;
  renderInbox();
  renderSdkFilter();

  const visible = visibleItems();
  const tabCount = (type) => data.items.filter((i) => i.type === type && isOpen(i)).length;
  $('#count-issue').textContent = tabCount('issue');
  $('#count-pr').textContent = tabCount('pr');
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('selected', t.dataset.tab === filters.tab && t.dataset.mode === filters.inboxMode));
  if (inInbox) return;
  $('#pr-filters').hidden = filters.tab !== 'pr';

  renderViews();
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

function checksHtml(i) {
  if (i.checks === 'SUCCESS') return `<span class="status success" ${tipAttr(CHIP_TIPS.checks, 'Checks passing')}>${icons.check} checks</span>`;
  if (i.checks === 'FAILURE' || i.checks === 'ERROR') return `<span class="status failure" ${tipAttr(CHIP_TIPS.checks, 'Checks failing')}>${icons.x} checks</span>`;
  if (i.checks) return `<span class="status pending" ${tipAttr(CHIP_TIPS.checks, `Checks ${i.checks.toLowerCase()}`)}>${icons.dot} checks</span>`;
  return '';
}

const conflictsHtml = (i) => (i.mergeable === 'CONFLICTING' ? `<span class="status conflict" ${tipAttr(CHIP_TIPS.conflicts)}>Conflicts</span>` : '');
const diffstatHtml = (i) => `<span class="diffstat" ${tipAttr(CHIP_TIPS.diffstat)}><span class="add">+${i.additions}</span> <span class="del">−${i.deletions}</span></span>`;
const authorHtml = (i) => `<a href="https://github.com/${esc(i.author.login)}" target="_blank" rel="noreferrer">${esc(i.author.login)}</a>`;

function reviewerAvatars(i) {
  const seen = new Set();
  return (i.latestReviews || [])
    .filter((p) => p.login && !seen.has(p.login) && seen.add(p.login))
    .slice(0, 4)
    .map((p) => `<img class="avatar" src="${p.avatarUrl}&s=40" alt="${esc(p.login)}" title="Reviewed by ${esc(p.login)}" loading="lazy">`)
    .join('');
}

function itemParts(i, triageOpts) {
  const icon = i.type === 'pr' ? (i.isDraft ? titled(icons.draft, CHIP_TIPS.draftState) : titled(icons.pr, CHIP_TIPS.prState)) : titled(icons.issue, CHIP_TIPS.issueState);
  const meta = [`<a href="${i.url}" target="_blank" rel="noreferrer">#${i.number}</a> opened ${ago(i.createdAt)} by ${authorHtml(i)}`];
  meta.push(`<span class="sep">·</span> updated ${ago(i.updatedAt)}`);
  if (i.type === 'pr') {
    if (i.isDraft) meta.push(`<span class="status" ${tipAttr(CHIP_TIPS.draft)}>Draft</span>`);
    meta.push(checksHtml(i));
    if (i.reviewDecision === 'APPROVED') meta.push(`<span class="status approved" ${tipAttr(CHIP_TIPS.approved)}>${icons.check} Approved</span>`);
    else if (i.reviewDecision === 'CHANGES_REQUESTED') meta.push(`<span class="status changes" ${tipAttr(CHIP_TIPS.changesRequested)}>Changes requested</span>`);
    else if (i.reviewDecision === 'REVIEW_REQUIRED') meta.push(`<span class="status" ${tipAttr(CHIP_TIPS.reviewRequired)}>Review required</span>`);
    meta.push(conflictsHtml(i));
    for (const li of i.linkedIssues || []) {
      meta.push(`<a class="status" href="${li.url}" target="_blank" rel="noreferrer" ${tipAttr(CHIP_TIPS.linkedIssue, `Linked issue: ${li.title}`)}>${icons.issueSmall} #${li.number}</a>`);
    }
    meta.push(diffstatHtml(i));
  }
  if (i.thumbsUp) meta.push(`<span ${tipAttr(CHIP_TIPS.thumbsUp)}>👍 ${i.thumbsUp}</span>`);
  meta.push(waitingHtml(i));
  const c = i.bot.lastCommand;
  if (c) {
    const replied = i.bot.botRepliedAfterCommand;
    const outcome = replied && i.bot.lastBotReply.outcome ? ` · ${esc(i.bot.lastBotReply.outcome)}` : '';
    meta.push(
      `<span class="bot-status ${replied ? 'replied' : 'pending'}" ${tipAttr(
        CHIP_TIPS.botCommand,
        `Last @expo-bot command by ${c.by} ${ago(c.at)}${replied ? `; bot replied ${ago(i.bot.lastBotReply.at)}` : '; no bot reply yet'}`
      )}>${icons.bot} ${esc(c.command)} ${ago(c.at)}${replied ? ' ✓' + outcome : ' …'}</span>`
    );
  }
  const avatars = reviewerAvatars(i);
  const main = `<a class="row-title" href="${i.url}" target="_blank" rel="noreferrer">${esc(i.title)}</a>
      <span class="labels">${i.assignees.map(assigneeChipHtml).join('')}${i.labels.map((l) => labelHtml(l)).join('')}</span>
      <div class="meta">${meta.filter(Boolean).join(' ')}</div>
      ${triageHtml(i, triageOpts)}`;
  return { icon, main, avatars };
}

const TRIAGE_VIEWS = new Set(['issue:needs-bot-triage', 'pr:needs-bot-triage']);
const rowAction = (item) => (TRIAGE_VIEWS.has(filters.view) ? TRIAGE : ACTIONS[item.type]);

function rowHtml(i) {
  const action = rowAction(i);
  const { icon, main, avatars } = itemParts(i);
  const posted = isPosted(i.number, action);
  const isBusy = busy.has(i.number);
  return `<li class="row${selected.has(i.number) ? ' selected' : ''}${isBusy ? ' busy' : ''}" data-number="${i.number}">
    <input type="checkbox" class="row-check" ${selected.has(i.number) ? 'checked' : ''} />
    ${icon}
    <div class="row-main">${main}</div>
    <div class="row-side">
      <span class="avatars">${avatars}</span>
      <span class="comments-count" ${i.commentCount ? tipAttr(CHIP_TIPS.comments) : ''}>${i.commentCount ? `${icons.comment} ${i.commentCount}` : ''}</span>
      ${isBusy ? SPINNER : ''}
      <button class="btn btn-action${posted ? ' done' : ''}" data-action="${i.number}" title="Comment “${action.body}” on #${i.number}"${isBusy ? ' disabled' : ''}>${posted ? '✓ Requested' : action.label}</button>
    </div>
  </li>`;
}

function waitingHtml(i) {
  const c = i.conversation;
  if (!c || c.waitingOn === 'internal') return '';
  const days = Math.floor((Date.now() - new Date(c.since)) / 864e5);
  const dur = days < 1 ? 'today' : `${days}d`;
  const last = c.lastHuman ? `Last human comment by ${c.lastHuman.login} (${c.lastHuman.role}) ${ago(c.lastHuman.at)}` : 'No human comments yet';
  const title = tipAttr(CHIP_TIPS.waiting, last);
  if (c.waitingOn === 'reporter') return `<span class="waiting reporter" ${title}>${icons.clock} waiting on ${i.type === 'pr' ? 'author' : 'reporter'} · ${dur}</span>`;
  if (!c.teamReplied) return `<span class="waiting never" ${title}>${icons.alert} no team reply yet · ${dur}</span>`;
  return `<span class="waiting team" ${title}>${icons.reply} we owe a reply · ${dur}</span>`;
}

function severityMismatch(item) {
  const s = item.triage?.assessment?.severity;
  return !!s && !item.labels.some((l) => l.name === s.label);
}

const expanded = new Set();

// brief: the Inbox row, where the state's button applies severity and the summary waits for recommendations.
function triageHtml(i, { fixPrs = true, brief = false } = {}) {
  const t = i.triage;
  if (!t) return '';
  const a = t.assessment;
  const v = t.verification;
  const parts = [];
  if (a) {
    let sev = '';
    if (a.severity) {
      const color = data.labels.find((l) => l.name === a.severity.label)?.color;
      sev = ` · suggests ${labelHtml({ name: a.severity.label, color }, { title: tooltip(CHIP_TIPS.suggestedSeverity) })}`;
      if (!brief && severityMismatch(i)) sev += ` <button class="btn btn-xs" data-apply-severity="${i.number}" title="Replace the current severity label with ${esc(a.severity.label)}">Apply</button>`;
    }
    parts.push(`<span ${tipAttr(CHIP_TIPS.assessment)}>${icons.bot} <a href="${a.url}" target="_blank" rel="noreferrer">${esc(a.kind ?? 'Assessed')}${a.confidence != null ? ` · ${a.confidence}%` : ''}</a>${sev}</span>`);
  }
  if (v) {
    parts.push(
      `<a href="${v.url}" target="_blank" rel="noreferrer" class="verdict ${esc(v.outcome)}" ${tipAttr(OUTCOME_TIPS[v.outcome] ?? CHIP_TIPS.verdict)}>Verified · ${esc(OUTCOME_TEXT[v.outcome] ?? v.outcome)}</a>` +
        (v.headline && !brief ? `<span class="verdict-headline" ${tipAttr(CHIP_TIPS.verdictHeadline, v.headline)}>${esc(v.headline[0].toUpperCase() + v.headline.slice(1))}</span>` : '')
    );
  }
  if (fixPrs) for (const n of t.fixPrs) parts.push(`<a href="https://github.com/${data.repo}/pull/${n}" target="_blank" rel="noreferrer" ${tipAttr(CHIP_TIPS.fixPr)}>🔧 fix PR #${n}</a>`);
  const hasDetails = !brief && (a?.impact || a?.scope || v?.maintainer || v?.reporter);
  if (!parts.length && !hasDetails) return '';
  if (hasDetails) parts.push(`<button class="details-toggle" data-details="${i.number}" ${tipAttr(CHIP_TIPS.details)}>${expanded.has(i.number) ? 'hide details ▴' : 'details ▾'}</button>`);
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

function renderViews() {
  const collapsed = localStorage.getItem('commandsCollapsed') === '1';
  const counts = viewCounts(shownItems(), { now: Date.now() });
  const cards = GROUPS[filters.tab]
    .map((group) => {
      const buttons = VIEWS.filter((v) => v.scope === filters.tab && v.group === group.id)
        .map((v) => {
          const n = counts[v.id];
          const active = filters.view === v.id;
          return `<button class="cmd${active ? ' selected' : ''}${n ? '' : ' zero'}" data-view="${v.id}" aria-pressed="${active}" ${tipAttr(CHIP_TIPS.view, `${v.step}\n${v.hint}`)}>
            <span class="cmd-name">${esc(v.name)}</span><span class="cmd-audience">${esc(v.audience)}</span><span class="cmd-count">${n}</span>
          </button>`;
        })
        .join('');
      return `<div class="cmd-card${QUIET_GROUPS.has(group.id) ? ' quiet' : ''}"><h4>${esc(group.title)}</h4>${buttons}</div>`;
    })
    .join('');
  $('#presets').innerHTML = `<div class="cmd-header">
      <button class="cmd-toggle" id="cmd-toggle">${collapsed ? '▸' : '▾'} Runbook</button>
      <span class="muted">Each view is one runbook step with its own filter and order. Click it again to see all items.</span>
    </div>
    ${collapsed ? '' : `<div class="cmd-grid">${cards}</div>`}`;
}

function renderActiveFilters() {
  const view = activeView();
  if (view) {
    $('#active-filters').innerHTML = `<span class="muted"><strong>${esc(view.name)}</strong> sets the filter and the order. Search still applies.</span>
      <button class="clear-link" data-view="${view.id}">✕ Clear view</button>`;
    return;
  }
  const colorOf = Object.fromEntries(data.labels.map((l) => [l.name, l.color]));
  const chips = [
    ...filters.include.map((n) => labelHtml({ name: n, color: colorOf[n] }, { removable: true })),
    ...filters.exclude.map((n) => labelHtml({ name: n, color: colorOf[n] }, { removable: true })),
  ];
  const filterTip = tipAttr(CHIP_TIPS.activeFilter);
  if (filters.newerThanDays) chips.push(`<span class="muted" ${filterTip}>created in last ${filters.newerThanDays}d</span>`);
  if (filters.staleDays) chips.push(`<span class="muted" ${filterTip}>no activity for ${filters.staleDays}d+</span>`);
  if (filters.minSeverity === -1) chips.push(`<span class="muted" ${filterTip}>no severity label</span>`);
  $('#active-filters').innerHTML = chips.length || isFiltered() ? chips.join('') + `<button class="clear-link" id="clear-filters">✕ Clear filters</button>` : '';
}

function isFiltered() {
  return Object.entries(DEFAULT_FILTERS).some(([k, v]) => !KEPT_ON_CLEAR.includes(k) && JSON.stringify(filters[k]) !== JSON.stringify(v));
}

function renderFacets() {
  // Counts are computed against the current filters *except* labels, plus the
  // currently-included labels, so they show how many results each label would leave.
  const base = shownItems().filter((i) => matches(i, filters, { ignoreLabels: true }));
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
        <h4 ${tipAttr(CHIP_TIPS.labelGroup)}><span>${esc(g)}</span><span>${collapsed ? '▸' : '▾'} ${ls.length}</span></h4>
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
  const viewActive = !!activeView();
  for (const control of document.querySelectorAll(':is(.filter-bar, .pr-filters, .common-filters) :is(select, input[type="checkbox"])')) control.disabled = viewActive;
  $('.sidebar').inert = viewActive;
}

function renderAssigneeOptions() {
  const counts = new Map();
  for (const i of shownItems()) if (i.type === filters.tab) for (const a of i.assignees) counts.set(a.login, (counts.get(a.login) || 0) + 1);
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

let sdkListHtml = '';
function renderSdkFilter() {
  $('#hide-unsupported-sdks').checked = filters.hideUnsupportedSdks;
  const colorOf = Object.fromEntries(data.labels.map((l) => [l.name, l.color]));
  const names = sdkLabels(data.labels);
  const html = names.length
    ? names
        .map(
          (name) =>
            `<label class="sdk-option"><input type="checkbox" value="${esc(name)}"${unsupportedSdks.has(name) ? '' : ' checked'} /><span class="sdk-label" style="${labelStyle(colorOf[name])}">${esc(name)}</span></label>`
        )
        .join('')
    : '<p class="muted">No SDK labels yet.</p>';
  // Rebuilding on every render would drop keyboard focus inside the open menu.
  if (html !== sdkListHtml) $('#sdk-list').innerHTML = sdkListHtml = html;
}

function updateBulk(visible) {
  for (const [id, action] of [['#bulk-btn', ACTIONS[filters.tab]], ['#bulk-triage-btn', TRIAGE]]) {
    const btn = $(id);
    btn.disabled = !selected.size;
    btn.textContent = selected.size ? `${action.bulk} (${selected.size})` : `${action.bulk} — select items`;
  }
  $('#bulk-close-btn').disabled = !selected.size;
  $('#bulk-close-btn').textContent = selected.size ? `Close… (${selected.size})` : 'Close…';
  const sa = $('#select-all');
  const pageNums = visible.slice(0, shown).map((i) => i.number);
  sa.checked = pageNums.length > 0 && pageNums.every((n) => selected.has(n));
  sa.indeterminate = !sa.checked && pageNums.some((n) => selected.has(n));
}

// ---------- GitHub actions (run in the browser with the user's own token) ----------

// One entry per item and command, so posting triage does not mark the item's verify or review as requested.
const postedThisSession = new Map(); // `${number}:${command}` -> { number, command, commentId, at }
const postedKey = (number, action) => `${number}:${action.command}`;
const isPosted = (number, action) => postedThisSession.has(postedKey(number, action));
const closedThisSession = new Map(); // item number -> closedAt, until the server sync sees the close
const markClosed = (item, closedAt) => Object.assign(item, { state: 'CLOSED', closedAt });
const busy = new Set(); // item numbers with a GitHub write in flight
const SPINNER = '<span class="spinner" role="status" aria-label="Working"></span>';

async function whileBusy(numbers, fn) {
  numbers.forEach((n) => busy.add(n));
  render();
  try {
    return await fn();
  } finally {
    numbers.forEach((n) => busy.delete(n));
    render();
  }
}

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

// `action` defaults to the item type's own command, so one call can mix issues and PRs.
async function postCommand(numbers, action = null) {
  if (!getToken()) {
    openTokenDialog();
    return;
  }
  const found = numbers.map((n) => data.items.find((i) => i.number === n)).filter(Boolean);
  // The comments are public, so a second click or bulk post must not repeat one.
  const items = found.filter((item) => !isPosted(item.number, action ?? ACTIONS[item.type]));
  if (items.length < found.length) toast(`Already posted on ${found.length - items.length} of the selected items this session, skipped`);
  const results = await whileBusy(items.map((i) => i.number), () => Promise.allSettled(
    items.map(async (item) => {
      const posted = action ?? ACTIONS[item.type];
      const comment = await gh(`/repos/${data.repo}/issues/${item.number}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body: posted.body }),
      });
      // GitHub's own timestamp, so refresh() can compare it with the synced lastCommand.at.
      const at = comment.created_at;
      postedThisSession.set(postedKey(item.number, posted), { number: item.number, command: posted.command, commentId: comment.id, at });
      const lastCommand = { command: posted.command, by: me?.login, at };
      item.bot = {
        ...item.bot,
        lastCommand,
        botRepliedAfterCommand: false,
        ...(posted.command === 'review' && { lastReview: lastCommand, botRepliedAfterReview: false }),
      };
      return { item, action: posted };
    })
  ));
  const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  const failed = results.filter((r) => r.status === 'rejected');
  selected = new Set([...selected].filter((n) => !ok.some((p) => p.item.number === n)));
  render();
  if (ok.length) {
    toast(
      ok.length === 1 ? `Posted “${ok[0].action.body}” on #${ok[0].item.number}` : `Posted on ${ok.length} items`,
      { undo: () => undo(ok) }
    );
  }
  if (failed.length) toast(`Failed on ${failed.length}: ${failed[0].reason.message}`, { error: true });
}

async function undo(posts) {
  await Promise.allSettled(
    posts.map(async ({ item, action }) => {
      const key = postedKey(item.number, action);
      const entry = postedThisSession.get(key);
      if (!entry) return;
      await gh(`/repos/${data.repo}/issues/comments/${entry.commentId}`, { method: 'DELETE' });
      postedThisSession.delete(key);
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
    await whileBusy([item.number], async () => {
      await gh(`/repos/${data.repo}/issues/${item.number}/labels`, { method: 'POST', body: JSON.stringify({ labels: [target] }) });
      for (const l of removed) await gh(`/repos/${data.repo}/issues/${item.number}/labels/${enc(l.name)}`, { method: 'DELETE' });
    });
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
    {
      name: 'Unsupported SDK',
      reason: 'not_planned',
      body: 'This was reported on an Expo SDK version that we no longer support. Please check if it still happens on a supported SDK version, and open a new issue with a minimal reproduction if it does. Thanks!',
    },
    { name: 'Custom…', reason: 'not_planned', body: '' },
  ],
  pr: [
    { name: 'Stale / no response', reason: 'not_planned', body: "Closing this since there hasn't been activity in a while. Feel free to reopen or open a new PR if you'd like to pick it back up. Thanks for the contribution!" },
    {
      name: 'Unsupported SDK',
      reason: 'not_planned',
      body: 'This targets an Expo SDK version that we no longer support. If the change is still needed, please open a new PR against the main branch. Thanks for the contribution!',
    },
    { name: 'Custom…', reason: 'not_planned', body: '' },
  ],
};

// `draft` ({ body, reason }) starts from the Custom… template, and `template` (a template name) from that
// template, instead of the first one.
function openCloseDialog(type = filters.tab, draft, template) {
  if (!requireToken()) return;
  const tpls = CLOSE_TEMPLATES[type];
  const sel = $('#close-template');
  sel.innerHTML = tpls.map((t, idx) => `<option value="${idx}">${esc(t.name)}</option>`).join('');
  const pick = (t = tpls[Number(sel.value)]) => {
    $('#close-body').value = t.body;
    $('#close-reason').value = t.reason;
  };
  sel.onchange = () => pick();
  if (draft) sel.value = String(tpls.findIndex((t) => !t.body));
  else if (template) sel.value = String(tpls.findIndex((t) => t.name === template));
  pick(draft);
  $('#close-reason').querySelector('[value=duplicate]').disabled = type === 'pr';
  $('#close-title').textContent = `Comment & close ${selected.size} ${type === 'pr' ? 'pull request' : 'issue'}${selected.size === 1 ? '' : 's'}`;
  // Escape closes without a button, which would keep the previous returnValue and close the items.
  $('#close-dialog').returnValue = '';
  $('#close-dialog').showModal();
}

$('#close-dialog').addEventListener('close', () => {
  if ($('#close-dialog').returnValue !== 'close') return;
  closeItems([...selected], $('#close-body').value.trim(), $('#close-reason').value);
});

async function closeItems(numbers, body, reason) {
  const items = numbers.map((n) => data.items.find((i) => i.number === n)).filter(Boolean);
  const results = await whileBusy(numbers, () => Promise.allSettled(
    items.map(async (item) => {
      const comment = body
        ? await gh(`/repos/${data.repo}/issues/${item.number}/comments`, { method: 'POST', body: JSON.stringify({ body }) })
        : null;
      const patch = item.type === 'pr' ? { state: 'closed' } : { state: 'closed', state_reason: reason };
      await gh(`/repos/${data.repo}/${item.type === 'pr' ? 'pulls' : 'issues'}/${item.number}`, { method: 'PATCH', body: JSON.stringify(patch) });
      return { item, commentId: comment?.id };
    })
  ));
  const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  const failed = results.filter((r) => r.status === 'rejected');
  if (filters.tab === 'inbox' && ok.length) recordDone(ok.map((r) => r.item));
  const closedAt = new Date().toISOString();
  for (const { item } of ok) {
    markClosed(item, closedAt);
    closedThisSession.set(item.number, closedAt);
  }
  const closed = new Set(ok.map((r) => r.item.number));
  selected = new Set([...selected].filter((n) => !closed.has(n)));
  render();
  if (ok.length) {
    refreshAfterSync();
    toast(`Closed ${ok.length === 1 ? `#${ok[0].item.number}` : `${ok.length} items`}`, {
      undo: async () => {
        await Promise.allSettled(
          ok.map(async ({ item, commentId }) => {
            await gh(`/repos/${data.repo}/${item.type === 'pr' ? 'pulls' : 'issues'}/${item.number}`, { method: 'PATCH', body: JSON.stringify({ state: 'open' }) });
            closedThisSession.delete(item.number);
            const current = data.items.find((i) => i.number === item.number);
            if (current) Object.assign(current, { state: 'OPEN', closedAt: null });
            if (commentId) await gh(`/repos/${data.repo}/issues/comments/${commentId}`, { method: 'DELETE' });
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
  $('#token-btn').title = '';
  if (!getToken()) {
    me = null;
    $('#token-btn').textContent = 'Sign in';
    return;
  }
  try {
    me = await gh('/user');
    $('#token-btn').innerHTML = `<img class="avatar" src="${me.avatar_url}&s=40" alt=""> ${esc(me.login)}`;
    $('#token-btn').title = tooltip(CHIP_TIPS.signedIn);
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

// For after a write to GitHub: the server re-syncs first, so the list includes the change.
async function refreshAfterSync() {
  try {
    await fetch('/api/refresh?wait=1', { method: 'POST' });
  } catch {}
  await refresh().catch(() => {});
}

async function refresh(force = false) {
  if (force) await fetch('/api/refresh', { method: 'POST' });
  loadTrends();
  const res = await fetch('/api/items');
  const d = await res.json();
  data = d;
  for (const [number, closedAt] of closedThisSession) {
    const item = data.items.find((i) => i.number === number);
    if (item && isOpen(item)) markClosed(item, closedAt);
    else closedThisSession.delete(number);
  }
  // Keep optimistic bot state for anything we posted until the server catches up.
  for (const { number, command, at } of postedThisSession.values()) {
    const item = data.items.find((i) => i.number === number);
    if (!item) continue;
    const posted = { command, by: me?.login, at };
    if (!item.bot.lastCommand || item.bot.lastCommand.at < at) {
      item.bot.lastCommand = posted;
      item.bot.botRepliedAfterCommand = false;
    }
    if (command === 'review' && (!item.bot.lastReview || item.bot.lastReview.at < at)) {
      item.bot.lastReview = posted;
      item.bot.botRepliedAfterReview = false;
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

// ---------- trend tiles ----------

const TREND_TIP = tooltip({
  meaning: 'Opened and closed in expo/expo since Monday 00:00 (your local time). PRs closed includes merged.',
  source: 'GitHub search, refreshed after each sync',
});
const TREND_ARROWS = { up: '▲', down: '▼', flat: '■' };
let trends = null;
let trendsRequest = 0;

// Calls overlap (60 s timer, sync poll, refresh button): only the newest response may
// replace the data, and a failure keeps the last good data.
async function loadTrends() {
  const request = ++trendsRequest;
  try {
    const res = await fetch('/api/trends');
    const data = res.ok ? await res.json() : null;
    if (data && request === trendsRequest) trends = data;
  } catch {}
  renderTrends();
}

function renderTrends() {
  const now = new Date();
  const week = (key) => (trends?.fetchedAt && Array.isArray(trends[key]) ? weekTrend(trends[key], now) : null);
  $('#trends').innerHTML = trendTile('Issues', week('issues')) + trendTile('Pull requests', week('pullRequests'));
}

function trendTile(title, week) {
  const head = `<div class="trend-tile${week ? '' : ' trend-empty'}" title="${esc(TREND_TIP)}"><div class="trend-title">${esc(title)}</div>`;
  if (!week) return `${head}<p>No trend data yet</p></div>`;
  const { net, direction, opened, closed } = week;
  const signed = net > 0 ? `+${net}` : net < 0 ? `−${-net}` : '0';
  return `${head}
    <div class="trend-net trend-${direction}"><span aria-hidden="true">${TREND_ARROWS[direction]}</span> ${signed}</div>
    <div class="trend-caption">this week</div>
    <div class="trend-caption"><span class="trend-swatch trend-opened" aria-hidden="true"></span>opened ${opened} · <span class="trend-swatch trend-closed" aria-hidden="true"></span>closed ${closed}</div>
    ${trendChart(week.days, ['opened', 'closed'], `Opened ${opened} and closed ${closed} since Monday`)}
  </div>`;
}

function trendChart(days, keys, label) {
  const [width, height, pad] = [100, 50, 3];
  const max = Math.max(1, ...days.flatMap((day) => keys.map((key) => day[key])));
  const x = (i) => (days.length > 1 ? pad + (i * (width - 2 * pad)) / (days.length - 1) : width / 2);
  const y = (count) => height - pad - (count * (height - 2 * pad)) / max;
  // Markers on every day keep a single-day week (Monday) visible, where a polyline draws nothing.
  const series = (key) => {
    const points = days.map((day, i) => [+x(i).toFixed(1), +y(day[key]).toFixed(1)]);
    return `<g class="trend-${key}"><polyline points="${points.map((p) => p.join(',')).join(' ')}"/>${points.map(([cx, cy]) => `<circle cx="${cx}" cy="${cy}" r="1.6"/>`).join('')}</g>`;
  };
  return `<svg class="trend-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}">
    <line class="trend-axis" x1="0" x2="${width}" y1="${height - pad}" y2="${height - pad}"/>${keys.map(series).join('')}
  </svg>`;
}


// ---------- triage inbox ----------

const inboxState = JSON.parse(localStorage.getItem('inboxState') || '{}');
let inboxShown = 25;
let inboxFocus = 0;
let inboxVisible = [];
const rowHidden = (row) => !!inboxState[row.key]?.doneAt;

function saveInboxState() {
  // Forget entries older than 30 days so localStorage doesn't grow forever.
  const cutoff = Date.now() - 30 * 864e5;
  for (const [k, v] of Object.entries(inboxState)) if ((v.doneAt ?? v.snoozedAt ?? 0) < cutoff) delete inboxState[k];
  localStorage.setItem('inboxState', JSON.stringify(inboxState));
}

function recordDone(items) {
  const key = dayKey(new Date());
  const log = parseLog(localStorage.getItem(key));
  localStorage.setItem(key, JSON.stringify(addDone(log, items)));
}

function markDone(task) {
  inboxState[task.key] = { doneAt: Date.now(), updatedAt: task.item.updatedAt };
  recordDone([task.item]);
  saveInboxState();
  render();
  refreshAfterSync();
}

function renderInbox() {
  const mode = filters.inboxMode;
  const now = Date.now();
  const hidden = (key) => rowHidden({ key });
  const options = { now, me: me?.login, mode, includeAssigned: filters.inboxOthers, unsupportedSdks, hideUnsupported: filters.hideUnsupportedSdks };
  if (filters.tab !== 'inbox') return;

  $('#inbox-title').textContent = mode === 'mine' ? 'My Work' : 'On-call inbox';
  $('#inbox-mode-desc').textContent = MODES[mode];
  $('#inbox-others-wrap').hidden = mode !== 'oncall';

  const items = data.items;
  const visibleOptions = { ...options, hidden: filters.inboxHidden ? undefined : hidden };
  const counts = inboxCounts(items, visibleOptions);
  const chips = (defs, key, tips, separator = '') => defs.map((def) => {
    const count = counts[key === 'state' ? 'states' : 'cleanup'][def.id] ?? 0;
    return `<button class="kind-chip${def.tone ? ` tone-${esc(def.tone)}` : ''}${count ? '' : ' is-empty'}${filters[key] === def.id ? ' selected' : ''}" data-inbox-${key}="${def.id}" ${tipAttr(tips[def.id])}>${def.icon ? icons[def.icon] : ''}${key === 'state' ? '' : `${esc(def.id)} `}${esc(def.label)} <span class="counter">${count}</span></button>`;
  }).join(separator);
  const flowArrow = '<span class="flow-arrow" aria-hidden="true">→</span>';
  $('#inbox-issue-states').innerHTML = chips(STATE_CHIPS.filter((state) => state.track === 'issue'), 'state', STATE_TIPS, flowArrow);
  $('#inbox-pr-states').innerHTML = chips(STATE_CHIPS.filter((state) => state.track === 'pr'), 'state', STATE_TIPS, flowArrow);
  $('#inbox-cleanup').innerHTML = `<h3 class="trend-title">Cleanup</h3><div class="inbox-kinds">${chips(CLEANUP_FILTERS, 'cleanup', CLEANUP_TIPS)}</div>`;
  $('#inbox-others').checked = filters.inboxOthers;
  $('#inbox-hidden').checked = filters.inboxHidden;

  inboxVisible = inboxRows(items, { ...visibleOptions, stateId: filters.state, cleanupId: filters.cleanup });
  inboxFocus = Math.min(inboxFocus, Math.max(0, inboxVisible.length - 1));
  const done = doneCounts(parseLog(localStorage.getItem(dayKey(new Date()))));
  const doneDays = weekDone((date) => parseLog(localStorage.getItem(dayKey(date))), new Date());
  $('#inbox-progress').innerHTML = `<div class="trend-title">Inbox</div>
    <div class="trend-net">${done.total}</div>
    <div class="trend-caption">done today</div>
    <div class="trend-caption">${done.issues} issues · ${done.prs} PRs</div>
    ${trendChart(doneDays, ['done'], `Done per day since Monday: ${doneDays.map((d) => d.done).join(', ')}`)}`;

  $('#inbox-list').innerHTML = inboxVisible.length
    ? inboxVisible.slice(0, inboxShown).map((t, idx) => taskHtml(t, idx)).join('')
    : `<li class="empty">${
        !data.items.length ? 'Loading from GitHub…' : mode === 'mine' && !me ? 'Sign in to see the items assigned to you.' : 'Inbox zero 🎉 Nothing left in this view.'
      }</li>`;
  $('#inbox-more').innerHTML =
    inboxVisible.length > inboxShown ? `<button class="btn btn-sm" id="inbox-more-btn">Show 25 more (${inboxVisible.length - inboxShown} remaining)</button>` : '';
}

const taskAction = (t) => filters.cleanup ? cleanupAction(t.item, filters.cleanup) : stateAction(t.item, t.stateId, { now: Date.now() });
const taskCommand = (action) => ({ ...action, command: action.body.match(/@expo-bot\s+(\S+)/)?.[1] });

function taskActionButton(t) {
  const action = taskAction(t);
  if (!action) return '';
  if (action.kind === 'open') return `<a class="btn btn-sm btn-main" href="${esc(action.url ?? t.item.url)}" target="_blank" rel="noreferrer">${esc(action.label)} ↗</a>`;
  const posted = action.kind === 'command' && isPosted(t.item.number, taskCommand(action));
  return `<button class="btn btn-sm ${action.kind === 'close' ? 'btn-danger' : 'btn-main'}" data-task-do="${esc(t.key)}"${posted ? ' disabled' : ''}>${posted ? '✓ Requested' : esc(action.label)}</button>`;
}

function inboxMeta(i) {
  const meta = [`opened ${ago(i.createdAt)} by ${authorHtml(i)}`, `<span class="sep">·</span> updated ${ago(i.updatedAt)}`];
  if (i.type === 'pr') meta.push(checksHtml(i), conflictsHtml(i), diffstatHtml(i), `<span class="avatars">${reviewerAvatars(i)}</span>`);
  else if (i.thumbsUp) meta.push(`<span ${tipAttr(CHIP_TIPS.thumbsUp)}>👍 ${i.thumbsUp}</span>`);
  meta.push(waitingHtml(i));
  return meta;
}

function taskHtml(t, idx) {
  const item = t.item;
  const def = STATES.find((state) => state.id === t.stateId);
  const icon = item.type === 'pr' ? icons.pr : icons.issue;
  const links = item.type === 'issue' ? (item.linkedPrs ?? []).filter((pr) => pr.fix === true) : item.fixedIssues ?? [];
  const fixes = links.map((link) => `<a class="fix-pr" href="${esc(link.url ?? `https://github.com/${data.repo}/${item.type === 'issue' ? 'pull' : 'issues'}/${link.number}`)}" target="_blank" rel="noreferrer">#${esc(link.number)}</a>`).join(' ');
  const cleanup = t.cleanup.map((id) => `<span class="reason" ${tipAttr(CLEANUP_TIPS[id])}>${esc(CLEANUP_FILTERS.find((filter) => filter.id === id).label)}</span>`).join('');
  const hidden = rowHidden(t);
  const isBusy = busy.has(item.number);
  return `<li class="task${idx === inboxFocus ? ' focused' : ''}${hidden ? ' is-hidden' : ''}${isBusy ? ' busy' : ''}" data-task="${esc(t.key)}">
    <div class="task-rank">${icon}</div>
    <div class="task-body">
      <div class="task-head">
        <span class="kind-badge tone-${esc(def.tone)}" ${tipAttr(STATE_TIPS[t.stateId])}>${icons[def.icon]}${esc(def.label)}</span>
        <a class="row-title" href="${esc(item.url)}" target="_blank" rel="noreferrer">#${esc(item.number)} ${esc(item.title)}</a>
        ${cleanup}
        ${fixes ? `<span class="muted">${item.type === 'issue' ? 'Fix PRs' : 'Fixes'}</span> ${fixes}` : ''}
      </div>
      <div class="row-main">
        <div class="meta">${inboxMeta(item).filter(Boolean).join(' ')}</div>
        <div class="task-labels">${item.assignees.map((a) => assigneeChipHtml(a, { filterable: false })).join('')}${item.labels.map((l) => labelHtml(l, { filterable: false })).join('')}</div>
        ${item.type === 'issue' ? triageHtml(item, { fixPrs: false, brief: true }) : ''}
      </div>
    </div>
    <div class="task-actions">
      ${isBusy ? SPINNER : ''}
      <div class="task-secondary">
        ${taskActionButton(t)}
        ${isOpen(item) && taskAction(t)?.kind !== 'close' ? `<button class="btn btn-sm btn-danger" data-task-close="${esc(t.key)}">Close…</button>` : ''}
      </div>
      <div class="task-secondary">
        ${isOpen(item) ? `<button class="btn btn-sm" data-task-bot="${esc(t.key)}" title="Write a comment; it starts with @expo-bot">${icons.bot}Comment</button>` : ''}
        <button class="btn btn-sm" data-task-done="${esc(t.key)}" title="I did what this row asks; hide it until its state changes">✓ Done</button>
      </div>
    </div>
  </li>`;
}

function findTask(key) {
  return inboxVisible.find((t) => t.key === key);
}

async function doTask(t) {
  if (!t || busy.has(t.item.number)) return;
  const action = taskAction(t);
  if (!action) return;
  if (action.kind === 'command') {
    if (!requireToken()) return;
    const command = taskCommand(action);
    await postCommand([t.item.number], command);
    if (isPosted(t.item.number, command)) markDone(t);
  } else if (action.kind === 'apply-severity') {
    await applySeverity(t.item);
    if (!severityMismatch(t.item)) markDone(t);
  } else if (action.kind === 'close') {
    selected = new Set([t.item.number]);
    openCloseDialog(t.item.type, undefined, filters.cleanup === 'C4' ? 'Unsupported SDK' : undefined);
  } else if (action.kind === 'nudge') {
    openCommentDialog(t.item, `Hi @${t.item.author.login}, would you be able to address the requested changes? Thanks!`);
  } else if (action.kind === 'comment') {
    openCommentDialog(t.item, action.body);
  } else {
    window.open(action.url ?? t.item.url, '_blank', 'noopener');
  }
}

function inboxClick(e) {
  const t = e.target;
  const state = t.closest('[data-inbox-state]');
  if (state) { filters.state = filters.state === state.dataset.inboxState ? '' : state.dataset.inboxState; filters.cleanup = ''; inboxShown = 25; return render(); }
  const cleanup = t.closest('[data-inbox-cleanup]');
  if (cleanup) { filters.cleanup = filters.cleanup === cleanup.dataset.inboxCleanup ? '' : cleanup.dataset.inboxCleanup; filters.state = ''; inboxShown = 25; return render(); }
  if (t.id === 'inbox-more-btn') { inboxShown += 25; return render(); }
  const done = t.closest('[data-task-done]');
  if (done) return markDone(findTask(done.dataset.taskDone));
  const close = t.closest('[data-task-close]');
  if (close) {
    const task = findTask(close.dataset.taskClose);
    if (!task || !isOpen(task.item) || busy.has(task.item.number)) return;
    selected = new Set([task.item.number]);
    return openCloseDialog(task.item.type);
  }
  const bot = t.closest('[data-task-bot]');
  if (bot) {
    const task = findTask(bot.dataset.taskBot);
    return task && openCommentDialog(task.item, '@expo-bot ');
  }
  const go = t.closest('[data-task-do]');
  if (go) return doTask(findTask(go.dataset.taskDo));
  const row = t.closest('[data-task]');
  if (row && !t.closest('a, button')) {
    inboxFocus = inboxVisible.findIndex((x) => x.key === row.dataset.task);
    document.querySelectorAll('.task').forEach((el, idx) => el.classList.toggle('focused', idx === inboxFocus));
  }
}

let commentItem = null;

function openCommentDialog(item, body) {
  if (!requireToken()) return;
  commentItem = item;
  $('#comment-title').textContent = `Comment on #${item.number}`;
  $('#comment-body').value = body;
  // Escape closes without a button, which would keep the previous returnValue.
  $('#comment-dialog').returnValue = '';
  $('#comment-dialog').showModal();
}

$('#comment-dialog').addEventListener('close', () => {
  if ($('#comment-dialog').returnValue === 'send') postComment(commentItem, $('#comment-body').value.trim());
});

async function postComment(item, body) {
  if (!body) return;
  let comment;
  try {
    comment = await whileBusy([item.number], () => gh(`/repos/${data.repo}/issues/${item.number}/comments`, { method: 'POST', body: JSON.stringify({ body }) }));
  } catch (e) {
    return toast(`Couldn't comment on #${item.number}: ${e.message}`, { error: true });
  }
  refreshAfterSync();
  toast(`Commented on #${item.number}`, {
    undo: () =>
      gh(`/repos/${data.repo}/issues/comments/${comment.id}`, { method: 'DELETE' }).then(
        () => toast('Comment deleted'),
        (e) => toast(`Couldn't delete the comment: ${e.message}`, { error: true })
      ),
  });
}

// ---------- events ----------

document.addEventListener('click', (e) => {
  const t = e.target;
  if (!t.closest('#sdk-menu')) $('#sdk-menu').open = false;
  const viewButton = t.closest('[data-view]');
  if (viewButton) return selectView(viewButton.dataset.view);
  if (t.closest('[data-task] .AssigneeChip, [data-task] .IssueLabel')) return e.preventDefault();
  const chip = t.closest('.AssigneeChip');
  if (chip) {
    e.preventDefault();
    const v = `user:${chip.dataset.assignee}`;
    filters.assignee = filters.assignee === v ? '' : v;
    filters.view = '';
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
    filters.view = '';
    shown = PAGE;
    return render();
  }
  const tab = t.closest('.tab');
  if (tab) {
    e.preventDefault();
    filters = { ...filters, tab: 'inbox', inboxMode: tab.dataset.mode, state: '', cleanup: '', view: '', include: [], exclude: [], checks: '', review: '', mergeable: '', linked: '', bot: '', waiting: '', idleDays: 0, verdict: '', staleDays: 0, newerThanDays: 0 };
    selected.clear();
    shown = PAGE;
    inboxShown = 25;
    inboxFocus = 0;
    return render();
  }
  if (t.closest('#cmd-toggle')) {
    localStorage.setItem('commandsCollapsed', localStorage.getItem('commandsCollapsed') === '1' ? '0' : '1');
    return renderViews();
  }
  const groupHead = t.closest('.facet-group h4');
  if (groupHead) {
    const g = groupHead.parentElement.dataset.group;
    collapsedGroups.has(g) ? collapsedGroups.delete(g) : collapsedGroups.add(g);
    localStorage.setItem('collapsedGroups', JSON.stringify([...collapsedGroups]));
    return renderFacets();
  }
  if (t.id === 'more-btn') { shown += PAGE; return render(); }
  if (t.id === 'clear-filters') { filters = { ...DEFAULT_FILTERS, ...Object.fromEntries(KEPT_ON_CLEAR.map((k) => [k, filters[k]])) }; return render(); }
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
    const item = data.items.find((i) => i.number === Number(actionBtn.dataset.action));
    if (!item) return;
    const action = rowAction(item);
    if (isPosted(item.number, action) || busy.has(item.number)) return;
    return postCommand([item.number], action);
  }
});

$('#list').addEventListener('change', (e) => {
  if (!e.target.classList.contains('row-check')) return;
  const n = Number(e.target.closest('.row').dataset.number);
  e.target.checked ? selected.add(n) : selected.delete(n);
  e.target.closest('.row').classList.toggle('selected', e.target.checked);
  updateBulk(visibleItems());
});

$('#select-all').addEventListener('change', (e) => {
  const visible = visibleItems().slice(0, shown);
  visible.forEach((i) => (e.target.checked ? selected.add(i.number) : selected.delete(i.number)));
  render();
});

function bulkPost(action) {
  if (!confirm(`Post “${action.body}” on ${selected.size} ${filters.tab === 'pr' ? 'pull requests' : 'issues'}?`)) return;
  postCommand([...selected], action);
}
$('#bulk-btn').addEventListener('click', () => bulkPost(ACTIONS[filters.tab]));
$('#bulk-triage-btn').addEventListener('click', () => bulkPost(TRIAGE));

let searchTimer;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { filters.q = e.target.value; shown = PAGE; render(); }, 120);
});
$('#facet-search').addEventListener('input', (e) => { facetQuery = e.target.value; renderFacets(); });

const bind = (id, key, parse = (v) => v) =>
  $(id).addEventListener('change', (e) => {
    filters[key] = parse(e.target.type === 'checkbox' ? e.target.checked : e.target.value);
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
bind('#hide-unsupported-sdks', 'hideUnsupportedSdks');
$('#sdk-list').addEventListener('change', (e) => {
  if (e.target.checked) unsupportedSdks.delete(e.target.value);
  else unsupportedSdks.add(e.target.value);
  localStorage.setItem('unsupportedSdks', JSON.stringify([...unsupportedSdks]));
  shown = PAGE;
  render();
});
$('#bulk-close-btn').addEventListener('click', () => openCloseDialog());
$('#inbox').addEventListener('click', inboxClick);
$('#inbox-cleanup').addEventListener('click', inboxClick);
$('#inbox-others').addEventListener('change', (e) => { filters.inboxOthers = e.target.checked; render(); });
$('#inbox-hidden').addEventListener('change', (e) => { filters.inboxHidden = e.target.checked; render(); });

$('#refresh-btn').addEventListener('click', async () => {
  $('#refresh-btn').disabled = true;
  await refresh(true);
  setTimeout(() => { $('#refresh-btn').disabled = false; refresh(); }, 5000);
});
$('#token-btn').addEventListener('click', openTokenDialog);
document.addEventListener('keydown', (e) => {
  const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName);
  if (e.key === '/' && !typing) {
    e.preventDefault();
    $('#search').focus();
  }
  if (e.key === 'g' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey && !document.querySelector('dialog[open]')) {
    e.preventDefault();
    openQuickOpen();
  }
  if (e.key === 'Escape' && $('#sdk-menu').open) {
    $('#sdk-menu').open = false;
    $('#sdk-menu summary').focus();
  }
});
function openQuickOpen() {
  $('#quick-open-input').value = '';
  $('#quick-open-msg').hidden = true;
  $('#quick-open-dialog').showModal();
  $('#quick-open-input').focus();
}

function quickOpenMessage(html) {
  $('#quick-open-msg').innerHTML = html;
  $('#quick-open-msg').hidden = false;
}

$('#quick-open-dialog form').addEventListener('submit', (e) => {
  e.preventDefault();
  const n = parseItemNumber($('#quick-open-input').value);
  if (!n) return quickOpenMessage('Type an issue or PR number.');
  if (!data.repo) return quickOpenMessage('The dashboard is still loading. Try again in a moment.');
  const item = findItem(data.items, n);
  if (!item) return quickOpenMessage(`#${n} is not open in the dashboard. <a href="https://github.com/${data.repo}/issues/${n}" target="_blank" rel="noreferrer">Open it on GitHub</a>`);
  $('#quick-open-dialog').close();
  window.open(item.url, '_blank', 'noopener');
});
$('#quick-open-cancel').addEventListener('click', () => $('#quick-open-dialog').close());
window.addEventListener('hashchange', () => { filters = readHash(); render(); });
darkMode.addEventListener('change', render);

const STATIC_TIPS = {
  '#count-issue': CHIP_TIPS.issueCount,
  '#count-pr': CHIP_TIPS.prCount,
  '#inbox-progress': CHIP_TIPS.inboxProgress,
  '#sync-status': CHIP_TIPS.syncStatus,
};
for (const [sel, tip] of Object.entries(STATIC_TIPS)) $(sel).title = tooltip(tip);

// Some browsers never show the native title tooltip on a <button>, so every title is shown by this box instead.
// The title moves to data-tip on hover; code that sets .title later wins again on the next hover.
const tipBox = document.body.appendChild(Object.assign(document.createElement('div'), { className: 'tip', hidden: true }));
let tipTarget = null;
function hideTip() {
  tipTarget = null;
  tipBox.hidden = true;
}
document.addEventListener('mouseover', (e) => {
  const el = e.target.closest?.('[title], [data-tip]');
  if (el === tipTarget) return;
  hideTip();
  if (!el) return;
  if (el.hasAttribute('title')) {
    el.dataset.tip = el.title;
    el.removeAttribute('title');
  }
  if (!el.dataset.tip) return;
  tipTarget = el;
  tipBox.textContent = el.dataset.tip;
  tipBox.hidden = false;
  const r = el.getBoundingClientRect();
  const { width, height } = tipBox.getBoundingClientRect();
  const below = r.bottom + 6 + height <= window.innerHeight;
  tipBox.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - width - 8))}px`;
  tipBox.style.top = `${below ? r.bottom + 6 : Math.max(8, r.top - 6 - height)}px`;
});
document.addEventListener('mousedown', hideTip);
document.addEventListener('scroll', hideTip, true);

loadMe().then(render);
refresh();
setInterval(refresh, 60_000);
