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
  `.cache/<owner>-<name>.json`, routes `GET /api/items`, `POST /api/refresh`,
  `POST /api/recommendations`, static files from `public/`. Recommendations run
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
  body for the visible tasks, freshness checks, and `applyPlan`, which maps a
  recommendation to what the apply button does. Tested by `recs.test.mjs`.
- `triage.mjs` — pure comment analysis (bot verdicts, team replies, summaries).
  Tested by `triage.test.mjs`.
- `linked-prs.mjs` — pure helpers for an issue's linked pull requests: the
  GraphQL timeline mapping and the state update when a PR closes or merges.
  Tested by `linked-prs.test.mjs`.
- `public/inbox.js` — pure task ranking for the Inbox tab (`computeTasks`,
  `isHidden`). Shared by browser and Node; tested by `inbox.test.mjs`.
- `public/views.js` — pure runbook views for the Issues and PRs tabs (`VIEWS`,
  `GROUPS`, `applyView`, `viewCounts`). Each view has a fixed rule, a fixed
  sort and an audience. Shared by browser and Node; tested by `views.test.mjs`.
- `public/app.js` — all UI: rendering, Runbook view cards, filters (URL hash),
  GitHub write actions.
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
  `collapsedGroups`, `commandsCollapsed` (the Runbook cards). Filter state,
  including the active view (`view=<id>`), lives in the URL hash.
