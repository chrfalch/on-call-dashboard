// Tooltip text for the chips and icons: what each one means and where its data comes from.
// Pure data, shared by the browser and the tests.

const AGENT = 'Agent recommendation (Claude), model output';
const BOT_TRIAGE = 'expo-bot triage comment';
const BOT_SANDBOX = 'expo-bot sandbox verification comment';
const REPLIES = 'Comment analysis of human replies';
const RANKING = 'Inbox ranking rules in the dashboard';

export const OUTCOME_TEXT = { problem: 'Reproduced', blocked: 'Blocked', pass: 'Passed' };

export const CHIP_TIPS = {
  label: { meaning: 'GitHub label. Click to filter by it, Alt-click to exclude it.', source: 'GitHub: labels on the item' },
  suggestedSeverity: { meaning: 'The severity that expo-bot suggests for this issue.', source: BOT_TRIAGE },
  assignee: { meaning: 'Assigned on GitHub. Click to filter by this person.', source: 'GitHub: assignees' },
  issueState: { meaning: 'Open issue.', source: 'GitHub: issue state' },
  prState: { meaning: 'Open pull request.', source: 'GitHub: pull request state' },
  draftState: { meaning: 'Draft pull request.', source: 'GitHub: pull request draft flag' },
  draft: { meaning: 'The author marked this pull request as a draft. It is not ready for review.', source: 'GitHub: pull request draft flag' },
  checks: { meaning: 'Combined result of the status checks.', source: 'GitHub: status checks on the latest commit' },
  approved: { meaning: 'The required reviewers approved this pull request.', source: 'GitHub: pull request review decision' },
  changesRequested: { meaning: 'A reviewer requested changes.', source: 'GitHub: pull request review decision' },
  reviewRequired: { meaning: 'This pull request needs an approving review before it can merge.', source: 'GitHub: pull request review decision' },
  conflicts: { meaning: 'This pull request has merge conflicts with its base branch.', source: 'GitHub: pull request mergeable state' },
  linkedIssue: { meaning: 'An issue that this pull request closes when it merges.', source: 'GitHub: closing keywords such as “Fixes #123”, or the Development sidebar' },
  diffstat: { meaning: 'Lines added and removed.', source: 'GitHub: pull request diff stats' },
  thumbsUp: { meaning: 'Number of 👍 reactions on the issue or pull request.', source: 'GitHub: reactions' },
  comments: { meaning: 'Number of comments.', source: 'GitHub: comment count' },
  botCommand: { meaning: 'The last @expo-bot command, and whether the bot answered it. A review needs the bot\'s review comment, a verify its verification result or its "/verify failed" comment, a triage its triage comment; any bot comment answers other commands.', source: '@expo-bot commands in comments, and the replies from expo-bot' },
  waiting: { meaning: 'Who must act next, and for how long.', source: `${REPLIES}. Team means members, owners and collaborators of the repository.` },
  assessment: { meaning: 'The kind of issue and the confidence from the expo-bot triage. Click to open the comment.', source: BOT_TRIAGE },
  verdict: { meaning: 'Result of the expo-bot sandbox verification. Click to open the comment.', source: BOT_SANDBOX },
  verdictHeadline: { meaning: 'Summary of the expo-bot sandbox verification.', source: `${BOT_SANDBOX}, first paragraph` },
  fixPr: { meaning: 'Fix PR opened by expo-bot.', source: 'expo-bot comment that says it opened the pull request' },
  details: { meaning: 'Show the impact, the scope and the notes for maintainers and the reporter.', source: 'expo-bot triage and sandbox verification comments' },
  view: { meaning: 'Runbook view. Click to show only its items, in its order.', source: 'Fixed dashboard rule over the synced GitHub data, comment analysis and expo-bot comments' },
  activeFilter: { meaning: 'A filter that is on. Clear filters turns it off.', source: 'Your filters, kept in the page URL' },
  labelGroup: { meaning: 'Group of labels, and how many it shows. Click to collapse or expand it.', source: 'Dashboard grouping of GitHub label names' },
  recTag: { meaning: 'Recommendation from an AI agent. Check it before you act on it.', source: AGENT },
  recError: { meaning: 'The agent could not make a recommendation for this task.', source: AGENT },
  recWho: { meaning: 'The person or team that the agent names for this action.', source: AGENT },
  recConfidence: { meaning: 'Agent confidence', source: AGENT },
  recWhy: { meaning: 'The reason that the agent gives for this action.', source: AGENT },
  recDisagrees: { meaning: 'The agent recommends a different action than the task.', source: `${RANKING} and ${AGENT}` },
  recNext: { meaning: "The task's button applies the severity label. The agent counts that as done and recommends what comes after it.", source: `${RANKING} and ${AGENT}` },
  issueCount: { meaning: 'All open issues. Filters do not change this number.', source: 'GitHub: open issues, synced by the dashboard server' },
  prCount: { meaning: 'All open pull requests. Filters do not change this number.', source: 'GitHub: open pull requests, synced by the dashboard server' },
  inboxProgress: {
    meaning: 'Items you marked done or closed from the Inbox today, split into issues and PRs. The chart shows the items done each day since Monday.',
    source: "This browser's own record (localStorage)",
  },
  syncStatus: { meaning: 'When the dashboard server last synced with GitHub. It syncs changes every 2 minutes and everything every hour.', source: 'Dashboard server' },
  signedIn: { meaning: 'The GitHub account that the buttons post as. Click to change or remove the token.', source: 'GitHub: the user that your token belongs to' },
};

export const TASK_TIPS = {
  'assign-repro': { meaning: 'Issues that expo-bot verified and reproduced, with nobody assigned. Read the bot result, then assign an owner.', source: `${BOT_SANDBOX}, and GitHub assignees` },
  merge: { meaning: 'Pull requests that are approved, with passing checks and no conflicts. Merge them.', source: 'GitHub: checks, mergeable state and review decision' },
  reply: { meaning: 'Issues where the team replied before, but the last human comment is from someone outside the team. Reply to it.', source: REPLIES },
  'first-response': { meaning: 'Issues where nobody from the team replied yet, newest reports ranked highest. Give a first response.', source: REPLIES },
  verify: { meaning: 'Issues opened in the last 30 days that have no @expo-bot command and no bot verification yet. Ask expo-bot to verify, so it tries to reproduce the bug.', source: '@expo-bot commands in comments, and the expo-bot sandbox verification comments' },
  review: { meaning: 'Pull requests that need a review, with passing checks and no conflicts, where expo-bot replied to the last review command. Review them.', source: 'GitHub: checks, mergeable state and review decision, and the replies from expo-bot' },
  're-review': { meaning: 'Pull requests with changes requested, where the author replied, pushed or asked for a review again since then. Review them again; on-call sees them only when nobody owns the pull request.', source: 'GitHub: review decision, reviews, last commit and requested reviewers, and comments' },
  'human-review': { meaning: 'Pull requests that expo-bot reviewed, with passing checks and no conflicts, but no requested reviewer. Request a reviewer from the team.', source: 'GitHub: checks, mergeable state, review decision and requested reviewers, and the replies from expo-bot' },
  'bot-review': { meaning: 'Pull requests that need a review, with passing checks and no conflicts, where nobody asked expo-bot to review yet. Ask expo-bot to review first.', source: 'GitHub: checks, mergeable state and review decision, and @expo-bot commands in comments' },
  'fix-severity': { meaning: 'Issues where expo-bot suggests a severity label that the issue does not have. Apply the suggestion or fix the label.', source: `${BOT_TRIAGE}, and GitHub labels` },
  nudge: { meaning: 'Approved pull requests that have conflicts or failing checks; on-call sees them after 60 days without activity. Ask the author to update them.', source: 'GitHub: review decision, mergeable state and checks' },
  'close-candidate': { meaning: 'Issues with a merged pull request that GitHub links as a fix or that a team member named. Check that the fix shipped, then close the issue.', source: 'Linked PRs from the GitHub timeline and team comments' },
  close: { meaning: 'Issues with no open fix where the reporter is silent for 14 days, or where expo-bot could not reproduce the bug and nobody replied for 7 days, and pull requests with requested changes and no activity for 60 days. Close them if nothing changed.', source: `${REPLIES}, and the ${BOT_SANDBOX}` },
  'unsupported-sdk': { meaning: 'Issues and pull requests whose SDK labels are all marked unsupported in the Supported SDKs menu. Close them with a comment that asks to check a supported SDK.', source: 'GitHub sdk-* labels, and the unsupported SDKs you marked in this browser' },
  'bot-triage': { meaning: 'Issues and pull requests without a platform or SDK label that expo-bot has not triaged. Post “@expo-bot triage” so the bot adds platform, SDK and severity labels.', source: `GitHub labels, and the ${BOT_TRIAGE}s` },
};

export const STATE_TIPS = {
  I1: { meaning: 'New issue that still needs expo-bot triage.', source: 'GitHub labels and expo-bot comments' },
  I2: { meaning: 'Issue waiting for expo-bot to finish triage or verification.', source: '@expo-bot commands and replies' },
  I3: { meaning: 'Issue that needs verification before it can move forward.', source: 'expo-bot triage and sandbox verification comments' },
  I4: { meaning: 'Issue waiting for more information from the reporter.', source: REPLIES },
  I5: { meaning: 'Issue that expo-bot could not reproduce.', source: BOT_SANDBOX },
  I6: { meaning: 'Issue that expo-bot reproduced and that needs an owner.', source: `${BOT_SANDBOX} and GitHub assignees` },
  I7: { meaning: 'Accepted or reproduced issue waiting for a fix pull request.', source: 'GitHub labels, assignees and linked pull requests' },
  I8: { meaning: 'Issue with an open linked fix pull request.', source: 'GitHub linked pull requests' },
  I9: { meaning: 'Issue whose linked fix pull request has merged.', source: 'GitHub linked pull requests' },
  I10: { meaning: 'Closed issue.', source: 'GitHub issue state' },
  P1: { meaning: 'Draft pull request that is not ready for review.', source: 'GitHub pull request draft flag' },
  P2: { meaning: 'Pull request that has not yet asked expo-bot for a review.', source: '@expo-bot review commands' },
  P3: { meaning: 'Pull request waiting for expo-bot to finish its review.', source: '@expo-bot review commands and replies' },
  P4: { meaning: 'Pull request where a reviewer requested changes.', source: 'GitHub pull request review decision' },
  P5: { meaning: 'Pull request whose author acted after changes were requested.', source: 'GitHub reviews, commits, requested reviewers and comments' },
  P11: { meaning: 'Pull request with GitHub Actions runs that wait for a maintainer to approve them, after the expo-bot review. Never for pull requests by github-actions.', source: 'GitHub Actions check suites on the last commit and expo-bot replies' },
  P6: { meaning: 'Pull request ready for a human reviewer.', source: 'GitHub pull request reviews and expo-bot replies' },
  P7: { meaning: 'Pull request with human review activity or a requested reviewer.', source: 'GitHub reviews and requested reviewers' },
  P8: { meaning: 'Approved pull request ready to merge.', source: 'GitHub pull request review decision' },
  P9: { meaning: 'Merged pull request.', source: 'GitHub pull request state' },
  P10: { meaning: 'Pull request closed without merging.', source: 'GitHub pull request state' },
};

export const CLEANUP_TIPS = {
  C1: { meaning: 'Issue where the team has owed a reply for at least seven days. With the "needs more info" label, only after the reporter answered.', source: REPLIES },
  C2: { meaning: 'Issue that has waited on the reporter for at least 14 days: the team asked a question, mentioned the reporter or reviewed, or the issue has the "needs more info" label and the reporter has not answered.', source: `${REPLIES}, and the "needs more info" label` },
  C3: { meaning: 'Issue still open seven days after expo-bot could not reproduce it.', source: `${BOT_SANDBOX}. The seven days start at the last edit of that comment.` },
  C4: { meaning: 'Item whose SDK labels are all marked unsupported.', source: 'GitHub sdk-* labels and your unsupported SDK settings' },
  C5: { meaning: 'Unlabeled and unowned issue that fell through normal triage.', source: 'GitHub labels and assignees' },
  C7: { meaning: 'Pull request left with requested changes for at least 21 days.', source: 'GitHub pull request reviews' },
  C8: { meaning: 'Issue waiting for a PR, with no open fix PR and no owner activity for seven days. Also a PR in human review, at least seven days old, whose assignees or requested reviewers have not commented or reviewed in seven days.', source: 'GitHub assignees, review requests, comments, reviews and linked pull requests' },
  C9: { meaning: 'Approved pull request blocked by conflicts, checks or its merge state.', source: 'GitHub review decision, checks and merge state' },
  C10: { meaning: 'Item waiting at least one day for expo-bot to answer a command or review request.', source: '@expo-bot commands and replies' },
  C11: { meaning: 'Open, non-draft pull request from an outside human contributor with no linked or fixed issues. Its title must contain the word fix, fixes, fixed or bug, or a label must contain bug (case-insensitive).', source: 'GitHub closing references, the Development sidebar, and the pull request title, labels and author' },
};

export const ACTION_TIPS = {
  verify: { meaning: 'Post “@expo-bot verify” so the bot tries to reproduce the issue in a sandbox.', source: AGENT },
  'ask-reporter': { meaning: 'Ask the reporter for missing information. The draft opens for you to edit before it posts.', source: AGENT },
  accept: { meaning: 'Accept the issue and assign it. The button opens the issue on GitHub.', source: AGENT },
  'assign-owner': { meaning: 'Assign the owner of the affected module. The button opens the issue on GitHub.', source: AGENT },
  'close-duplicate': { meaning: 'Close as a duplicate of an existing issue. The close dialog opens with the draft from the agent.', source: AGENT },
  'request-review': { meaning: 'Post “@expo-bot review” so the bot reviews the pull request.', source: AGENT },
  'review-note': { meaning: 'Comment with review feedback. The draft opens for you to edit before it posts.', source: AGENT },
  'nudge-author': { meaning: 'Ask the author to update the pull request. The draft opens for you to edit before it posts.', source: AGENT },
  merge: { meaning: 'Merge the pull request. The button opens it on GitHub.', source: AGENT },
  close: { meaning: 'Close the item. The close dialog opens with the draft from the agent.', source: AGENT },
  wait: { meaning: 'Do nothing now. Someone else owns the next step.', source: AGENT },
};

export const OUTCOME_TIPS = {
  problem: { meaning: 'expo-bot reproduced the problem in a sandbox. Click to open the comment.', source: BOT_SANDBOX },
  blocked: { meaning: 'expo-bot could not finish the reproduction in a sandbox. Click to open the comment.', source: BOT_SANDBOX },
  pass: { meaning: 'expo-bot passed the sandbox check: on a pull request the fix usually works, on an issue expo-bot did not reproduce the problem or could not verify it. Click to open the comment.', source: BOT_SANDBOX },
};

// `meaning` replaces the entry's meaning for chips whose text depends on the item.
export const tooltip = (tip, meaning = tip.meaning) => `${meaning}\nSource: ${tip.source}`;
