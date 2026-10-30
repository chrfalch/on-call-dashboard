# AGENTS.md

Triage dashboard for open issues and PRs in `expo/expo`. Plain Node (>= 20), no
dependencies, no build step.

## Commands

- `npm start` — server on http://localhost:4317 (bound to 127.0.0.1). Needs `GITHUB_TOKEN` or a
  logged-in `gh` CLI. The first full sync takes about two minutes; `/api/items` is
  empty until it finishes. Recommendations also need a logged-in `claude` CLI on
  `PATH`.
- `npm test` — `node --test` runs `*.test.mjs` in the root.

## Layout

- `server.mjs` — GraphQL sync (full hourly, incremental every 2 min), cache in
  `.cache/<owner>-<name>.json`, routes `GET /api/items`, `GET /api/trends`,
  `POST /api/refresh` (`?wait=1` answers after a sync that started after the
  request), `POST /api/recommendations`, static files from `public/`.
  Keeps closed issues and PRs for 7 days after they close.
  Each item keeps `comments` ({login, association, at}, and `review` with the
  review state for a PR review) from the last 30 comments and the PR's latest
  reviews, and `assignedEvents` ({login, at}, the last 10 assignments). A PR
  also keeps `lastCommitBy`, the login of the last commit's author (null
  when GitHub does not know the user), and `ciApprovalRunIds`, the REST ids of
  the GitHub Actions runs on the last commit that wait for a maintainer to
  approve them (check suites with conclusion `ACTION_REQUIRED`;
  `statusCheckRollup` still says SUCCESS for these).
  After each sync it fetches the issues and PRs created or closed in the last
  9 days (raw timestamps for the trend tiles) into
  `.cache/trends-<owner>-<name>.json`. Recommendations run
  `claude -p` with no tools, three at a time, in the empty `.cache/claude-cwd/`;
  results are cached in `.cache/recommendations-<owner>-<name>.json`. Only a
  click starts a run: browser polls send `poll: true` and never start one. The route
  rejects a request whose `Origin` header is present and is not
  `http://localhost:<port>` or `http://127.0.0.1:<port>` (403), and a body that is
  not `application/json` (415). This blocks other web pages in the browser. The
  server listens on 127.0.0.1 only, so other computers cannot connect.
- `recommend.mjs` — pure helpers for agent recommendations (prompt, CLI
  arguments, output parsing, request validation). Tested by
  `recommend.test.mjs`.
- `public/actions.js` — the actions a recommendation can propose (`ACTIONS`).
  Shared by `recommend.mjs` and the browser.
- `public/recs.js` — pure browser helpers for recommendations: `recRequest`,
  the request body for one Inbox row, keyed `<number>:<state>`, or
  `<number>:<state>:custom-<hash>` for a custom prompt; freshness checks;
  `applyPlan`, which maps a recommendation to what the apply button does; and
  `recDisagrees`, which tells when a recommendation does not do what the
  row's own close, comment or bot-command button does. Tested by
  `recs.test.mjs`.
- `triage.mjs` — pure comment analysis (bot verdicts, team replies, summaries).
  expo-bot sometimes answers a command by editing an older comment, so a bot
  reply's time is the comment's `lastEditedAt` when that is newer. A bot answer
  clears only its own kind of command (`botRepliedAfterCommand`,
  `botRepliedAfterReview`): `review` needs the sticky
  `<!-- expo-ai-code-reviewer -->` comment, created or edited after it (not the
  fork hint, not the bot's PR review entry); `verify` a
  `<!-- expo-sandbox-outcome:… -->` comment or "⚠️ `/verify` failed"; `triage`
  a `<!-- expo-triage:complete:v1 -->` comment; any other command any expo-bot
  comment, at its edit-aware time. Unmarked answers such as "🔍 `/verify`
  started" answer only those other commands. `lastBotReply` is still the newest
  expo-bot comment of any kind. The same edit-aware time dates a sandbox
  verdict (`verification.at`, the C3 clock), and the verdict with the newest such time wins. "@expo-bot <word>" and
  "/<word>" are commands only from the team (`check` counts as `verify`);
  a command is never a reply, whatever its length. `conversation.waitingOn`
  is `internal` for items the team opened; else `reporter` with the "needs
  more info" label (any case) unless the item author wrote the last human
  comment, or when the last human comment is a team
  review or a team comment with a "?" or an `@<author>` mention; else
  `team`. `conversation.lastTeamAt` and `lastReporterAt` are the newest
  team and author comments that are not commands.
  Tested by `triage.test.mjs`.
- `public/people.js` — `isBot` and `isTeam`, which tell who wrote a comment.
  `triage.mjs` re-exports them, so the server and the browser share one copy.
- `sync-runner.mjs` — runs one sync at a time; `runAndWait` waits for a
  follow-up sync when one is already running. Tested by `sync-runner.test.mjs`.
- `closed-items.mjs` — pure retention helper (`dropOldClosed`): keeps closed
  items for 7 days after `closedAt`. Tested by `closed-items.test.mjs`.
- `linked-prs.mjs` — pure helpers for an issue's linked pull requests: the
  GraphQL timeline mapping, the PR numbers that team comments name and the
  helpers that look them up and merge them in, and the state update when a PR
  closes or merges. `withFixedIssues` recomputes `fixedIssues`, the reverse link
  from a PR to the cached issues it fixes, shown on PR rows. Tested by
  `linked-prs.test.mjs`.
- `public/inbox.js` — pure task ranking for the Inbox tab (`computeTasks`,
  `isHidden`, `listedTasks`). Items with only unsupported SDK labels get one
  `unsupported-sdk` close task, listed only under its chip. Items without a
  platform or SDK label that expo-bot has not triaged (`needsBotTriage`) also
  get a `bot-triage` task that posts `@expo-bot triage`, listed only under its
  chip. `notReproduced` tells when expo-bot could not reproduce an issue:
  outcome `pass` and a write-up that says "not reproduced" or "did not
  reproduce". `pass` alone also means "the fix works" on a PR or "cannot
  verify". I5, C3 and the close task use it.
  Shared by browser and Node; tested by `inbox.test.mjs`.
- `public/views.js` — pure runbook views for the Issues and PRs list pages,
  which the UI no longer shows (`VIEWS`, `GROUPS`, `applyView`,
  `viewCounts`). Each view has a fixed rule, a fixed sort and an audience.
  "Needs bot triage" lists issues and PRs with the `needsBotTriage` rule. Shared by browser and Node; tested by `views.test.mjs`.
- `public/states.js` — pure workflow states for the Inbox: `stateOf` gives
  each issue or PR one state (`STATES`, I1–I10 and P1–P11), and
  `cleanupFilters` gives the cleanup filters it meets (`CLEANUP_FILTERS`).
  `stateAction` and `cleanupAction` give the button for a row, and
  `stateLabel` its badge text; for I8 it adds the state of the open fix PR,
  such as "Fix in progress · changes requested". `inboxRows` and
  `inboxCounts` give the rows and chip counts for a tab.
  On-call mode keeps assigned items that are closed; open assigned items,
  cleanup chips included, show only with "Include already-assigned items",
  and `hideUnsupported` drops rows with only unsupported SDK labels
  everywhere except under the C4 chip. The Close cleanup rules C2, C3, C4
  and C7 skip parked items, items assigned to someone other than the
  viewer, issues with an open fix PR, and draft or internal PRs.
  The "needs more info" label (any case) turns C1 off and C2 on, 14 days
  after `conversation.since`, except on items the team opened and after the
  reporter answered.
  C8 "Owner silent" matches I7 issues with no open fix PR and no owner
  activity for 7 days, and open P7 PRs at least 7 days old with at least one
  assignee or requested reviewer login and no comment or review from those
  owners in the last 7 days. Team review requests do not count as owners.
  P11 "CI awaits approval" is an open PR with `ciApprovalRunIds` once the
  expo-bot review is done, never for a `github-actions` author; its button
  approves each run in the browser after a confirm.
  Shared by browser and Node; tested by `states.test.mjs`.
- `public/trends.js` — pure math for the trend tiles (`weekStart`,
  `weekTrend`): cumulative opened and closed counts per local day since
  Monday 00:00, and the week's net change. Tested by `trends.test.mjs`.
- `public/done-log.js` — pure helpers for the Inbox "done today" tile: the
  items handled per local day, split into issues and PRs, and `weekDone`, the
  done counts per day since Monday for the tile chart. Tested by `done-log.test.mjs`.
- `public/sdk.js` — pure helpers for Expo SDK labels (`sdkLabels`,
  `isUnsupportedSdk`, `parseUnsupportedSdks`): the `sdk-<n>` labels newest
  first, and whether an item has only SDK labels the team no longer supports.
  Shared by browser and Node; tested by `sdk.test.mjs`.
- `public/quick-open.js` — pure helpers for the `g` quick-open box
  (`parseItemNumber`, `findItem`): read a typed issue or PR number and find
  the item. The box opens the item on GitHub in a new tab. Shared by
  browser and Node; tested by `quick-open.test.mjs`.
- `public/since.js` — pure helpers for the Inbox "Since last time" section
  (`sinceStart`, `sinceGroups`, `sinceButtons`, `skipKey`, `withSkip`,
  `parseSkipped`). The window starts at local midnight yesterday, or on
  Friday on a Monday. "My items" are open items assigned to the viewer, or
  PRs that request the viewer's review, with a comment, review or commit from someone else after the viewer's last
  comment, review or assignment. The viewer's comments and reviews on an
  issue's fix PRs count as the viewer's comments on the issue. A commit
  counts only when `lastCommitBy` is known and is not the viewer or a bot. expo-bot's answer counts when the
  viewer gave the last `review`, `triage` or `verify` command, the bot answered
  it, and the newest expo-bot comment of any kind (`lastBotReply`, which also
  dates the event) is newer than the viewer's last comment or review; a later
  assignment does not hide it. "New issues" and "New PRs" are open
  items created in the window with no comment or review from a team member
  (the author too), not assigned to the viewer and not in "My items". Items assigned to someone
  else stay, sorted after the unassigned ones, with an Open button.
  Items opened by a team member leave "New issues" and "New PRs" unless
  `includeInternal` is set; "My items" keeps them.
  Activity never comes from `updatedAt`.
  Shared by browser and Node; tested by `since.test.mjs`.
- `public/app.js` — all UI: rendering, filters (URL hash), GitHub write
  actions. The Inbox is the only page; the header shows the total open issues
  and PRs without filters. The Inbox has two tabs, "On-call inbox" and "My
  Work". Workflow state chips, in an Issues group and a PRs group, and
  Cleanup chips sit beside the trend tiles. The "Since last time" section
  sits below the tiles. The agent runs only when the user
  clicks "Ask agent…" on an open row, with the standard prompt or their own
  question; the answer shows on that row. The list-page code (`renderViews` and the Runbook
  view cards) stays but is not reachable.
- `public/index.html`, `public/style.css` — markup and GitHub-like styles.

## Rules

- Keep it dependency-free. Browser code is native ES modules, no bundler.
- Put logic in the pure modules (`triage.mjs`, `public/inbox.js`,
  `public/views.js`) and test it there. `app.js` and `server.mjs` have no tests.
- When you change the item shape in `server.mjs`, bump `CACHE_VERSION` so old
  caches re-sync.
- Write actions (comments such as `@expo-bot review`) run in the browser with
  the user's own token from localStorage. The server only reads from GitHub.
- Recommendation text is model output built from untrusted issue text. Render
  it only through `esc()`, never in an `href`. Nothing is posted until the user
  clicks, and drafts open in an editable dialog first.
- Per-browser state lives in localStorage keys `ghToken`, `inboxState`,
  `collapsedGroups`, `commandsCollapsed` (the Runbook cards),
  `unsupportedSdks` (a JSON array of the SDK labels marked unsupported),
  `inboxDoneLog:<YYYY-MM-DD>` (a JSON array of {number, type} for that local day),
  `sinceSkipped` (a JSON map from `<type>#<number>` to the skip time in ms;
  entries older than 30 days are dropped).
  Filter state, including the active view (`view=<id>`),
  `hideUnsupportedSdks=0` and the "Since last time" tab
  (`sinceTab=<mine|issues|prs>`, default `issues`) and list visibility
  (`sinceOpen=1`, default hidden) and internal contributors
  (`sinceInternal=1`, default off), lives in the URL hash.
