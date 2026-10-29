// Who wrote a comment: a bot or the team. Shared by the server (triage.mjs) and the browser.

export const BOT_LOGINS = new Set(['expo-bot', 'github-actions', 'codecov', 'dependabot']);
const TEAM_ASSOCIATIONS = new Set(['MEMBER', 'OWNER', 'COLLABORATOR']);

export function isBot(login) {
  return !login || BOT_LOGINS.has(login) || login.endsWith('[bot]');
}

export function isTeam(association) {
  return TEAM_ASSOCIATIONS.has(association);
}
