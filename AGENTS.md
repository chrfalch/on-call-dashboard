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
  After each sync it fetches the issues and PRs created or closed in the last
  9 days (raw timestamps for the trend tiles) into
  `.cache/trends-<owner>-<name>.json`. Recommendations run
  `claude -p` with no tools, three at a time, in the empty `.cache/claude-cwd/`;
  results are cached in `.cache/recommendations-<owner>-<name>.json`. The route
  rejects a request whose `Origin` header is present and is not
  `http://localhost:<port>` or `http://127.0.0.1:<port>` (403), and a body that is
  not `application/json` (415). This blocks other web pages in the browser. The
  server listens on 127.0.0.1 only, so other computers cannot connect.
- `recommend.mjs` — pure helpers for agent recommendations (prompt, CLI
  arguments, output parsing, request validation). Tested by
  `recommend.test.mjs`.
- `public/actions.js` — the actions a recommendation can propose (`ACTIONS`).
  Shared by `recommend.mjs` and the browser.
- `public/recs.js` — pure browser helpers for recommendations: the request
  body for the visible tasks, freshness checks, `applyPlan`, which maps a
  recommendation to what the apply button does, and `recDisagrees`, which
  tells when a recommendation does not do what a close or bot-command task
  asks. `recIsNextStep` tells when the task's button applies a severity
  label, so the recommendation is the step after it. Tested by
  `recs.test.mjs`.
- `triage.mjs` — pure comment analysis (bot verdicts, team replies, summaries).
  Tested by `triage.test.mjs`.
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
  chip. Shared by browser and Node; tested by `inbox.test.mjs`.
- `public/views.js` — pure runbook views for the Issues and PRs list pages,
  which the UI no longer shows (`VIEWS`, `GROUPS`, `applyView`,
  `viewCounts`). Each view has a fixed rule, a fixed sort and an audience.
  "Needs bot triage" lists issues and PRs with the `needsBotTriage` rule. Shared by browser and Node; tested by `views.test.mjs`.
- `public/states.js` — pure workflow states for the Inbox: `stateOf` gives
  each issue or PR one state (`STATES`, I1–I10 and P1–P10), and
  `cleanupFilters` gives the cleanup filters it meets (`CLEANUP_FILTERS`).
  `stateAction` and `cleanupAction` give the button for a row, and
  `inboxRows` and `inboxCounts` give the rows and chip counts for a tab.
  On-call mode keeps assigned items that are closed or have a cleanup filter,
  and `hideUnsupported` drops C4 rows everywhere except under the C4 chip.
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
- `public/app.js` — all UI: rendering, filters (URL hash), GitHub write
  actions. The Inbox is the only page; the header shows the total open issues
  and PRs without filters. The Inbox has two tabs, "On-call inbox" and "My
  Work". Workflow state chips, in an Issues group and a PRs group, and
  Cleanup chips sit beside the trend tiles. Recommendations are not shown in
  the Inbox until the Cleanup-filter recommendations land. The list-page code (`renderViews` and the Runbook
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
  `inboxDoneLog:<YYYY-MM-DD>` (a JSON array of {number, type} for that local day).
  Filter state, including the active view (`view=<id>`) and
  `hideUnsupportedSdks=0`, lives in the URL hash.
