// Actions an agent recommendation can propose. Shared by the server (prompt, schema,
// validation) and the browser (apply button), so it stays pure data.
// `who` labels the rec's who in the UI, such as "Assign to alanjhughes"; the prompt shows the
// same label with `whoMeaning`, so the agent and the reader agree on whose name it is.
const ASSIGNEE = 'the person to assign, as a GitHub login. If no single person is known, a team or module owner name, or on-call';

export const ACTIONS = [
  { id: 'verify', type: 'issue', apply: 'command', label: 'Ask bot to verify', who: 'Done by', whoMeaning: 'the person who posts the command, usually on-call', body: '@expo-bot verify' },
  { id: 'ask-reporter', type: 'issue', apply: 'comment', label: 'Ask reporter', who: 'Ask', whoMeaning: 'the login of the reporter' },
  { id: 'accept', type: 'issue', apply: 'github', label: 'Accept and assign', who: 'Assign to', whoMeaning: ASSIGNEE },
  { id: 'assign-owner', type: 'issue', apply: 'github', label: 'Assign module owner', who: 'Assign to', whoMeaning: ASSIGNEE },
  { id: 'close-duplicate', type: 'issue', apply: 'close', label: 'Close as duplicate', who: 'Done by', whoMeaning: 'the person who closes it, usually on-call', reason: 'duplicate' },
  { id: 'request-review', type: 'pr', apply: 'command', label: 'Ask bot to review', who: 'Review by', whoMeaning: 'the maintainer who should review the pull request after the bot, or on-call', body: '@expo-bot review' },
  { id: 'review-note', type: 'pr', apply: 'comment', label: 'Leave review note', who: 'Tell', whoMeaning: 'the login of the pull request author' },
  { id: 'nudge-author', type: 'pr', apply: 'comment', label: 'Nudge author', who: 'Ask', whoMeaning: 'the login of the pull request author' },
  { id: 'merge', type: 'pr', apply: 'github', label: 'Merge', who: 'Done by', whoMeaning: 'the maintainer who should merge it, or on-call' },
  { id: 'close', type: 'both', apply: 'close', label: 'Close', who: 'Done by', whoMeaning: 'the person who closes it, usually on-call', reason: 'completed' },
  { id: 'wait', type: 'both', apply: 'none', label: 'Wait', who: 'Waiting on', whoMeaning: 'the person who owns the next step' },
];
