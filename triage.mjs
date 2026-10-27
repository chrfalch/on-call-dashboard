// Derives triage signals from an issue/PR's recent comments:
//  - what expo-bot concluded (triage assessment, sandbox verification, fix PRs)
//  - who the conversation is waiting on (team vs. reporter)

export const BOT_LOGINS = new Set(['expo-bot', 'github-actions', 'codecov', 'dependabot']);
const TEAM_ASSOCIATIONS = new Set(['MEMBER', 'OWNER', 'COLLABORATOR']);
const COMMAND_RE = /@expo-bot\s+\/?([a-z-]+)/i;
// Team-only: a reporter's comment can start with a path such as "/Users/…".
const SLASH_COMMAND_RE = /^\s*\/([a-z-]+)(?![\w/])/i;

export function isBot(login) {
  return !login || BOT_LOGINS.has(login) || login.endsWith('[bot]');
}

export function isTeam(association) {
  return TEAM_ASSOCIATIONS.has(association);
}

// "- **Severity:** S2 - Medium: Breakage in …" -> { code: 'S2', label: 'severity: medium' }
function parseSeverity(body) {
  const m = body.match(/\*\*Severity:\*\*\s*(S\d)\s*-\s*([A-Za-z]+)/);
  return m ? { code: m[1], label: `severity: ${m[2].toLowerCase()}` } : null;
}

function field(body, name) {
  const m = body.match(new RegExp(`^- \\*\\*${name}:\\*\\*\\s*(.+)$`, 'm'));
  return m ? m[1].trim() : null;
}

function paragraph(body, heading) {
  const m = body.match(new RegExp(`\\*\\*${heading}:\\*\\*\\s*([\\s\\S]*?)(?:\\n\\s*\\n|$)`));
  return m ? m[1].trim() : null;
}

// expo-bot's triage comment (<!-- expo-triage:complete:v1 -->).
export function parseAssessment(c) {
  if (!c.body.includes('<!-- expo-triage:complete')) return null;
  const head = c.body.match(/\*\*([^*]+)\*\*\s*·\s*(\d+)%\s*confidence/);
  return {
    kind: head?.[1] ?? null,
    confidence: head ? Number(head[2]) : null,
    severity: parseSeverity(c.body),
    impact: field(c.body, 'Impact'),
    scope: field(c.body, 'Scope'),
    url: c.url,
    at: c.createdAt,
  };
}

// expo-bot's sandbox verification comment (<!-- expo-sandbox-outcome:… -->).
export function parseVerification(c) {
  const outcome = c.body.match(/<!-- expo-sandbox-outcome:([a-z-]+) -->/)?.[1];
  if (!outcome) return null;
  const afterAttest = c.body.split('<!-- expo-sandbox-attested:end -->')[1] ?? c.body;
  // The write-up usually follows the attestation block, but some comments put it first.
  const beforeAttest = c.body.split('<!-- expo-sandbox-attested:start -->')[0];
  return {
    outcome,
    headline: summarize(afterAttest) ?? summarize(beforeAttest),
    maintainer: paragraph(afterAttest, 'Maintainer'),
    reporter: paragraph(afterAttest, 'Reporter'),
    url: c.url,
    at: c.createdAt,
  };
}

// First real paragraph of the bot's write-up, e.g.
// "@brentvatne **Reproduced** on an Android emulator with …" -> "Reproduced on an Android emulator with …"
export function summarize(text) {
  const para = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p && !/^(---|_|<|\*\*(Reporter|Maintainer):)/.test(p));
  if (!para) return null;
  const clean = para
    .replace(/^@[\w-]+\s*[—:-]?\s*/, '')
    .replace(/\*\*/g, '')
    .replace(/^Result:\s*/i, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ');
  // Split only on sentence ends followed by whitespace, so "58.0.23" stays intact.
  const sentences = clean.split(/(?<=[.!?])\s+(?=[A-Z`"(])/);
  let out = '';
  for (const sentence of sentences) {
    if (out && (out + ' ' + sentence).length > 220) break;
    out += (out ? ' ' : '') + sentence;
  }
  return (out || clean).trim().slice(0, 260);
}

export function analyzeComments(comments, { authorLogin, authorAssociation, createdAt }) {
  let assessment = null;
  let verification = null;
  const fixPrs = [];
  let lastCommand = null;
  let lastReview = null;
  let lastBotReply = null;
  let lastHuman = null;
  let teamReplies = 0;

  for (const c of comments) {
    const login = c.author?.login;
    if (isBot(login)) {
      if (login === 'expo-bot') {
        lastBotReply = { at: c.createdAt, outcome: c.body.match(/<!-- expo-sandbox-outcome:([a-z-]+) -->/)?.[1] ?? null };
        assessment = parseAssessment(c) ?? assessment;
        verification = parseVerification(c) ?? verification;
        for (const m of c.body.matchAll(/Opened https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/g)) fixPrs.push(Number(m[1]));
      }
      continue;
    }
    const cmd = c.body.match(COMMAND_RE) ?? (isTeam(c.authorAssociation) ? c.body.match(SLASH_COMMAND_RE) : null);
    if (cmd) {
      lastCommand = { command: cmd[1].toLowerCase(), by: login, at: c.createdAt };
      if (lastCommand.command === 'review') lastReview = lastCommand;
      // A bare "@expo-bot verify" or "/verify" is an action, not a reply to the reporter.
      if (c.body.replace(cmd[0], '').trim().length < 20) continue;
    }
    const role = isTeam(c.authorAssociation) ? 'team' : login === authorLogin ? 'reporter' : 'community';
    if (role === 'team') teamReplies++;
    lastHuman = { login, role, at: c.createdAt };
  }

  // Who needs to act next. Issues opened by the team are their own to-dos.
  let waitingOn;
  if (isTeam(authorAssociation)) waitingOn = 'internal';
  else if (!lastHuman || lastHuman.role !== 'team') waitingOn = 'team';
  else waitingOn = 'reporter';

  return {
    bot: {
      lastCommand,
      lastBotReply,
      botRepliedAfterCommand: !!(lastCommand && lastBotReply && lastBotReply.at > lastCommand.at),
      lastReview,
      botRepliedAfterReview: !!(lastReview && lastBotReply && lastBotReply.at > lastReview.at),
    },
    triage: assessment || verification || fixPrs.length ? { assessment, verification, fixPrs: [...new Set(fixPrs)] } : null,
    conversation: {
      waitingOn,
      since: lastHuman?.at ?? createdAt,
      lastHuman,
      teamReplied: teamReplies > 0,
    },
  };
}
