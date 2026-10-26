# AGENTS.md

Triage dashboard for open issues and PRs in `expo/expo`. Plain Node (>= 20), no
dependencies, no build step.

## Commands

- `npm start` — server on http://localhost:4317. Needs `GITHUB_TOKEN` or a
  logged-in `gh` CLI. The first full sync takes about two minutes; `/api/items` is
  empty until it finishes.
- `npm test` — `node --test` runs `*.test.mjs` in the root.

## Layout

- `server.mjs` — GraphQL sync (full hourly, incremental every 2 min), cache in
  `.cache/<owner>-<name>.json`, routes `GET /api/items`, `POST /api/refresh`,
  static files from `public/`.
- `triage.mjs` — pure comment analysis (bot verdicts, team replies, summaries).
  Tested by `triage.test.mjs`.
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
  `public/views.js`) and test it there. `app.js` and `server.mjs` have no tests.- When you change the item shape in `server.mjs`, bump `CACHE_VERSION` so old
  caches re-sync.
- Write actions (comments such as `@expo-bot review`) run in the browser with
  the user's own token from localStorage. The server only reads from GitHub.
- Per-browser state lives in localStorage keys `ghToken`, `inboxState`,
  `collapsedGroups`, `commandsCollapsed` (the Runbook cards). Filter state,
  including the active view (`view=<id>`), lives in the URL hash.
