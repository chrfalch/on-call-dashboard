// Tooltip text for the chips and icons: what each one means and where its data comes from.
// Pure data, shared by the browser and the tests.

const AGENT = 'Agent recommendation (Claude), model output';
const BOT_TRIAGE = 'expo-bot triage comment';
const BOT_SANDBOX = 'expo-bot sandbox verification comment';
const REPLIES = 'Comment analysis of human replies';
const RANKING = 'Inbox ranking rules in the dashboard';

export const OUTCOME_TEXT = { problem: 'Reproduced', blocked: 'Blocked', pass: 'Not reproduced' };

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
  botCommand: { meaning: 'The last @expo-bot command, and whether the bot replied after it.', source: '@expo-bot commands in comments, and the replies from expo-bot' },
  waiting: { meaning: 'Who must act next, and for how long.', source: `${REPLIES}. Team means members, owners and collaborators of the repository.` },
  assessment: { meaning: 'The kind of issue and the confidence from the expo-bot triage. Click to open the comment.', source: BOT_TRIAGE },
  verdict: { meaning: 'Result of the expo-bot sandbox verification. Click to open the comment.', source: BOT_SANDBOX },
  verdictHeadline: { meaning: 'Summary of the expo-bot sandbox verification.', source: `${BOT_SANDBOX}, first paragraph` },
  fixPr: { meaning: 'Fix PR opened by expo-bot.', source: 'expo-bot comment that says it opened the pull request' },
  details: { meaning: 'Show the impact, the scope and the notes for maintainers and the reporter.', source: 'expo-bot triage and sandbox verification comments' },
  view: { meaning: 'Runbook view. Click to show only its items, in its order.', source: 'Fixed dashboard rule over the synced GitHub data, comment analysis and expo-bot comments' },
  activeFilter: { meaning: 'A filter that is on. Clear filters turns it off.', source: 'Your filters, kept in the page URL' },
  labelGroup: { meaning: 'Group of labels, and how many it shows. Click to collapse or expand it.', source: 'Dashboard grouping of GitHub label names' },
  reason: { meaning: 'Why this task is in the inbox, or why it ranks higher.', source: `${RANKING}, over GitHub data, comment analysis and expo-bot comments` },
  also: { meaning: 'Other tasks for this item. The inbox shows only the one with the highest priority.', source: RANKING },
  taskScore: { meaning: 'Priority score: task base + severity, waiting time, 👍, assignment', source: RANKING },
  recTag: { meaning: 'Recommendation from an AI agent. Check it before you act on it.', source: AGENT },
  recError: { meaning: 'The agent could not make a recommendation for this task.', source: AGENT },
  recWho: { meaning: 'The person or team that the agent names for this action.', source: AGENT },
  recConfidence: { meaning: 'Agent confidence', source: AGENT },
  recWhy: { meaning: 'The reason that the agent gives for this action.', source: AGENT },
  recDisagrees: { meaning: 'The agent recommends a different action than the task.', source: `${RANKING} and ${AGENT}` },
  recNext: { meaning: "The task's button applies the severity label. The agent counts that as done and recommends what comes after it.", source: `${RANKING} and ${AGENT}` },
  inboxCount: { meaning: 'Open inbox tasks in the current mode, without the ones that are done or snoozed.', source: `${RANKING}, over the synced GitHub data` },
  issueCount: { meaning: 'All open issues. Filters do not change this number.', source: 'GitHub: open issues, synced by the dashboard server' },
  prCount: { meaning: 'All open pull requests. Filters do not change this number.', source: 'GitHub: open pull requests, synced by the dashboard server' },
  inboxProgress: { meaning: 'Tasks you marked done or closed today, and the open tasks in the selected scope.', source: 'This browser (localStorage) and the inbox ranking rules' },
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
  pass: { meaning: 'expo-bot did not reproduce the problem in a sandbox. Click to open the comment.', source: BOT_SANDBOX },
};

// `meaning` replaces the entry's meaning for chips whose text depends on the item.
export const tooltip = (tip, meaning = tip.meaning) => `${meaning}\nSource: ${tip.source}`;
