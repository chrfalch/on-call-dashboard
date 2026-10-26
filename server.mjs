// Expo triage dashboard server.
// Mirrors open issues + PRs from expo/expo via the GitHub GraphQL API into an
// in-memory (and on-disk) cache, and serves a static UI that reads /api/items.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analyzeComments } from './triage.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OWNER = process.env.REPO_OWNER || 'expo';
const NAME = process.env.REPO_NAME || 'expo';
const PORT = Number(process.env.PORT || 4317);
const CACHE_FILE = path.join(__dirname, '.cache', `${OWNER}-${NAME}.json`);
const INCREMENTAL_MS = Number(process.env.INCREMENTAL_MS || 2 * 60 * 1000);
const FULL_MS = Number(process.env.FULL_MS || 60 * 60 * 1000);

// Bump when the item shape changes so a stale cache triggers a full re-sync.
const CACHE_VERSION = 6;

const TOKEN = process.env.GITHUB_TOKEN || execSync('gh auth token').toString().trim();

const state = {
  items: new Map(), // key: number
  labels: [],
  lastFullSync: null,
  lastIncrementalSync: null,
  syncing: false,
  syncError: null,
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
await runSync(hadCache ? 'incremental' : 'full');
setInterval(() => runSync('incremental'), INCREMENTAL_MS);
setInterval(() => runSync('full'), FULL_MS);
