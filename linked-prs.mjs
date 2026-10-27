import { isBot, isTeam } from './triage.mjs';

// Pull requests linked to an issue: they mention it (CROSS_REFERENCED_EVENT, `source`) or are
// connected in its Development sidebar (CONNECTED_EVENT, `subject`).
// `fix` is true when the PR is connected or closes the issue on merge; a mention can be the PR that caused the bug.

const prFacts = ({ number, title, state, mergedAt, baseRefName }) => ({ number, title, state, mergedAt, baseRefName });

// `node` is an issue with `timelineItems` of those two event types; `repo` is "owner/name".
// GitHub compares owner and name without case, so this does too.
export function linkedPrs(node, repo) {
  const byNumber = new Map();
  for (const event of node.timelineItems.nodes) {
    const pr = event?.source ?? event?.subject;
    if (pr?.__typename !== 'PullRequest') continue;
    if (pr.repository?.nameWithOwner.toLowerCase() !== repo.toLowerCase()) continue;
    const fix = !!event.subject || event.willCloseTarget === true;
    const seen = byNumber.get(pr.number);
    if (seen) seen.fix ||= fix;
    else byNumber.set(pr.number, { ...prFacts(pr), fix });
  }
  return [...byNumber.values()];
}

// A PR that is no longer open leaves the cache, so the issues that link it keep its final state.
export function updateLinkedPrs(items, { number, state, mergedAt }) {
  const update = (item) =>
    item.linkedPrs?.some((pr) => pr.number === number)
      ? { ...item, linkedPrs: item.linkedPrs.map((pr) => (pr.number === number ? { ...pr, state, mergedAt } : pr)) }
      : item;
  return new Map([...items].map(([key, item]) => [key, update(item)]));
}

// Team comments can name a fix ("does #49351 fix this?") that GitHub records no link for.

const CODE_AND_QUOTES = /(```|~~~)[\s\S]*?(?:\1|(?![\s\S]))|`[^`\n]*`|^[ \t]*>.*$/gm;
// Links and URLs are matched whole, so a `#N` in link text or inside a URL never counts.
// Nine digits keep numbers within GraphQL's Int.
const NUMBER = '[1-9]\\d{0,8}';
const REF = new RegExp(
  [
    String.raw`\[[^\]\n]*\]\((?<target>[^)\s]*)[^)]*\)`,
    String.raw`https?:\/\/\S+`,
    String.raw`(?<![\w./-])(?<repo>[\w.-]+\/[\w.-]+)#(?<repoNumber>${NUMBER})(?!\w)`,
    String.raw`(?<![\w/&])#(?<number>${NUMBER})(?!\w)`,
  ].join('|'),
  'g'
);
const URL_REF = new RegExp(String.raw`^https?:\/\/github\.com\/(?<repo>[^/]+\/[^/]+)\/(?:pull|issues)\/(?<number>${NUMBER})(?!\d)`, 'i');

function refNumber({ 0: match, groups }, sameRepo) {
  if (groups.number) return groups.number;
  if (groups.repo) return sameRepo(groups.repo) ? groups.repoNumber : null;
  const url = (groups.target ?? match).match(URL_REF)?.groups;
  return url && sameRepo(url.repo) ? url.number : null;
}

function refsIn(body, repo) {
  const sameRepo = (other) => other.toLowerCase() === repo.toLowerCase();
  return [...body.replace(CODE_AND_QUOTES, ' ').matchAll(REF)].map((m) => refNumber(m, sameRepo)).filter(Boolean).map(Number);
}

// The issue and PR numbers that team members and expo-bot name in `comments`, with the first comment that names each.
export function commentRefs(comments, { repo, number }) {
  const byNumber = new Map();
  for (const c of comments) {
    const login = c.author?.login;
    if (!isTeam(c.authorAssociation) && login !== 'expo-bot') continue;
    for (const ref of refsIn(c.body, repo)) {
      if (ref !== number && !byNumber.has(ref)) byNumber.set(ref, { number: ref, by: { login, association: c.authorAssociation } });
    }
  }
  return [...byNumber.values()];
}

// The PR's facts, null when the number is an issue, undefined when not known yet.
// `items` holds open items only; `resolved` maps numbers looked up earlier.
function known(number, items, resolved) {
  const item = items.get(number);
  if (!item) return resolved.get(number);
  return item.type === 'pr' ? { number, title: item.title, state: 'OPEN', mergedAt: null, baseRefName: item.baseRefName } : null;
}

export function refsToResolve(issues, items, resolved) {
  const numbers = new Set();
  for (const issue of issues) {
    for (const { number } of issue.commentRefs ?? []) if (known(number, items, resolved) === undefined) numbers.add(number);
  }
  return [...numbers];
}

export const refsQuery = (numbers) => `
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
${numbers.map((n) => `    n${n}: issueOrPullRequest(number: ${n}) { __typename ... on PullRequest { number title state mergedAt baseRefName } }`).join('\n')}
  }
}`;

// A null node is a number that is neither an issue nor a PR; it stays unresolved.
export const readRefs = (repository) =>
  new Map(
    Object.entries(repository)
      .filter(([, node]) => node)
      .map(([alias, node]) => [Number(alias.slice(1)), node.__typename === 'PullRequest' ? prFacts(node) : null])
  );

// Issues and merged PRs never change, so they need no second lookup. A closed PR can reopen.
export const lastingRefs = (resolved) => new Map([...resolved].filter(([, pr]) => pr === null || pr.state === 'MERGED'));

// Timeline links win over comment links for the same PR, but a team comment can make it a fix.
export function mergeCommentLinks(timeline, links) {
  const comments = links.filter((pr) => pr.via === 'comment');
  const fixes = new Set(comments.filter((pr) => pr.fix).map((pr) => pr.number));
  const numbers = new Set(timeline.map((pr) => pr.number));
  return [
    ...timeline.map((pr) => (fixes.has(pr.number) ? { ...pr, fix: true } : pr)),
    ...comments.filter((pr) => !numbers.has(pr.number)),
  ];
}

export function withCommentLinks(issue, items, resolved) {
  const links = (issue.commentRefs ?? []).flatMap(({ number, by }) => {
    const pr = known(number, items, resolved);
    // expo-bot is a MEMBER, and it often names the PR that caused the bug.
    return pr ? [{ ...pr, via: 'comment', by, fix: isTeam(by.association) && !isBot(by.login) }] : [];
  });
  return { ...issue, linkedPrs: mergeCommentLinks(issue.linkedPrs.filter((pr) => !pr.via), links) };
}
