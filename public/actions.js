// Actions an agent recommendation can propose. Shared by the server (prompt, schema,
// validation) and the browser (apply button), so it stays pure data.
export const ACTIONS = [
  { id: 'verify', type: 'issue', apply: 'command', label: 'Ask bot to verify', body: '@expo-bot verify' },
  { id: 'ask-reporter', type: 'issue', apply: 'comment', label: 'Ask reporter' },
  { id: 'accept', type: 'issue', apply: 'github', label: 'Accept and assign' },
  { id: 'assign-owner', type: 'issue', apply: 'github', label: 'Assign module owner' },
  { id: 'close-duplicate', type: 'issue', apply: 'close', label: 'Close as duplicate', reason: 'duplicate' },
  { id: 'request-review', type: 'pr', apply: 'command', label: 'Ask bot to review', body: '@expo-bot review' },
  { id: 'review-note', type: 'pr', apply: 'comment', label: 'Leave review note' },
  { id: 'nudge-author', type: 'pr', apply: 'comment', label: 'Nudge author' },
  { id: 'merge', type: 'pr', apply: 'github', label: 'Merge' },
  { id: 'close', type: 'both', apply: 'close', label: 'Close', reason: 'completed' },
  { id: 'wait', type: 'both', apply: 'none', label: 'Wait' },
];
