# expo/expo triage dashboard

GitHub-styled dashboard for triaging open issues and PRs in `expo/expo`.

## Run

Requires Node 20 or later and GitHub read access: set `GITHUB_TOKEN`, or log in
with `gh auth login`. There are no dependencies to install.

```sh
npm start            # http://localhost:4317
PORT=8080 REPO_OWNER=expo REPO_NAME=expo npm start
npm test             # unit tests for triage.mjs, public/inbox.js and public/views.js
```

The first start runs a full sync, which takes about two minutes. The page shows
items when it finishes. Later starts load the cache in `.cache/` first.

## Features

- **Data**: `server.mjs` mirrors all open issues + PRs via the GitHub GraphQL API (full sync hourly, incremental every 2 min, cached in `.cache/`). Reads use `GITHUB_TOKEN` or `gh auth token`.
- **Inbox** (default tab): `public/inbox.js` turns every open item into its single most valuable next task (assign reproduced bug, merge, reply, first response, verify, review, …) and ranks them by a transparent score (task base + severity, waiting time, 👍). Two modes: *On-call* (triage/routing tasks on items nobody owns) and *My work* (items assigned to you or requesting your review). Done/snooze state is per browser (localStorage).
- **Runbook views**: cards above the Issues and Pull requests lists. Each view in `public/views.js` is one runbook step with a fixed rule, a fixed order and an audience (on-call, owner, reviewer, …), for example *Triage queue* (`needs review`, unassigned, newest first) or *External PRs with no review yet*. Each button shows the live count. An item leaves a view only when its GitHub state changes. While a view is active, it replaces the filters and the sort; search still narrows it. The view is stored in the URL hash as `view=<id>`.
- **Filtering**: label facets (click = include, ⌥/Alt-click = exclude), `severity:` threshold, PR checks/review/mergeable, `@expo-bot` status. Filter state lives in the URL hash, so filtered lists are shareable.
- **Actions**: "Request review" posts `@expo-bot review` on PRs, "Verify" posts `@expo-bot verify` on issues (single or bulk, with undo). These run in the browser with each user's own GitHub token (stored in localStorage) so comments are attributed to them.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4317` | HTTP port |
| `REPO_OWNER` / `REPO_NAME` | `expo` / `expo` | Repository to mirror |
| `GITHUB_TOKEN` | `gh auth token` | Token for GitHub reads |
| `INCREMENTAL_MS` | `120000` | Incremental sync interval |
| `FULL_MS` | `3600000` | Full sync interval |
