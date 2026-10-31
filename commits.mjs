// GitHub deprecated pushedDate. A push creates the commit's Actions check suites, so the earliest
// one dates the push; later suites come from other events (re-runs, approvals).
export function lastPushAt(commit) {
  if (!commit) return null;
  const [firstSuiteAt] = (commit.checkSuites?.nodes ?? [])
    .map((s) => s?.createdAt)
    .filter(Boolean)
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  const committed = commit.committedDate ?? null;
  if (!firstSuiteAt) return committed;
  return committed && Date.parse(committed) >= Date.parse(firstSuiteAt) ? committed : firstSuiteAt;
}
