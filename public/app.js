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
  newerThanDays: 0,
  preset: 'all',
};

let data = { items: [], labels: [] };
let filters = readHash();
let shown = PAGE;
let selected = new Set();
let facetQuery = '';
const collapsedGroups = new Set(JSON.parse(localStorage.getItem('collapsedGroups') || '["Package","SDK / RN","Upstream","Project","Other"]'));

// ---------- presets ----------

const PRESETS = {
  issue: [
    { id: 'all', name: 'All open', f: {} },
    { id: 'new', name: 'New this week', f: { newerThanDays: 7, sort: 'created' } },
    { id: 'high', name: 'Severity ≥ high', f: { minSeverity: 4 } },
    { id: 'needs-review', name: 'Needs review', f: { include: ['needs review'] } },
    { id: 'accepted', name: 'Accepted, unassigned', f: { include: ['Issue accepted'], assignee: 'none' } },
    { id: 'unverified', name: 'Never verified', f: { bot: 'never', sort: 'created' } },
    { id: 'unrated', name: 'No severity yet', f: { minSeverity: -1 } },
  ],
  pr: [
    { id: 'all', name: 'All open', f: {} },
    {
      id: 'ready',
      name: 'Ready to merge',
      f: { checks: 'SUCCESS', review: 'APPROVED', mergeable: 'MERGEABLE', sort: 'updated' },
    },
    { id: 'needs-review', name: 'Awaiting review', f: { review: 'REVIEW_REQUIRED', checks: 'SUCCESS', mergeable: 'MERGEABLE' } },
    { id: 'external', name: 'External contributions', f: { include: ['contributor: external'] } },
    { id: 'no-bot', name: 'No bot review yet', f: { bot: 'never' } },
    { id: 'bot-pending', name: 'Bot review pending', f: { bot: 'pending' } },
    { id: 'conflicts', name: 'Has conflicts', f: { mergeable: 'CONFLICTING' } },
    { id: 'no-issue', name: 'No linked issue', f: { linked: 'none' } },
  ],
};

function applyPreset(p) {
  filters = { ...DEFAULT_FILTERS, tab: filters.tab, q: filters.q, ...p.f, preset: p.id };
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

  renderPresets();
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
    </div>
    <div class="row-side">
      <span class="avatars">${avatars}</span>
      <span class="comments-count">${i.commentCount ? `${icons.comment} ${i.commentCount}` : ''}</span>
      <button class="btn btn-action${posted ? ' done' : ''}" data-action="${i.number}" title="Comment “${action.body}” on #${i.number}">${posted ? '✓ Requested' : action.label}</button>
    </div>
  </li>`;
}

function renderPresets() {
  $('#presets').innerHTML = PRESETS[filters.tab]
    .map((p) => {
      const f = { ...DEFAULT_FILTERS, tab: filters.tab, ...p.f };
      const n = data.items.filter((i) => matches(i, f)).length;
      return `<button class="preset${filters.preset === p.id ? ' selected' : ''}" data-preset="${p.id}">${esc(p.name)}<span class="counter">${n}</span></button>`;
    })
    .join('');
}

function renderActiveFilters() {
  const colorOf = Object.fromEntries(data.labels.map((l) => [l.name, l.color]));
  const chips = [
    ...filters.include.map((n) => labelHtml({ name: n, color: colorOf[n] }, { removable: true })),
    ...filters.exclude.map((n) => labelHtml({ name: n, color: colorOf[n] }, { removable: true })),
  ];
  if (filters.newerThanDays) chips.push(`<span class="muted">created in last ${filters.newerThanDays}d</span>`);
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
    filters = { ...filters, tab: tab.dataset.tab, preset: 'all', include: [], exclude: [], checks: '', review: '', mergeable: '', linked: '', bot: '', newerThanDays: 0 };
    selected.clear();
    shown = PAGE;
    return render();
  }
  const preset = t.closest('.preset');
  if (preset) return applyPreset(PRESETS[filters.tab].find((p) => p.id === preset.dataset.preset));
  const groupHead = t.closest('.facet-group h4');
  if (groupHead) {
    const g = groupHead.parentElement.dataset.group;
    collapsedGroups.has(g) ? collapsedGroups.delete(g) : collapsedGroups.add(g);
    localStorage.setItem('collapsedGroups', JSON.stringify([...collapsedGroups]));
    return renderFacets();
  }
  if (t.id === 'more-btn') { shown += PAGE; return render(); }
  if (t.id === 'clear-filters') { filters = { ...DEFAULT_FILTERS, tab: filters.tab, sort: filters.sort }; return render(); }
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
