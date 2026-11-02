const COMMAND_RE = /@expo-bot\s+\/?([a-z-]+)/i;
// A reporter's comment can start with a path such as "/Users/…", so a slash command ends at a word boundary.
const SLASH_COMMAND_RE = /^\s*\/([a-z-]+)(?![\w/])/i;
const COMMAND_ALIASES = { check: 'verify' };

// `text` runs from the command to the end of the body, so a retry keeps the request's own words.
export function parseCommand(body) {
  const m = body.match(COMMAND_RE) ?? body.match(SLASH_COMMAND_RE);
  if (!m) return null;
  const name = m[1].toLowerCase();
  return { command: COMMAND_ALIASES[name] ?? name, text: body.slice(m.index).trim() };
}
