# expo/expo triage dashboard

GitHub-styled dashboard for triaging open issues and PRs in `expo/expo`.

- **Data**: `server.mjs` mirrors all open issues + PRs via the GitHub GraphQL API (full sync hourly, incremental every 2 min, cached in `.cache/`). Reads use `GITHUB_TOKEN` or `gh auth token`.
- **Inbox** (default tab): `public/inbox.js` turns every open item into its single most valuable next task (assign reproduced bug, merge, reply, first response, verify, review, …) and ranks them by a transparent score (task base + severity, waiting time, 👍, assignment). Done/snooze state is per browser (localStorage).
- **Filtering**: label facets (click = include, ⌥/Alt-click = exclude), `severity:` threshold, PR checks/review/mergeable, `@expo-bot` status, presets. Filter state lives in the URL hash, so views are shareable.
- **Actions**: "Request review" posts `@expo-bot review` on PRs, "Verify" posts `@expo-bot verify` on issues (single or bulk, with undo). These run in the browser with each user's own GitHub token (stored in localStorage) so comments are attributed to them.

```sh
npm start            # http://localhost:4317
PORT=8080 REPO_OWNER=expo REPO_NAME=expo npm start
```
