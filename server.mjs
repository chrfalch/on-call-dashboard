// Expo triage dashboard server.
// Mirrors open issues + PRs from expo/expo via the GitHub GraphQL API into an
// in-memory (and on-disk) cache, and serves a static UI that reads /api/items.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analyzeComments } from './triage.mjs';
import { buildPrompt, claudeArgs, parseRecommendation, pruneRecs, recKey, storedResult, validateTasks } from './recommend.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OWNER = process.env.REPO_OWNER || 'expo';
const NAME = process.env.REPO_NAME || 'expo';
const PORT = Number(process.env.PORT || 4317);
const CACHE_FILE = path.join(__dirname, '.cache', `${OWNER}-${NAME}.json`);
const INCREMENTAL_MS = Number(process.env.INCREMENTAL_MS || 2 * 60 * 1000);
const FULL_MS = Number(process.env.FULL_MS || 60 * 60 * 1000);
const RECS_FILE = path.join(__dirname, '.cache', `recommendations-${OWNER}-${NAME}.json`);
// The claude CLI runs in an empty directory so no CLAUDE.md, AGENTS.md or project settings apply.
const CLAUDE_CWD = path.join(__dirname, '.cache', 'claude-cwd');
const CLAUDE_TIMEOUT_MS = 180_000;
const CLAUDE_CONCURRENCY = 3;
const MAX_BODY = 64 * 1024;

// Bump when the item shape changes so a stale cache triggers a full re-sync.
const CACHE_VERSION = 7;
const RECS_VERSION = 1;

const TOKEN = process.env.GITHUB_TOKEN || execSync('gh auth token').toString().trim();

const state = {
  items: new Map(), // key: number
  labels: [],
  lastFullSync: null,
  lastIncrementalSync: null,
  syncing: false,
  syncError: null,
};

const agent = {
  recs: new Map(), // key: recKey, value: { rec, at }
  failures: new Map(), // key: recKey, value: { error, at }; kept in memory only
  queue: [],
  queued: new Set(), // recKeys waiting or running
  running: 0,
};

async function gql(query, variables = {}, attempt = 0) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { authorization: `bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.errors || !json.data) {
    if (attempt < 5) {
      log(`GraphQL retry ${attempt + 1} (${res.status}): ${JSON.stringify(json.errors || json.message || '').slice(0, 200)}`);
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
      return gql(query, variables, attempt + 1);
    }
    throw new Error(`GraphQL ${res.status}: ${JSON.stringify(json.errors || json).slice(0, 500)}`);
  }
  return json.data;
}

const COMMON = `
  __typename number title url createdAt updatedAt state
  author { login avatarUrl url }
  authorAssociation
  labels(first: 40) { nodes { name color description } }
  assignees(first: 5) { nodes { login avatarUrl } }
  reactions(content: THUMBS_UP) { totalCount }
  comments(last: 30) { totalCount nodes { author { login } authorAssociation createdAt url body } }
`;
const PR_FIELDS = `
  ... on PullRequest {
    ${COMMON}
    isDraft reviewDecision mergeable additions deletions changedFiles
    closingIssuesReferences(first: 10) { nodes { number title url } }
    reviewRequests(first: 5) { nodes { requestedReviewer { ... on User { login avatarUrl } ... on Team { name } } } }
    latestReviews(first: 10) { nodes { state submittedAt authorAssociation author { login avatarUrl } } }
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  }`;
const ISSUE_FIELDS = `
  ... on Issue {
    ${COMMON}
    issueType { name color }
  }`;

const LIST_QUERY = (kind) => `
query($cursor: String, $owner: String!, $name: String!, $first: Int!) {
  repository(owner: $owner, name: $name) {
    ${kind}(states: OPEN, first: $first, after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes { ${kind === 'pullRequests' ? PR_FIELDS : ISSUE_FIELDS} }
    }
  }
}`;

// Same shape as LIST_QUERY but across all states, for incremental syncs.
const RECENT_QUERY = (kind) => `
query($cursor: String, $owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    ${kind}(first: 20, after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { ${kind === 'pullRequests' ? PR_FIELDS : ISSUE_FIELDS} }
    }
  }
}`;

const LABELS_QUERY = `
query($cursor: String, $owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    labels(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { name color description }
    }
  }
}`;

const THREAD_FIELDS = 'body comments(last: 30) { nodes { author { login } authorAssociation body createdAt } }';
const THREAD_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issueOrPullRequest(number: $number) {
      ... on Issue { ${THREAD_FIELDS} }
      ... on PullRequest { ${THREAD_FIELDS} }
    }
  }
}`;

const SEVERITY = { 'severity: trivial': 1, 'severity: low': 2, 'severity: medium': 3, 'severity: high': 4, 'severity: critical': 5 };
function normalize(n) {
  const isPR = n.__typename === 'PullRequest';
  const labels = n.labels.nodes.map((l) => ({ name: l.name, color: l.color, description: l.description }));
  const severity = Math.max(0, ...labels.map((l) => SEVERITY[l.name] || 0));
  // Reviews are replies too: fold them into the timeline as pseudo-comments.
  const reviews = isPR
    ? n.latestReviews.nodes
        .filter((r) => r.submittedAt)
        .map((r) => ({ author: r.author, authorAssociation: r.authorAssociation, createdAt: r.submittedAt, url: n.url, body: `(review: ${r.state})` }))
    : [];
  const comments = [...n.comments.nodes, ...reviews].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const item = {
    type: isPR ? 'pr' : 'issue',
    number: n.number,
    title: n.title,
    url: n.url,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    author: n.author ? { login: n.author.login, avatarUrl: n.author.avatarUrl } : { login: 'ghost', avatarUrl: '' },
    authorAssociation: n.authorAssociation,
    labels,
    severity,
    assignees: n.assignees.nodes,
    thumbsUp: n.reactions.totalCount,
    commentCount: n.comments.totalCount,
    lastCommentAt: comments.length ? comments[comments.length - 1].createdAt : null,
    ...analyzeComments(comments, { authorLogin: n.author?.login, authorAssociation: n.authorAssociation, createdAt: n.createdAt }),
  };
  if (isPR) {
    Object.assign(item, {
      isDraft: n.isDraft,
      reviewDecision: n.reviewDecision,
      mergeable: n.mergeable,
      additions: n.additions,
      deletions: n.deletions,
      changedFiles: n.changedFiles,
      checks: n.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null,
      // Issues linked via closing keywords ("Fixes #123") or the Development sidebar.
      linkedIssues: n.closingIssuesReferences.nodes,
      reviewRequests: n.reviewRequests.nodes.map((r) => r.requestedReviewer).filter(Boolean),
      latestReviews: n.latestReviews.nodes.map((r) => ({ state: r.state, login: r.author?.login, avatarUrl: r.author?.avatarUrl })),
    });
  } else {
    item.issueType = n.issueType ?? null;
  }
  return item;
}

async function fetchAllLabels() {
  const out = [];
  let cursor = null;
  do {
    const d = await gql(LABELS_QUERY, { cursor, owner: OWNER, name: NAME });
    out.push(...d.repository.labels.nodes);
    cursor = d.repository.labels.pageInfo.hasNextPage ? d.repository.labels.pageInfo.endCursor : null;
  } while (cursor);
  return out;
}

async function fetchAllOpen(kind) {
  const out = [];
  let cursor = null;
  do {
    // PR pages are heavy (reviews, checks, comments); smaller pages avoid 502 timeouts.
    const d = await gql(LIST_QUERY(kind), { cursor, owner: OWNER, name: NAME, first: kind === 'pullRequests' ? 30 : 50 });
    const conn = d.repository[kind];
    out.push(...conn.nodes.map(normalize));
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    log(`  ${kind}: ${out.length}/${conn.totalCount}`);
  } while (cursor);
  return out;
}

async function fullSync() {
  const started = new Date().toISOString();
  log('full sync start');
  const [labels, prs, issues] = await Promise.all([
    fetchAllLabels(),
    fetchAllOpen('pullRequests'),
    fetchAllOpen('issues'),
  ]);
  state.labels = labels;
  state.items = new Map([...prs, ...issues].map((i) => [i.number, i]));
  state.lastFullSync = started;
  state.lastIncrementalSync = started;
  log(`full sync done: ${prs.length} PRs, ${issues.length} issues`);
}

// Walks issues and PRs (any state) by most recently updated until it reaches
// the previous sync; closed / merged items get dropped from the cache.
async function incrementalSync() {
  const since = state.lastIncrementalSync;
  if (!since) return fullSync();
  const started = new Date().toISOString();
  // Overlap by a minute to be safe against clock skew.
  const cutoff = new Date(new Date(since).getTime() - 60_000).toISOString();
  let n = 0;
  for (const kind of ['issues', 'pullRequests']) {
    let cursor = null;
    while (true) {
      const d = await gql(RECENT_QUERY(kind), { cursor, owner: OWNER, name: NAME });
      const conn = d.repository[kind];
      let reachedCutoff = false;
      for (const node of conn.nodes) {
        if (node.updatedAt < cutoff) {
          reachedCutoff = true;
          break;
        }
        n++;
        if (node.state === 'OPEN') state.items.set(node.number, normalize(node));
        else state.items.delete(node.number);
      }
      if (reachedCutoff || !conn.pageInfo.hasNextPage) break;
      cursor = conn.pageInfo.endCursor;
    }
  }
  state.lastIncrementalSync = started;
  if (n) log(`incremental sync: ${n} updated`);
}

async function runSync(kind) {
  if (state.syncing) return;
  state.syncing = kind;
  try {
    if (kind === 'full') await fullSync();
    else await incrementalSync();
    state.syncError = null;
    persist();
  } catch (e) {
    state.syncError = String(e.message || e);
    log(`sync error: ${state.syncError}`);
  } finally {
    state.syncing = false;
  }
}

function persist() {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(
    CACHE_FILE,
    JSON.stringify({
      version: CACHE_VERSION,
      labels: state.labels,
      items: [...state.items.values()],
      lastFullSync: state.lastFullSync,
      lastIncrementalSync: state.lastIncrementalSync,
    })
  );
}

function restore() {
  try {
    const d = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    state.labels = d.labels;
    state.items = new Map(d.items.map((i) => [i.number, i]));
    state.lastFullSync = d.lastFullSync;
    state.lastIncrementalSync = d.lastIncrementalSync;
    log(`restored ${state.items.size} items from cache (last full sync ${d.lastFullSync})`);
    // Serve the stale cache meanwhile, but refetch everything if its shape is outdated.
    return d.version === CACHE_VERSION;
  } catch {
    return false;
  }
}

async function fetchThread(number) {
  const d = await gql(THREAD_QUERY, { owner: OWNER, name: NAME, number });
  const node = d.repository.issueOrPullRequest;
  if (!node) throw new Error(`#${number} not found`);
  return {
    body: node.body,
    comments: node.comments.nodes.map((c) => ({ author: c.author?.login ?? 'ghost', association: c.authorAssociation, createdAt: c.createdAt, body: c.body })),
  };
}

// Resolves with the CLI's stdout, and `failure` when it did not exit cleanly.
function runClaude(type, { system, user }) {
  return new Promise((resolve) => {
    // CLAUDE_CWD is inside this git repo, and auto memory is keyed by the repo, so without
    // the env var the CLI adds this project's MEMORY.md to the prompt.
    const env = { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
    const child = spawn('claude', claudeArgs(type, system, ''), { cwd: CLAUDE_CWD, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    // Resolving here rather than on 'close' means a child that ignores the signal cannot hold a queue slot.
    const timer = setTimeout(() => {
      child.kill();
      resolve({ stdout, failure: `timed out after ${CLAUDE_TIMEOUT_MS / 1000} s` });
    }, CLAUDE_TIMEOUT_MS);
    child.stdout.setEncoding('utf8').on('data', (s) => (stdout += s));
    child.stderr.setEncoding('utf8').on('data', (s) => (stderr += s));
    // Without a listener, EPIPE from a CLI that exits before reading stdin would crash the server.
    child.stdin.on('error', () => {});
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ stdout, failure: `could not start claude: ${e.message}` });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const detail = stderr.trim() ? `: ${stderr.trim().slice(-200)}` : '';
      resolve({ stdout, failure: code === 0 ? null : `claude exited with ${code ?? signal}${detail}` });
    });
    child.stdin.end(user);
  });
}

function costOf(stdout) {
  try {
    const cost = JSON.parse(stdout).total_cost_usd;
    return typeof cost === 'number' ? ` ($${cost.toFixed(4)})` : '';
  } catch {
    return '';
  }
}

async function runJob({ key, task, item }) {
  let result;
  let cost = '';
  try {
    const { stdout, failure } = await runClaude(item.type, buildPrompt(task, item, await fetchThread(item.number)));
    cost = costOf(stdout);
    result = failure ? { ok: false, error: failure } : parseRecommendation(stdout, item.type);
  } catch (e) {
    result = { ok: false, error: String(e.message || e) };
  }
  if (result.ok) {
    agent.recs.set(key, { rec: result.rec, at: Date.now() });
    agent.failures.delete(key);
    persistRecs();
  } else {
    agent.failures.set(key, { error: result.error, at: Date.now() });
  }
  log(`recommendation ${key}: ${result.ok ? result.rec.action : `error: ${result.error}`}${cost}`);
}

function enqueue(job) {
  if (agent.queued.has(job.key)) return;
  agent.queued.add(job.key);
  agent.queue.push(job);
  drain();
}

function drain() {
  while (agent.running < CLAUDE_CONCURRENCY && agent.queue.length) {
    const job = agent.queue.shift();
    agent.running++;
    runJob(job).finally(() => {
      agent.running--;
      agent.queued.delete(job.key);
      drain();
    });
  }
}

function recommendations(entries) {
  const now = Date.now();
  const out = {};
  for (const { key, task, item, error } of entries) {
    if (error) {
      out[key] = { status: 'error', error };
      continue;
    }
    const job = { key: recKey(task, item), task, item };
    const stored = storedResult(job.key, agent, now);
    if (!stored) enqueue(job);
    out[key] = stored ?? { status: 'pending' };
  }
  return out;
}

function persistRecs() {
  agent.recs = pruneRecs(agent.recs, state.items);
  try {
    fs.writeFileSync(RECS_FILE, JSON.stringify({ version: RECS_VERSION, recs: Object.fromEntries(agent.recs) }));
  } catch (e) {
    log(`could not save recommendations: ${e.message}`);
  }
}

function restoreRecs() {
  try {
    const d = JSON.parse(fs.readFileSync(RECS_FILE, 'utf8'));
    if (d.version !== RECS_VERSION) return;
    agent.recs = new Map(Object.entries(d.recs));
    log(`restored ${agent.recs.size} recommendations`);
  } catch {}
}

// Undefined when the body is not JSON or is larger than MAX_BODY. It reads to the end
// either way, so the 400 response can still be sent on the same socket.
async function readJson(req) {
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size <= MAX_BODY) chunks.push(chunk);
    }
    return size <= MAX_BODY ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
  } catch {
    return undefined;
  }
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/items') {
    const body = JSON.stringify({
      repo: `${OWNER}/${NAME}`,
      items: [...state.items.values()],
      labels: state.labels,
      lastFullSync: state.lastFullSync,
      lastSync: state.lastIncrementalSync,
      syncing: state.syncing,
      syncError: state.syncError,
    });
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(body);
  }
  if (url.pathname === '/api/refresh' && req.method === 'POST') {
    runSync('incremental');
    res.writeHead(202, { 'content-type': 'application/json' });
    return res.end('{"ok":true}');
  }
  if (url.pathname === '/api/recommendations' && req.method === 'POST') {
    const entries = validateTasks(await readJson(req), state.items);
    res.writeHead(entries ? 200 : 400, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(entries ? recommendations(entries) : { error: 'expected a JSON body {tasks: [...]} of at most 64 KB' }));
  }
  const file = path.join(__dirname, 'public', url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
  if (!file.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
});

server.listen(PORT, () => log(`listening on http://localhost:${PORT}`));

const hadCache = restore();
restoreRecs();
fs.mkdirSync(CLAUDE_CWD, { recursive: true });
await runSync(hadCache ? 'incremental' : 'full');
setInterval(() => runSync('incremental'), INCREMENTAL_MS);
setInterval(() => runSync('full'), FULL_MS);
