import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeComments, parseAssessment, parseVerification, summarize } from './triage.mjs';

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
  assert.equal(r.bot.botRepliedAfterCommand, true);
});

test('a bare slash command from the team is a command, not a reply', () => {
  const report = c('reporter1', 'NONE', '2026-01-02T00:00:00Z', 'Still broken on SDK 55');
  const r = analyzeComments([report, c('kudo', 'MEMBER', '2026-01-03T00:00:00Z', '  /verify')], issue);
  assert.deepEqual(r.bot.lastCommand, { command: 'verify', by: 'kudo', at: '2026-01-03T00:00:00Z' });
  assert.equal(r.conversation.waitingOn, 'team');
  assert.equal(r.conversation.teamReplied, false);
  assert.equal(r.conversation.since, '2026-01-02T00:00:00Z');
});

test('a slash command with a long note still counts as a team reply', () => {
  const r = analyzeComments([c('kudo', 'MEMBER', '2026-01-02T00:00:00Z', '/verify can you also share your app.json please?')], issue);
  assert.equal(r.bot.lastCommand.command, 'verify');
  assert.equal(r.conversation.waitingOn, 'reporter');
  assert.equal(r.conversation.teamReplied, true);
});

test('a leading slash from a non-team member is a normal comment', () => {
  const r = analyzeComments([c('reporter1', 'NONE', '2026-01-02T00:00:00Z', '/verify')], issue);
  assert.equal(r.bot.lastCommand, null);
  assert.equal(r.conversation.lastHuman.role, 'reporter');
  assert.equal(r.conversation.since, '2026-01-02T00:00:00Z');
});

test('lastReview tracks the newest review command, not other commands', () => {
  const review = c('kudo', 'MEMBER', '2026-01-02T00:00:00Z', '@expo-bot review');
  const reply = c('expo-bot', 'NONE', '2026-01-02T01:00:00Z', 'Review done');
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

test('a team comment that starts with a path is not a command', () => {
  const r = analyzeComments([c('kudo', 'MEMBER', '2026-01-02T00:00:00Z', '/Users/x/app.json')], issue);
  assert.equal(r.bot.lastCommand, null);
  assert.equal(r.bot.lastReview, null);
  assert.equal(r.conversation.waitingOn, 'reporter');
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

test('summarize strips mentions, bold and links, and skips boilerplate', () => {
  assert.equal(summarize('---\n_Posted via expo-sandbox-mcp_'), null);
  assert.equal(
    summarize('\n\n@Ubax: **Reproduced on SDK 55. Removed in [#49204](https://x).** On SDK 58 it works.'),
    'Reproduced on SDK 55. Removed in #49204. On SDK 58 it works.'
  );
  assert.equal(summarize('@brentvatne — I could not reproduce it.\n\n**Result: inconclusive.**'), 'I could not reproduce it.');
});
