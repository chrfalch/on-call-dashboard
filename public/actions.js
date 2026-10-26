// Actions an agent recommendation can propose. Shared by the server (prompt, schema,
// validation) and the browser (apply button), so it stays pure data.
// `who` labels the rec's who in the UI, such as "Assign to alanjhughes"; the prompt shows the same label.
export const ACTIONS = [
  { id: 'verify', type: 'issue', apply: 'command', label: 'Ask bot to verify', who: 'By', body: '@expo-bot verify' },
  { id: 'ask-reporter', type: 'issue', apply: 'comment', label: 'Ask reporter', who: 'Ask' },
  { id: 'accept', type: 'issue', apply: 'github', label: 'Accept and assign', who: 'Assign to' },
  { id: 'assign-owner', type: 'issue', apply: 'github', label: 'Assign module owner', who: 'Assign to' },
  { id: 'close-duplicate', type: 'issue', apply: 'close', label: 'Close as duplicate', who: 'By', reason: 'duplicate' },
  { id: 'request-review', type: 'pr', apply: 'command', label: 'Ask bot to review', who: 'Review by', body: '@expo-bot review' },
  { id: 'review-note', type: 'pr', apply: 'comment', label: 'Leave review note', who: 'Tell' },
  { id: 'nudge-author', type: 'pr', apply: 'comment', label: 'Nudge author', who: 'Ask' },
  { id: 'merge', type: 'pr', apply: 'github', label: 'Merge', who: 'By' },
  { id: 'close', type: 'both', apply: 'close', label: 'Close', who: 'By', reason: 'completed' },
  { id: 'wait', type: 'both', apply: 'none', label: 'Wait', who: 'Waiting on' },
];
