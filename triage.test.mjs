import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeComments, botReview, ownerLastActivityAt, parseAssessment, parseVerification, summarize } from './triage.mjs';

const c = (login, authorAssociation, createdAt, body, url = `https://x/${createdAt}`) => ({ author: { login }, authorAssociation, createdAt, body, url });
const issue = { authorLogin: 'reporter1', authorAssociation: 'NONE', createdAt: '2026-01-01T00:00:00Z' };

test('parses triage assessment', () => {
  const a = parseAssessment(c('expo-bot', 'NONE', 't', `<!-- expo-triage:complete:v1 -->
**Bug** · 82% confidence

- **Severity:** S2 - Medium: Breakage in a narrower configuration.
- **Impact:** Things break.
- **Scope:** iOS only.`));
  assert.equal(a.kind, 'Bug');
  assert.equal(a.confidence, 82);
  assert.deepEqual(a.severity, { code: 'S2', label: 'severity: medium' });
  assert.equal(a.impact, 'Things break.');
  assert.equal(a.scope, 'iOS only.');
});

test('parses multi-word kinds', () => {
  assert.equal(parseAssessment(c('expo-bot', 'NONE', 't', '<!-- expo-triage:complete:v1 -->\n**Feature request** · 60% confidence')).kind, 'Feature request');
});

test('parses sandbox verification', () => {
  const v = parseVerification(c('expo-bot', 'NONE', 't', `<!-- expo-sandbox-attested:start -->
<!-- expo-sandbox-outcome:problem -->
**Outcome: problem**
<!-- expo-sandbox-attested:end -->

@brentvatne **Result: reproduced the mechanism on Windows.** More text.

**Reporter:** Nothing more is needed from you.

**Maintainer:** Review #52212. It is docs only.

<details>…</details>`));
  assert.equal(v.outcome, 'problem');
  assert.equal(v.headline, 'reproduced the mechanism on Windows. More text.');
  assert.equal(v.maintainer, 'Review #52212. It is docs only.');
  assert.equal(v.reporter, 'Nothing more is needed from you.');
});

test('no comments -> waiting on team since creation', () => {
  const r = analyzeComments([], issue);
  assert.equal(r.conversation.waitingOn, 'team');
  assert.equal(r.conversation.since, issue.createdAt);
  assert.equal(r.triage, null);
});

test('team reply -> waiting on reporter; reporter reply -> back to team', () => {
  const team = c('kudo', 'MEMBER', '2026-01-02T00:00:00Z', 'Can you share a repro?');
  assert.equal(analyzeComments([team], issue).conversation.waitingOn, 'reporter');
  const back = c('reporter1', 'NONE', '2026-01-03T00:00:00Z', 'Here it is');
  const r = analyzeComments([team, back], issue);
  assert.equal(r.conversation.waitingOn, 'team');
  assert.equal(r.conversation.lastHuman.role, 'reporter');
  assert.equal(r.conversation.since, '2026-01-03T00:00:00Z');
});

test('bot comments and bare @expo-bot commands are not replies', () => {
  const r = analyzeComments(
    [
      c('kudo', 'MEMBER', '2026-01-02T00:00:00Z', '@expo-bot verify'),
      c('expo-bot', 'NONE', '2026-01-02T01:00:00Z', 'Thank you for filing this issue!'),
      c('github-actions[bot]', 'NONE', '2026-01-02T02:00:00Z', 'Subscribed'),
    ],
    issue
  );
  assert.equal(r.conversation.waitingOn, 'team');
  assert.equal(r.conversation.teamReplied, false);
  assert.equal(r.bot.lastCommand.command, 'verify');
  assert.equal(r.bot.botRepliedAfterCommand, false);
});

test('a bare slash command from the team is a command, not a reply', () => {
  const report = c('reporter1', 'NONE', '2026-01-02T00:00:00Z', 'Still broken on SDK 55');
  const r = analyzeComments([report, c('kudo', 'MEMBER', '2026-01-03T00:00:00Z', '  /verify')], issue);
  assert.deepEqual(r.bot.lastCommand, { command: 'verify', by: 'kudo', at: '2026-01-03T00:00:00Z' });
  assert.equal(r.conversation.waitingOn, 'team');
  assert.equal(r.conversation.teamReplied, false);
  assert.equal(r.conversation.since, '2026-01-02T00:00:00Z');
});

test('a slash command with a long note is still a command, not a reply', () => {
  const r = analyzeComments([c('kudo', 'MEMBER', '2026-01-02T00:00:00Z', '/verify can you also share your app.json please?')], issue);
  assert.equal(r.bot.lastCommand.command, 'verify');
  assert.equal(r.conversation.waitingOn, 'team');
  assert.equal(r.conversation.teamReplied, false);
});

test('a leading slash from a non-team member is a normal comment', () => {
  const r = analyzeComments([c('reporter1', 'NONE', '2026-01-02T00:00:00Z', '/verify')], issue);
  assert.equal(r.bot.lastCommand, null);
  assert.equal(r.conversation.lastHuman.role, 'reporter');
  assert.equal(r.conversation.since, '2026-01-02T00:00:00Z');
});

test('an expo-bot comment edited after a command is a reply at its edit time', () => {
  const sticky = { ...c('expo-bot', 'NONE', '2026-01-01T00:00:00Z', '<!-- expo-ai-code-reviewer --> Review'), lastEditedAt: '2026-01-02T01:00:00Z' };
  const r = analyzeComments([sticky, c('kudo', 'MEMBER', '2026-01-02T00:00:00Z', '@expo-bot review')], issue);
  assert.deepEqual(r.bot.commandAnswer, { at: '2026-01-02T01:00:00Z', outcome: null });
  assert.equal(r.bot.botRepliedAfterReview, true);
  assert.equal(r.bot.botRepliedAfterCommand, true);
});

test('the answer to a command is the newest creation or edit time, whatever the comment order', () => {
  const sticky = { ...c('expo-bot', 'NONE', '2026-01-01T00:00:00Z', 'Review'), lastEditedAt: '2026-01-05T00:00:00Z' };
  const rebase = c('kudo', 'MEMBER', '2026-01-02T00:00:00Z', '@expo-bot rebase');
  const later = c('expo-bot', 'NONE', '2026-01-03T00:00:00Z', '<!-- expo-sandbox-outcome:pass -->');
  const r = analyzeComments([sticky, rebase, later], issue);
  assert.deepEqual(r.bot.commandAnswer, { at: '2026-01-05T00:00:00Z', outcome: null });
});

test('lastReview tracks the newest review command, not other commands', () => {
  const review = c('kudo', 'MEMBER', '2026-01-02T00:00:00Z', '@expo-bot review');
  const reply = c('expo-bot', 'NONE', '2026-01-02T01:00:00Z', '<!-- expo-ai-code-reviewer -->\nReview done');
  const rebase = c('kudo', 'MEMBER', '2026-01-03T00:00:00Z', '@expo-bot rebase');

  const reviewed = analyzeComments([review, reply, rebase], issue);
  assert.deepEqual(reviewed.bot.lastReview, { command: 'review', by: 'kudo', at: '2026-01-02T00:00:00Z' });
  assert.equal(reviewed.bot.botRepliedAfterReview, true);
  assert.equal(reviewed.bot.lastCommand.command, 'rebase');
  assert.equal(reviewed.bot.botRepliedAfterCommand, false);

  const earlier = c('expo-bot', 'NONE', '2026-01-01T12:00:00Z', 'Thank you for filing this issue!');
  const pending = analyzeComments([earlier, review, c('kudo', 'MEMBER', '2026-01-03T00:00:00Z', '/verify')], issue);
  assert.equal(pending.bot.lastReview.command, 'review');
  assert.equal(pending.bot.botRepliedAfterReview, false);

  const none = analyzeComments([c('kudo', 'MEMBER', '2026-01-02T00:00:00Z', '@expo-bot verify'), reply], issue);
  assert.equal(none.bot.lastReview, null);
  assert.equal(none.bot.botRepliedAfterReview, false);
});

const REVIEW_ANSWER = '<!-- expo-ai-code-reviewer -->\n## 🤖 AI code review';
const VERIFY_ANSWER = '<!-- expo-sandbox-outcome:pass -->\n**Outcome: pass** @kudo';
const TRIAGE_ANSWER = '<!-- expo-triage:complete:v1 -->\n**Bug** · 80% confidence';

test('a verify answer does not answer a review; an edit of the sticky review comment does', () => {
  const sticky = c('expo-bot', 'NONE', '2026-01-01T00:00:00Z', REVIEW_ANSWER);
  const review = c('kudo', 'MEMBER', '2026-01-02T00:00:00Z', '@expo-bot review');
  const outcome = c('expo-bot', 'NONE', '2026-01-02T01:00:00Z', VERIFY_ANSWER);

  const pending = analyzeComments([sticky, review, outcome], issue);
  assert.equal(pending.bot.botRepliedAfterReview, false);
  assert.equal(pending.bot.botRepliedAfterCommand, false);
  assert.equal(pending.bot.commandAnswer, null);

  const edited = analyzeComments([{ ...sticky, lastEditedAt: '2026-01-02T02:00:00Z' }, review, outcome], issue);
  assert.equal(edited.bot.botRepliedAfterReview, true);
  assert.equal(edited.bot.botRepliedAfterCommand, true);
  assert.deepEqual(edited.bot.commandAnswer, { at: '2026-01-02T02:00:00Z', outcome: null });
});

test('the answer to a command carries the sandbox outcome of that same comment', () => {
  const verify = c('kudo', 'MEMBER', '2026-01-02T00:00:00Z', '@expo-bot verify');
  const outcome = c('expo-bot', 'NONE', '2026-01-02T01:00:00Z', VERIFY_ANSWER);
  const review = { ...c('expo-bot', 'NONE', '2026-01-01T00:00:00Z', REVIEW_ANSWER), lastEditedAt: '2026-01-02T02:00:00Z' };
  assert.deepEqual(analyzeComments([review, verify, outcome], issue).bot.commandAnswer, { at: '2026-01-02T01:00:00Z', outcome: 'pass' });
});

test('there is no command answer without a command or without an answer of its kind after it', () => {
  const outcome = c('expo-bot', 'NONE', '2026-01-02T01:00:00Z', VERIFY_ANSWER);
  assert.equal(analyzeComments([outcome], issue).bot.commandAnswer, null);

  const before = c('expo-bot', 'NONE', '2026-01-01T12:00:00Z', VERIFY_ANSWER);
  const verify = c('kudo', 'MEMBER', '2026-01-02T00:00:00Z', '@expo-bot verify');
  assert.equal(analyzeComments([before, verify], issue).bot.commandAnswer, null);

  const triage = c('kudo', 'MEMBER', '2026-01-02T00:00:00Z', '@expo-bot triage');
  assert.equal(analyzeComments([triage, outcome], issue).bot.commandAnswer, null);
});

test('an expo-bot PR review entry does not answer a review', () => {
  const review = c('kudo', 'MEMBER', '2026-01-02T00:00:00Z', '@expo-bot review');
  const entry = { ...c('expo-bot', 'NONE', '2026-01-02T01:00:00Z', '(review: COMMENTED)'), review: 'COMMENTED' };
  assert.equal(analyzeComments([review, entry], issue).bot.botRepliedAfterReview, false);
});

test('the review fork hint does not answer a review', () => {
  const review = c('kudo', 'MEMBER', '2026-01-02T00:00:00Z', '@expo-bot review');
  const hint = c('expo-bot', 'NONE', '2026-01-02T01:00:00Z', '<!-- expo-ai-code-reviewer:fork-hint -->\nThis PR comes from a fork.');
  const r = analyzeComments([review, hint], issue);
  assert.equal(r.bot.botRepliedAfterReview, false);
  assert.equal(r.bot.botRepliedAfterCommand, false);
});

test('"/verify started" does not answer a verify; the outcome comment does', () => {
  const verify = c('kudo', 'MEMBER', '2026-01-02T00:00:00Z', '@expo-bot verify');
  const started = c('expo-bot', 'NONE', '2026-01-02T00:01:00Z', '🔍 `/verify` started for @kudo');
  assert.equal(analyzeComments([verify, started], issue).bot.botRepliedAfterCommand, false);

  const outcome = c('expo-bot', 'NONE', '2026-01-02T01:00:00Z', VERIFY_ANSWER);
  assert.equal(analyzeComments([verify, started, outcome], issue).bot.botRepliedAfterCommand, true);
});

test('"/verify failed" answers a verify', () => {
  const verify = c('kudo', 'MEMBER', '2026-01-02T00:00:00Z', '/verify');
  const failed = c('expo-bot', 'NONE', '2026-01-02T01:00:00Z', '⚠️ `/verify` failed before it could post findings.');
  assert.equal(analyzeComments([verify, failed], issue).bot.botRepliedAfterCommand, true);
});

test('the triage comment a verify posts first answers a triage command', () => {
  const triage = c('kudo', 'MEMBER', '2026-01-02T00:00:00Z', '@expo-bot triage');
  const first = c('expo-bot', 'NONE', '2026-01-02T01:00:00Z', `${TRIAGE_ANSWER}\n\nVerification is still running…`);
  assert.equal(analyzeComments([triage, first], issue).bot.botRepliedAfterCommand, true);
});

test('on a PR written by expo-bot, an outcome comment answers a work command', () => {
  const work = c('kudo', 'MEMBER', '2026-01-02T00:00:00Z', '@expo-bot fix the failing test');
  const outcome = c('expo-bot', 'NONE', '2026-01-02T01:00:00Z', VERIFY_ANSWER);
  const r = analyzeComments([work, outcome], { ...issue, authorLogin: 'expo-bot' });
  assert.equal(r.bot.lastCommand.command, 'fix');
  assert.equal(r.bot.botRepliedAfterCommand, true);
});

test('a team comment that starts with a path is not a command', () => {
  const r = analyzeComments([c('kudo', 'MEMBER', '2026-01-02T00:00:00Z', '/Users/x/app.json')], issue);
  assert.equal(r.bot.lastCommand, null);
  assert.equal(r.bot.lastReview, null);
  assert.equal(r.conversation.waitingOn, 'team');
});

test('community comments do not count as team replies', () => {
  const r = analyzeComments([c('kudo', 'MEMBER', '2026-01-02T00:00:00Z', 'Need repro'), c('someone', 'CONTRIBUTOR', '2026-01-03T00:00:00Z', 'Same here')], issue);
  assert.equal(r.conversation.waitingOn, 'team');
  assert.equal(r.conversation.lastHuman.role, 'community');
});

test('issues opened by the team are internal', () => {
  assert.equal(analyzeComments([], { ...issue, authorAssociation: 'MEMBER' }).conversation.waitingOn, 'internal');
});

test('collects fix PRs opened by the bot', () => {
  const r = analyzeComments([c('expo-bot', 'NONE', 't', '🔧 Opened https://github.com/expo/expo/pull/52054 with the verified fix')], issue);
  assert.deepEqual(r.triage.fixPrs, [52054]);
});

test('"@expo-bot <word>" from outside the team is a plain comment', () => {
  const r = analyzeComments([c('reporter1', 'NONE', '2026-01-02T00:00:00Z', '@expo-bot thanks')], issue);
  assert.equal(r.bot.lastCommand, null);
  assert.equal(r.conversation.lastHuman.role, 'reporter');
  assert.equal(r.conversation.lastReporterAt, '2026-01-02T00:00:00Z');
  assert.equal(r.conversation.since, '2026-01-02T00:00:00Z');
});

test('"check" from the team counts as verify', () => {
  assert.equal(analyzeComments([c('kudo', 'MEMBER', '2026-01-02T00:00:00Z', '@expo-bot check')], issue).bot.lastCommand.command, 'verify');
  assert.equal(analyzeComments([c('kudo', 'MEMBER', '2026-01-02T00:00:00Z', '/check')], issue).bot.lastCommand.command, 'verify');
});

test('a long @expo-bot command from the team is not a reply', () => {
  const report = c('reporter1', 'NONE', '2026-01-02T00:00:00Z', 'Still broken on SDK 55');
  const command = c('kudo', 'MEMBER', '2026-01-03T00:00:00Z', '@expo-bot verify this on SDK 55 with the repro from the issue body, please?');
  const r = analyzeComments([report, command], issue);
  assert.equal(r.bot.lastCommand.command, 'verify');
  assert.equal(r.conversation.waitingOn, 'team');
  assert.equal(r.conversation.teamReplied, false);
  assert.equal(r.conversation.lastTeamAt, null);
  assert.equal(r.conversation.since, '2026-01-02T00:00:00Z');
});

test('a team comment waits on the reporter only with a question or a mention of the author', () => {
  const waitingOn = (body) => analyzeComments([c('kudo', 'MEMBER', '2026-01-02T00:00:00Z', body)], issue).conversation.waitingOn;
  assert.equal(waitingOn('Which SDK version do you use?'), 'reporter');
  assert.equal(waitingOn('@reporter1 please share a repro.'), 'reporter');
  assert.equal(waitingOn('Thanks @Reporter1, looking.'), 'reporter');
  assert.equal(waitingOn('@reporter1'), 'reporter');
  assert.equal(waitingOn('cc @reporter1-x'), 'team');
  assert.equal(waitingOn('cc @reporter12'), 'team');
  assert.equal(waitingOn('cc @other, can you look.'), 'team');
  assert.equal(waitingOn('Thanks, we will look into it.'), 'team');
});

test('a team review entry waits on the reporter', () => {
  const reviewEntry = { ...c('kudo', 'MEMBER', '2026-01-02T00:00:00Z', '(review: CHANGES_REQUESTED)'), review: 'CHANGES_REQUESTED' };
  const r = analyzeComments([reviewEntry], issue);
  assert.equal(r.conversation.waitingOn, 'reporter');
  assert.equal(r.conversation.lastTeamAt, '2026-01-02T00:00:00Z');
});

test('items opened by the team stay internal whatever the comments say', () => {
  const r = analyzeComments([c('kudo', 'MEMBER', '2026-01-02T00:00:00Z', 'Can you check?')], { ...issue, authorAssociation: 'MEMBER' });
  assert.equal(r.conversation.waitingOn, 'internal');
});

test('lastTeamAt and lastReporterAt are the newest plain comments, null when none', () => {
  const none = analyzeComments([], issue).conversation;
  assert.equal(none.lastTeamAt, null);
  assert.equal(none.lastReporterAt, null);

  const r = analyzeComments(
    [
      c('reporter1', 'NONE', '2026-01-02T00:00:00Z', 'It crashes'),
      c('kudo', 'MEMBER', '2026-01-03T00:00:00Z', 'Which device?'),
      c('reporter1', 'NONE', '2026-01-04T00:00:00Z', 'Pixel 8'),
      c('someone', 'CONTRIBUTOR', '2026-01-05T00:00:00Z', 'Same here'),
      c('kudo', 'MEMBER', '2026-01-06T00:00:00Z', '@expo-bot verify'),
      c('reporter1', 'NONE', '2026-01-07T00:00:00Z', '@expo-bot verify'),
    ],
    issue
  ).conversation;
  assert.equal(r.lastTeamAt, '2026-01-03T00:00:00Z');
  assert.equal(r.lastReporterAt, '2026-01-07T00:00:00Z');
});

const verdict = (createdAt, outcome, lastEditedAt) => ({ ...c('expo-bot', 'NONE', createdAt, `<!-- expo-sandbox-outcome:${outcome} -->`), lastEditedAt });

test('an edited verdict is dated at its edit time', () => {
  const r = analyzeComments([verdict('2026-01-02T00:00:00Z', 'pass', '2026-01-09T00:00:00Z')], issue);
  assert.equal(r.triage.verification.at, '2026-01-09T00:00:00Z');
  assert.equal(analyzeComments([verdict('2026-01-02T00:00:00Z', 'pass', null)], issue).triage.verification.at, '2026-01-02T00:00:00Z');
});

test('the verdict edited or created last wins', () => {
  const older = verdict('2026-01-02T00:00:00Z', 'problem', '2026-01-09T00:00:00Z');
  const newer = verdict('2026-01-05T00:00:00Z', 'pass', null);
  const r = analyzeComments([older, newer], issue);
  assert.equal(r.triage.verification.outcome, 'problem');
  assert.equal(r.triage.verification.at, '2026-01-09T00:00:00Z');
  assert.equal(analyzeComments([verdict('2026-01-02T00:00:00Z', 'problem', null), newer], issue).triage.verification.outcome, 'pass');
});

test('the "needs more info" label waits on the reporter until they answer, but not on team-opened items', () => {
  const report = c('reporter1', 'NONE', '2026-01-02T00:00:00Z', 'Here is more detail');
  const labeled = { ...issue, labels: [{ name: 'Needs More Info' }] };
  const answered = analyzeComments([report], labeled).conversation;
  assert.equal(answered.waitingOn, 'team');
  assert.equal(answered.since, '2026-01-02T00:00:00Z');
  const teamLast = analyzeComments([report, c('kudo', 'MEMBER', '2026-01-03T00:00:00Z', 'Thanks, looking.')], labeled).conversation;
  assert.equal(teamLast.waitingOn, 'reporter');
  assert.equal(teamLast.since, '2026-01-03T00:00:00Z');
  assert.equal(analyzeComments([], labeled).conversation.waitingOn, 'reporter');
  assert.equal(analyzeComments([report], { ...labeled, authorAssociation: 'MEMBER' }).conversation.waitingOn, 'internal');
  assert.equal(analyzeComments([report], { ...issue, labels: [{ name: 'needs review' }] }).conversation.waitingOn, 'team');
});

test('summarize strips mentions, bold and links, and skips boilerplate', () => {
  assert.equal(summarize('---\n_Posted via expo-sandbox-mcp_'), null);
  assert.equal(
    summarize('\n\n@Ubax: **Reproduced on SDK 55. Removed in [#49204](https://x).** On SDK 58 it works.'),
    'Reproduced on SDK 55. Removed in #49204. On SDK 58 it works.'
  );
  assert.equal(summarize('@brentvatne — I could not reproduce it.\n\n**Result: inconclusive.**'), 'I could not reproduce it.');
});

const assigned = (login, createdAt) => ({ createdAt, assignee: { login } });

test('ownerLastActivityAt takes the newest of an assignee comment and their assignment', () => {
  const owners = [{ login: 'alice' }];
  assert.equal(ownerLastActivityAt([c('alice', 'MEMBER', '2026-01-03T00:00:00Z', 'on it')], owners, [assigned('alice', '2026-01-02T00:00:00Z')]), '2026-01-03T00:00:00Z');
  assert.equal(ownerLastActivityAt([c('alice', 'MEMBER', '2026-01-01T00:00:00Z', 'on it')], owners, [assigned('alice', '2026-01-02T00:00:00Z')]), '2026-01-02T00:00:00Z');
});

test('ownerLastActivityAt ignores non-assignee comments and since-unassigned users', () => {
  const comments = [c('alice', 'MEMBER', '2026-01-02T00:00:00Z', 'x'), c('bob', 'MEMBER', '2026-01-05T00:00:00Z', 'y')];
  const events = [assigned('alice', '2026-01-01T00:00:00Z'), assigned('carol', '2026-01-06T00:00:00Z')];
  assert.equal(ownerLastActivityAt(comments, [{ login: 'alice' }], events), '2026-01-02T00:00:00Z');
  assert.equal(ownerLastActivityAt([c('bob', 'MEMBER', '2026-01-05T00:00:00Z', 'y')], [{ login: 'alice' }], []), null);
});

test('ownerLastActivityAt is null without assignees and tolerates missing authors', () => {
  assert.equal(ownerLastActivityAt([c('alice', 'MEMBER', '2026-01-02T00:00:00Z', 'x')], [], [assigned('alice', '2026-01-01T00:00:00Z')]), null);
  const ghost = { author: null, createdAt: '2026-01-09T00:00:00Z', body: 'x' };
  const deletedAssignee = { createdAt: '2026-01-09T00:00:00Z', assignee: null };
  assert.equal(ownerLastActivityAt([ghost], [{ login: 'alice' }], [deletedAssignee, assigned('alice', '2026-01-01T00:00:00Z')]), '2026-01-01T00:00:00Z');
});

const review = (login, state, submittedAt) => ({ state, submittedAt, author: login ? { login } : null });

test('botReview picks the newest submitted expo-bot review', () => {
  const reviews = [
    review('expo-bot', 'COMMENTED', '2026-01-01T00:00:00Z'),
    review('expo-bot', 'CHANGES_REQUESTED', '2026-01-03T00:00:00Z'),
    review('alice', 'APPROVED', '2026-01-04T00:00:00Z'),
    review('expo-bot', 'PENDING', null),
    review(null, 'COMMENTED', '2026-01-05T00:00:00Z'),
  ];
  assert.deepEqual(botReview(reviews), { state: 'CHANGES_REQUESTED', at: '2026-01-03T00:00:00Z' });
});

test('botReview is null without a submitted expo-bot review', () => {
  assert.equal(botReview([]), null);
  assert.equal(botReview([review('alice', 'APPROVED', '2026-01-04T00:00:00Z'), review('expo-bot', 'PENDING', null)]), null);
});
