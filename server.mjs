// Expo triage dashboard server.
// Mirrors open issues + PRs from expo/expo via the GitHub GraphQL API into an
// in-memory (and on-disk) cache, and serves a static UI that reads /api/items.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analyzeComments, botReview, ownerLastActivityAt } from './triage.mjs';
import { commentRefs, lastingRefs, linkedPrs, mergeCommentLinks, readRefs, refsQuery, refsToResolve, updateLinkedPrs, withCommentLinks } from './linked-prs.mjs';
import { buildPrompt, capQueue, claudeArgs, isCurrentRecKey, loadRecs, parseRecommendation, pruneFailures, pruneRecs, recKey, RECS_VERSION, requestError, respond, storedResult, validateTasks } from './recommend.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OWNER = process.env.REPO_OWNER || 'expo';
const NAME = process.env.REPO_NAME || 'expo';
const REPO = `${OWNER}/${NAME}`;
const PORT = Number(process.env.PORT || 4317);
const CACHE_FILE = path.join(__dirname, '.cache', `${OWNER}-${NAME}.json`);
const INCREMENTAL_MS = Number(process.env.INCREMENTAL_MS || 2 * 60 * 1000);
const FULL_MS = Number(process.env.FULL_MS || 60 * 60 * 1000);
const RECS_FILE = path.join(__dirname, '.cache', `recommendations-${OWNER}-${NAME}.json`);
const TRENDS_FILE = path.join(__dirname, '.cache', `trends-${OWNER}-${NAME}.json`);
const TRENDS_DAYS = 9;
// The claude CLI runs in an empty directory so no CLAUDE.md, AGENTS.md or project settings apply.
const CLAUDE_CWD = path.join(__dirname, '.cache', 'claude-cwd');
const JOB_TIMEOUT_MS = 180_000;
const KILL_GRACE_MS = 5_000;
const STDOUT_LIMIT = 1024 * 1024;
const STDERR_LIMIT = 64 * 1024;
const CLAUDE_CONCURRENCY = 3;
const MAX_WAITING_JOBS = 30;
const MAX_BODY = 64 * 1024;

// Bump when the item shape changes so a stale cache triggers a full re-sync.
const CACHE_VERSION = 14;
const REFS_PER_QUERY = 50;

const TOKEN = process.env.GITHUB_TOKEN || execSync('gh auth token').toString().trim();

const state = {
  items: new Map(), // key: number
  refs: new Map(), // numbers named in comments: merged PR facts, or null for an issue
  labels: [],
  lastFullSync: null,
  lastIncrementalSync: null,
  syncing: false,
  syncError: null,
};

let trends = { fetchedAt: null, since: null, issues: [], pullRequests: [] };

const agent = {
  recs: new Map(), // key: recKey, value: { rec, at }
  failures: new Map(), // key: recKey, value: { error, at }; kept in memory only
  queue: [],
  queued: new Set(), // recKeys waiting or running
  running: 0,
};

// `allowNotFound`: a number that is neither an issue nor a PR fails only its own field, so keep the rest.
async function gql(query, variables = {}, { allowNotFound = false } = {}, attempt = 0) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { authorization: `bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json().catch(() => ({}));
  const errors = allowNotFound ? json.errors?.filter((e) => e.type !== 'NOT_FOUND') : json.errors;
  if (!res.ok || errors?.length || !json.data) {
    if (attempt < 5) {
      log(`GraphQL retry ${attempt + 1} (${res.status}): ${JSON.stringify(json.errors || json.message || '').slice(0, 200)}`);
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
      return gql(query, variables, { allowNotFound }, attempt + 1);
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
    isDraft reviewDecision mergeable mergeStateStatus additions deletions changedFiles mergedAt baseRefName
    closingIssuesReferences(first: 10) { nodes { number title url } }
    reviewRequests(first: 5) { nodes { requestedReviewer { ... on User { login avatarUrl } ... on Team { name } } } }
    latestReviews(first: 10) { nodes { state submittedAt authorAssociation author { login avatarUrl } } }
    latestOpinionatedReviews(first: 10) { nodes { state submittedAt author { login } } }
    commits(last: 1) { nodes { commit { committedDate statusCheckRollup { state } } } }
  }`;
const LINKED_PR = '__typename ... on PullRequest { number title state mergedAt baseRefName repository { nameWithOwner } }';
const LINKED_PRS = `timelineItems(itemTypes: [CROSS_REFERENCED_EVENT, CONNECTED_EVENT], last: 100) {
  nodes { ... on CrossReferencedEvent { willCloseTarget source { ${LINKED_PR} } } ... on ConnectedEvent { subject { ${LINKED_PR} } } }
}`;
const ISSUE_FIELDS = `
  ... on Issue {
    ${COMMON}
    issueType { name color }
    ${LINKED_PRS}
    assignedEvents: timelineItems(itemTypes: [ASSIGNED_EVENT], last: 10) {
      nodes { ... on AssignedEvent { createdAt assignee { ... on User { login } } } }
    }
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

// GitHub search returns at most 1000 results per query; a busier window is cut off there.
const TRENDS_QUERY = `
query($cursor: String, $q: String!) {
  search(query: $q, type: ISSUE, first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on Issue { number createdAt closedAt state }
      ... on PullRequest { number createdAt closedAt state }
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
    defaultBranchRef { name }
    issueOrPullRequest(number: $number) {
      ... on Issue { ${THREAD_FIELDS} ${LINKED_PRS} }
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
    const changesRequested = n.latestOpinionatedReviews.nodes.filter((r) => r.state === 'CHANGES_REQUESTED' && r.submittedAt);
    Object.assign(item, {
      isDraft: n.isDraft,
      reviewDecision: n.reviewDecision,
      mergeable: n.mergeable,
      mergeStateStatus: n.mergeStateStatus ?? null,
      additions: n.additions,
      deletions: n.deletions,
      changedFiles: n.changedFiles,
      baseRefName: n.baseRefName,
      checks: n.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null,
      // Committer date, not push time (GitHub deprecated pushedDate): a commit made before the review and pushed after it is missed.
      lastCommitAt: n.commits.nodes[0]?.commit.committedDate ?? null,
      // latestReviews drops a reviewer's review once their review is re-requested; this keeps it.
      changesRequestedAt: changesRequested.map((r) => r.submittedAt).sort().at(-1) ?? null,
      changesRequestedBy: changesRequested.map((r) => r.author?.login).filter(Boolean),
      // Issues linked via closing keywords ("Fixes #123") or the Development sidebar.
      linkedIssues: n.closingIssuesReferences.nodes,
      reviewRequests: n.reviewRequests.nodes.map((r) => r.requestedReviewer).filter(Boolean),
      latestReviews: n.latestReviews.nodes.map((r) => ({ state: r.state, login: r.author?.login, avatarUrl: r.author?.avatarUrl })),
      botReview: botReview(n.latestReviews.nodes),
    });
  } else {
    item.issueType = n.issueType ?? null;
    item.linkedPrs = linkedPrs(n, REPO);
    item.commentRefs = commentRefs(n.comments.nodes, { repo: REPO, number: n.number });
    item.ownerLastActivityAt = ownerLastActivityAt(n.comments.nodes, n.assignees.nodes, n.assignedEvents.nodes);
  }
  return item;
}

// Looks up the numbers that comments name, then adds the PRs among them to each issue's linkedPrs in `items`.
// On failure the issues keep the links they had, so the rest of the sync still lands.
async function linkCommentPrs(items, issues) {
  try {
    const numbers = refsToResolve(issues, items, state.refs);
    let resolved = state.refs;
    for (let i = 0; i < numbers.length; i += REFS_PER_QUERY) {
      const d = await gql(refsQuery(numbers.slice(i, i + REFS_PER_QUERY)), { owner: OWNER, name: NAME }, { allowNotFound: true });
      resolved = new Map([...resolved, ...readRefs(d.repository)]);
    }
    state.refs = lastingRefs(resolved);
    for (const issue of issues) items.set(issue.number, withCommentLinks(issue, items, resolved));
  } catch (e) {
    log(`comment-linked PRs: ${e.message || e}`);
  }
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
  const items = new Map([...prs, ...issues].map((i) => [i.number, i]));
  await linkCommentPrs(items, issues);
  state.labels = labels;
  state.items = items;
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
  const openIssues = [];
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
        if (node.state === 'OPEN') {
          const item = normalize(node);
          // Keeps the earlier comment links until linkCommentPrs rebuilds them, so a failed lookup loses none.
          if (kind === 'issues') {
            item.linkedPrs = mergeCommentLinks(item.linkedPrs, state.items.get(node.number)?.linkedPrs ?? []);
            openIssues.push(node.number);
          }
          state.items.set(node.number, item);
        } else {
          if (kind === 'pullRequests') state.items = updateLinkedPrs(state.items, node);
          state.items.delete(node.number);
        }
      }
      if (reachedCutoff || !conn.pageInfo.hasNextPage) break;
      cursor = conn.pageInfo.endCursor;
    }
  }
  // After the PR pass, so PRs opened since the last sync are already in state.items.
  await linkCommentPrs(state.items, openIssues.map((number) => state.items.get(number)).filter(Boolean));
  state.lastIncrementalSync = started;
  if (n) log(`incremental sync: ${n} updated`);
}

async function searchTrend(q) {
  const out = [];
  let cursor = null;
  do {
    const d = await gql(TRENDS_QUERY, { cursor, q });
    out.push(...d.search.nodes);
    cursor = d.search.pageInfo.hasNextPage ? d.search.pageInfo.endCursor : null;
  } while (cursor);
  return out;
}

// Items created or closed since `since`. A reopened item is OPEN again and does not count as closed.
async function fetchTrend(type, since) {
  const [created, closed] = await Promise.all(
    ['created', 'closed'].map((field) => searchTrend(`repo:${OWNER}/${NAME} is:${type} ${field}:>=${since}`))
  );
  const byNumber = new Map(
    [...created, ...closed].map((n) => [n.number, { number: n.number, createdAt: n.createdAt, closedAt: n.state === 'OPEN' ? null : n.closedAt }])
  );
  return [...byNumber.values()];
}

// Own guard, not state.syncing, so a slow search never makes the hourly full sync skip its turn.
let trendsBusy = false;
async function refreshTrends() {
  if (trendsBusy) return;
  trendsBusy = true;
  try {
    const fetchedAt = new Date().toISOString();
    const since = new Date(Date.now() - TRENDS_DAYS * 86_400_000).toISOString().replace(/\.\d+Z$/, 'Z');
    const [issues, pullRequests] = await Promise.all([fetchTrend('issue', since), fetchTrend('pr', since)]);
    trends = { fetchedAt, since, issues, pullRequests };
    persistTrends();
  } catch (e) {
    log(`trends error: ${e.message || e}`);
  } finally {
    trendsBusy = false;
  }
}

async function runSync(kind) {
  if (state.syncing) return;
  state.syncing = kind;
  try {
    if (kind === 'full') await fullSync();
    else await incrementalSync();
    state.syncError = null;
    persist();
    refreshTrends();
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
      refs: [...state.refs],
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
    if (d.version !== CACHE_VERSION) return false;
    state.refs = new Map(d.refs);
    return true;
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
    linkedPrs: node.timelineItems ? mergeCommentLinks(linkedPrs(node, REPO), state.items.get(number)?.linkedPrs ?? []) : undefined,
    defaultBranch: d.repository.defaultBranchRef?.name,
  };
}

const timeoutError = () => `timed out after ${JOB_TIMEOUT_MS / 1000} s`;

// Rejects at `deadline` (ms since epoch). The losing promise keeps running, but its result is ignored.
function beforeDeadline(promise, deadline) {
  let timer;
  const expired = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(timeoutError())), deadline - Date.now())));
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

// Process group ids of running claude children. They are detached, so a Ctrl-C on the
// server does not reach them; the exit handler at the bottom signals them instead.
const claudeGroups = new Set();

// Resolves with the CLI's stdout, and `failure` when it did not exit cleanly.
function runClaude(type, { system, user }, deadline) {
  return new Promise((resolve) => {
    // CLAUDE_CWD is inside this git repo, and auto memory is keyed by the repo, so without
    // the env var the CLI adds this project's MEMORY.md to the prompt.
    const env = { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
    // Detached: the child leads its own process group, so a kill also reaches anything it started.
    const child = spawn('claude', claudeArgs(type, system), { cwd: CLAUDE_CWD, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    if (child.pid) claudeGroups.add(child.pid);
    const out = { stdout: [], stderr: [] };
    const size = { stdout: 0, stderr: 0 };
    let failure = null;
    let killTimer;

    const finish = () => {
      claudeGroups.delete(child.pid);
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({ stdout: Buffer.concat(out.stdout).toString('utf8'), failure });
    };
    const signalGroup = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {}
    };
    const stop = (reason) => {
      if (failure) return;
      failure = reason;
      signalGroup('SIGTERM');
      killTimer = setTimeout(() => {
        signalGroup('SIGKILL');
        finish();
      }, KILL_GRACE_MS);
    };
    const collect = (name, limit) => (chunk) => {
      if (failure) return;
      size[name] += chunk.length;
      if (size[name] > limit) stop(`claude ${name} over ${limit / 1024} KB`);
      else out[name].push(chunk);
    };

    const timer = setTimeout(() => stop(timeoutError()), deadline - Date.now());
    child.stdout.on('data', collect('stdout', STDOUT_LIMIT));
    child.stderr.on('data', collect('stderr', STDERR_LIMIT));
    // Without listeners, a stream error (such as EPIPE when the CLI exits before reading stdin) would crash the server.
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on('error', () => {});
    child.on('error', (e) => {
      failure ??= `could not run claude: ${e.message}`;
      finish();
    });
    child.on('close', (code, signal) => {
      if (!failure && code !== 0) {
        const stderr = Buffer.concat(out.stderr).toString('utf8').trim();
        failure = `claude exited with ${code ?? signal}${stderr ? `: ${stderr.slice(-200)}` : ''}`;
      }
      finish();
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
  const skip = () => log(`recommendation ${key}: skipped, item changed or closed`);
  if (!isCurrentRecKey(key, state.items)) return skip();
  const deadline = Date.now() + JOB_TIMEOUT_MS;
  let result;
  let cost = '';
  try {
    const thread = await beforeDeadline(fetchThread(item.number), deadline);
    if (!isCurrentRecKey(key, state.items)) return skip();
    const prompt = buildPrompt(task, item, thread);
    if (Date.now() >= deadline) throw new Error(timeoutError());
    const { stdout, failure } = await runClaude(item.type, prompt, deadline);
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
    const now = Date.now();
    agent.failures = pruneFailures(agent.failures, now);
    agent.failures.set(key, { error: result.error, at: now });
  }
  log(`recommendation ${key}: ${result.ok ? result.rec.action : `error: ${result.error}`}${cost}`);
}

function enqueue(job) {
  if (agent.queued.has(job.key)) return;
  agent.queued.add(job.key);
  const { waiting, dropped } = capQueue([...agent.queue, job], MAX_WAITING_JOBS);
  agent.queue = waiting;
  for (const { key } of dropped) agent.queued.delete(key);
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
  return respond(entries, ({ task, item }) => {
    const job = { key: recKey(task, item), task, item };
    const stored = storedResult(job.key, agent, now);
    if (!stored) enqueue(job);
    return stored ?? { status: 'pending' };
  });
}

function persistRecs() {
  agent.recs = pruneRecs(agent.recs, state.items);
  const temp = `${RECS_FILE}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify({ version: RECS_VERSION, recs: Object.fromEntries(agent.recs) }));
    fs.renameSync(temp, RECS_FILE);
  } catch (e) {
    log(`could not save recommendations: ${e.message}`);
  }
}

function persistTrends() {
  const temp = `${TRENDS_FILE}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(trends));
    fs.renameSync(temp, TRENDS_FILE);
  } catch (e) {
    log(`could not save trends: ${e.message}`);
  }
}

function restoreTrends() {
  try {
    const d = JSON.parse(fs.readFileSync(TRENDS_FILE, 'utf8'));
    if (!Array.isArray(d.issues) || !Array.isArray(d.pullRequests)) throw new Error('unexpected shape');
    trends = d;
    log(`restored trends from ${d.fetchedAt}`);
  } catch (e) {
    if (e.code !== 'ENOENT') log(`could not restore trends, starting empty: ${e.message}`);
  }
}

function restoreRecs() {
  try {
    agent.recs = loadRecs(JSON.parse(fs.readFileSync(RECS_FILE, 'utf8')), state.items);
    log(`restored ${agent.recs.size} recommendations`);
  } catch (e) {
    agent.recs = new Map();
    if (e.code !== 'ENOENT') log(`could not restore recommendations, starting empty: ${e.message}`);
  }
}

// Undefined when the body is not JSON or is larger than MAX_BODY. A body that is too
// large is not read to the end; the caller closes the connection after its response.
function readJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('error', () => resolve(undefined));
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY) return chunks.push(chunk);
      req.pause();
      req.removeAllListeners('data');
      resolve(undefined);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(undefined);
      }
    });
  });
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
  if (url.pathname === '/api/trends') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(trends));
  }
  if (url.pathname === '/api/refresh' && req.method === 'POST') {
    runSync('incremental');
    res.writeHead(202, { 'content-type': 'application/json' });
    return res.end('{"ok":true}');
  }
  if (url.pathname === '/api/recommendations' && req.method === 'POST') {
    const rejected = requestError(req.headers, PORT);
    const entries = rejected ? null : validateTasks(await readJson(req), state.items);
    if (!entries) {
      const { status, error } = rejected ?? { status: 400, error: 'expected a JSON body {tasks: [...]} of at most 64 KB' };
      // The request body may be partly unread, so this connection cannot serve another request.
      res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
      return res.end(JSON.stringify({ error }), () => req.destroy());
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(recommendations(entries)));
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

server.listen(PORT, '127.0.0.1', () => log(`listening on http://127.0.0.1:${PORT}`));

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  process.on(signal, () => {
    for (const pid of claudeGroups) {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {}
    }
    process.exit(code);
  });
}

const hadCache = restore();
restoreRecs();
restoreTrends();
fs.mkdirSync(CLAUDE_CWD, { recursive: true });
await runSync(hadCache ? 'incremental' : 'full');
setInterval(() => runSync('incremental'), INCREMENTAL_MS);
setInterval(() => runSync('full'), FULL_MS);
