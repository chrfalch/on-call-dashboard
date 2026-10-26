import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commentRefs, lastingRefs, linkedPrs, mergeCommentLinks, readRefs, refsQuery, refsToResolve, updateLinkedPrs, withCommentLinks } from './linked-prs.mjs';

const REPO = 'expo/expo';
const prNode = (number, over = {}) => ({
  __typename: 'PullRequest',
  number,
  title: `PR ${number}`,
  state: 'MERGED',
  mergedAt: '2026-10-20T00:00:00Z',
  baseRefName: 'main',
  repository: { nameWithOwner: REPO },
  ...over,
});
const timeline = (...nodes) => ({ timelineItems: { nodes } });
const entry = (number, over = {}) => ({ number, title: `PR ${number}`, state: 'MERGED', mergedAt: '2026-10-20T00:00:00Z', baseRefName: 'main', ...over });

test('linkedPrs takes PRs from cross-references and connected events', () => {
  const node = timeline({ source: prNode(1) }, { subject: prNode(2, { state: 'OPEN', mergedAt: null, baseRefName: 'stack/feature' }) });
  assert.deepEqual(linkedPrs(node, REPO), [entry(1), entry(2, { state: 'OPEN', mergedAt: null, baseRefName: 'stack/feature' })]);
});

test('linkedPrs keeps only PRs in the same repository, compared without case', () => {
  const node = timeline({ source: prNode(1, { repository: { nameWithOwner: 'someone/fork' } }) }, { source: prNode(2, { repository: { nameWithOwner: 'Expo/Expo' } }) });
  assert.deepEqual(linkedPrs(node, REPO), [entry(2)]);
});

test('linkedPrs skips issues and events of other types', () => {
  const node = timeline({ source: { __typename: 'Issue' } }, { subject: { __typename: 'Issue' } }, {}, { source: prNode(3) });
  assert.deepEqual(linkedPrs(node, REPO), [entry(3)]);
});

test('linkedPrs skips null timeline entries', () => {
  assert.deepEqual(linkedPrs(timeline(null, { source: prNode(3) }, null), REPO), [entry(3)]);
});

test('linkedPrs skips PRs whose repository is not visible', () => {
  assert.deepEqual(linkedPrs(timeline({ source: prNode(1, { repository: null }) }, { subject: prNode(2) }), REPO), [entry(2)]);
});

test('linkedPrs lists each PR once, in timeline order', () => {
  const node = timeline({ source: prNode(5) }, { subject: prNode(4) }, { subject: prNode(5) }, { source: prNode(4) });
  assert.deepEqual(linkedPrs(node, REPO), [entry(5), entry(4)]);
});

test('linkedPrs returns an empty list for an issue without links', () => {
  assert.deepEqual(linkedPrs(timeline(), REPO), []);
});

test('updateLinkedPrs copies a PR state onto every issue that links it', () => {
  const a = { number: 10, type: 'issue', linkedPrs: [entry(1, { state: 'OPEN', mergedAt: null }), entry(2, { state: 'OPEN', mergedAt: null })] };
  const b = { number: 11, type: 'issue', linkedPrs: [entry(1, { state: 'OPEN', mergedAt: null, baseRefName: 'stack/x' })] };
  const c = { number: 12, type: 'issue', linkedPrs: [entry(3, { state: 'OPEN', mergedAt: null })] };
  const before = structuredClone([a, b, c]);
  const items = new Map([a, b, c].map((i) => [i.number, i]));
  const out = updateLinkedPrs(items, { number: 1, state: 'MERGED', mergedAt: '2026-10-25T00:00:00Z' });
  assert.deepEqual(out.get(10).linkedPrs, [entry(1, { mergedAt: '2026-10-25T00:00:00Z' }), entry(2, { state: 'OPEN', mergedAt: null })]);
  assert.deepEqual(out.get(11).linkedPrs, [entry(1, { mergedAt: '2026-10-25T00:00:00Z', baseRefName: 'stack/x' })]);
  assert.equal(out.get(12), c);
  assert.deepEqual([a, b, c], before, 'input items are not changed');
});

test('updateLinkedPrs records a PR closed without merging', () => {
  const items = new Map([[10, { number: 10, type: 'issue', linkedPrs: [entry(1, { state: 'OPEN', mergedAt: null })] }]]);
  const out = updateLinkedPrs(items, { number: 1, state: 'CLOSED', mergedAt: null });
  assert.deepEqual(out.get(10).linkedPrs, [entry(1, { state: 'CLOSED', mergedAt: null })]);
});

test('updateLinkedPrs leaves PRs and old cached issues without linkedPrs alone', () => {
  const old = { number: 10, type: 'issue' };
  const pr = { number: 11, type: 'pr', linkedIssues: [] };
  const out = updateLinkedPrs(new Map([[10, old], [11, pr]]), { number: 1, state: 'MERGED', mergedAt: '2026-10-25T00:00:00Z' });
  assert.equal(out.get(10), old);
  assert.equal(out.get(11), pr);
});

const comment = (body, over = {}) => ({ author: { login: 'teammate' }, authorAssociation: 'MEMBER', createdAt: '2026-10-20T00:00:00Z', url: 'https://github.com/expo/expo/issues/49378#issuecomment-1', body, ...over });
const refs = (comments) => commentRefs(comments, { repo: REPO, number: 49378 });
const refNumbers = (...bodies) => refs(bodies.map((body) => comment(body))).map((ref) => ref.number);
const by = (login = 'teammate', association = 'MEMBER') => ({ login, association });

test('commentRefs finds the PR a team member asks about, as on #49378', () => {
  assert.deepEqual(refs([comment('@Ubax does #49351 fix this?')]), [{ number: 49351, by: by() }]);
});

test('commentRefs reads only team members and expo-bot', () => {
  const comments = [
    comment('#1', { authorAssociation: 'OWNER', author: { login: 'owner' } }),
    comment('#2', { authorAssociation: 'COLLABORATOR', author: { login: 'collab' } }),
    comment('#3', { authorAssociation: 'NONE', author: { login: 'expo-bot' } }),
    comment('#4', { authorAssociation: 'CONTRIBUTOR', author: { login: 'reporter' } }),
    comment('#5', { authorAssociation: 'NONE', author: null }),
  ];
  assert.deepEqual(refs(comments), [{ number: 1, by: by('owner', 'OWNER') }, { number: 2, by: by('collab', 'COLLABORATOR') }, { number: 3, by: by('expo-bot', 'NONE') }]);
});

test('commentRefs reads PR and issue URLs of the same repository, compared without case', () => {
  assert.deepEqual(refNumbers('Opened https://github.com/expo/expo/pull/49400', 'See https://github.com/Expo/Expo/issues/12 and (https://github.com/expo/expo/pull/14#discussion_r1).'), [49400, 12, 14]);
});

test('commentRefs skips other repositories, anchors, words and the issue itself', () => {
  const bodies = [
    'other/repo#10 and https://github.com/other/repo/pull/11',
    'https://github.com/expo/expo/issues/49378#issuecomment-123 and https://example.com/?a=#13',
    'abc#14, #15abc, &#16; and #49378 itself',
  ];
  assert.deepEqual(refNumbers(...bodies), []);
});

test('commentRefs skips code blocks, inline code and quoted lines', () => {
  const body = ['```', '#20', '```', '~~~js', '#21', '~~~', 'Run `git show #22`', '> #23 was the cause', '  > #24', 'Fixed by #25', '```', '#26 in an unclosed block'].join('\n');
  assert.deepEqual(refNumbers(body), [25]);
});

test('commentRefs skips number 0 and numbers with a leading zero', () => {
  assert.deepEqual(refNumbers('#0, #000000, #0a0, #007 and https://github.com/expo/expo/pull/0'), []);
});

test('commentRefs counts a Markdown link by its URL only', () => {
  assert.deepEqual(refNumbers('[#123](https://github.com/facebook/react-native/pull/123)', '[#5](https://github.com/expo/expo/pull/5)', '[see #6](#notes)'), [5]);
});

test('commentRefs reads owner/name#N of the same repository, compared without case', () => {
  assert.deepEqual(refNumbers('expo/expo#456, Expo/Expo#457 and other/repo#458'), [456, 457]);
});

test('commentRefs skips numbers too large to be an issue', () => {
  assert.deepEqual(refNumbers('#1234567890 and https://github.com/expo/expo/pull/1234567890'), []);
});

test('commentRefs keeps the first comment that names each number, in order of mention', () => {
  const comments = [comment('#2, then #1'), comment('#1 and #3', { author: { login: 'later' }, authorAssociation: 'OWNER' })];
  assert.deepEqual(refs(comments), [{ number: 2, by: by() }, { number: 1, by: by() }, { number: 3, by: by('later', 'OWNER') }]);
});

const facts = (number, over = {}) => ({ number, title: `PR ${number}`, state: 'MERGED', mergedAt: '2026-10-20T00:00:00Z', baseRefName: 'main', ...over });
const openPr = { number: 100, type: 'pr', title: 'PR 100', baseRefName: 'feature' };
const openIssue = { number: 101, type: 'issue', linkedPrs: [] };
const ref = (number, login) => ({ number, by: by(login) });

test('refsToResolve lists numbers that are neither open items nor resolved, once each', () => {
  const items = new Map([[100, openPr], [101, openIssue]]);
  const resolved = new Map([[102, facts(102)], [103, null]]);
  const issues = [{ number: 1, commentRefs: [100, 101, 102, 103, 104, 105].map((n) => ref(n)) }, { number: 2, commentRefs: [ref(104), ref(106)] }, { number: 3 }];
  assert.deepEqual(refsToResolve(issues, items, resolved), [104, 105, 106]);
});

test('refsQuery asks for each number under an alias that readRefs reads back', () => {
  const query = refsQuery([49351, 7]);
  assert.match(query, /n49351: issueOrPullRequest\(number: 49351\) \{ __typename \.\.\. on PullRequest \{ number title state mergedAt baseRefName \} \}/);
  assert.match(query, /n7: issueOrPullRequest\(number: 7\)/);
  const repository = { n49351: { __typename: 'PullRequest', ...facts(49351) }, n7: { __typename: 'Issue' }, n9: null };
  assert.deepEqual(readRefs(repository), new Map([[49351, facts(49351)], [7, null]]));
});

test('lastingRefs keeps issues and merged PRs, but not open or closed PRs, which can reopen', () => {
  const resolved = new Map([[1, null], [2, facts(2)], [3, facts(3, { state: 'CLOSED', mergedAt: null })], [4, facts(4, { state: 'OPEN', mergedAt: null })]]);
  assert.deepEqual(lastingRefs(resolved), new Map([[1, null], [2, facts(2)]]));
});

test('withCommentLinks adds the merged PR a team comment names on #49378', () => {
  const pr = facts(49351, { title: 'Always use use in useLoaderData', baseRefName: '@ubax/always-use-use-in-useLoaderData' });
  const issue = { number: 49378, type: 'issue', linkedPrs: [], commentRefs: [ref(49351)] };
  const out = withCommentLinks(issue, new Map(), new Map([[49351, pr]]));
  assert.deepEqual(out.linkedPrs, [{ ...pr, via: 'comment', by: by() }]);
  assert.deepEqual(issue.linkedPrs, [], 'the input issue is not changed');
});

test('withCommentLinks takes open PRs from the items, drops issues and unknown numbers, and lets the timeline win', () => {
  const items = new Map([[100, openPr], [101, openIssue]]);
  const resolved = new Map([[100, facts(100, { state: 'CLOSED', mergedAt: null })], [103, null]]);
  const issue = { number: 1, type: 'issue', linkedPrs: [entry(10)], commentRefs: [ref(10), ref(100, 'a'), ref(101), ref(103), ref(999)] };
  assert.deepEqual(withCommentLinks(issue, items, resolved).linkedPrs, [entry(10), { number: 100, title: 'PR 100', state: 'OPEN', mergedAt: null, baseRefName: 'feature', via: 'comment', by: by('a') }]);
});

test('withCommentLinks replaces the comment links it added before', () => {
  const resolved = new Map([[2, facts(2)], [3, facts(3)]]);
  const once = withCommentLinks({ number: 1, type: 'issue', linkedPrs: [entry(10)], commentRefs: [ref(2)] }, new Map(), resolved);
  assert.deepEqual(withCommentLinks(once, new Map(), resolved), once);
  assert.deepEqual(withCommentLinks({ ...once, commentRefs: [ref(3)] }, new Map(), resolved).linkedPrs, [entry(10), { ...facts(3), via: 'comment', by: by() }]);
});

test('mergeCommentLinks keeps cached comment links next to a fresh timeline', () => {
  const cached = [entry(1, { via: 'comment', by: by() }), entry(2), entry(3, { via: 'comment', by: by() })];
  assert.deepEqual(mergeCommentLinks([entry(1)], cached), [entry(1), entry(3, { via: 'comment', by: by() })]);
});

test('updateLinkedPrs updates comment links and keeps who mentioned them', () => {
  const items = new Map([[10, { number: 10, type: 'issue', linkedPrs: [entry(1, { state: 'OPEN', mergedAt: null, via: 'comment', by: by() })] }]]);
  const out = updateLinkedPrs(items, { number: 1, state: 'MERGED', mergedAt: '2026-10-25T00:00:00Z' });
  assert.deepEqual(out.get(10).linkedPrs, [entry(1, { mergedAt: '2026-10-25T00:00:00Z', via: 'comment', by: by() })]);
});
