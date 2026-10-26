// Pull requests linked to an issue: they mention it (CROSS_REFERENCED_EVENT, `source`) or are
// connected in its Development sidebar (CONNECTED_EVENT, `subject`).

// `node` is an issue with `timelineItems` of those two event types; `repo` is "owner/name".
// GitHub compares owner and name without case, so this does too.
export function linkedPrs(node, repo) {
  const byNumber = new Map();
  for (const event of node.timelineItems.nodes) {
    const pr = event?.source ?? event?.subject;
    if (pr?.__typename !== 'PullRequest' || byNumber.has(pr.number)) continue;
    if (pr.repository?.nameWithOwner.toLowerCase() !== repo.toLowerCase()) continue;
    byNumber.set(pr.number, { number: pr.number, title: pr.title, state: pr.state, mergedAt: pr.mergedAt, baseRefName: pr.baseRefName });
  }
  return [...byNumber.values()];
}

// A PR that is no longer open leaves the cache, so the issues that link it keep its final state.
export function updateLinkedPrs(items, { number, state, mergedAt }) {
  const update = (item) =>
    item.linkedPrs?.some((pr) => pr.number === number)
      ? { ...item, linkedPrs: item.linkedPrs.map((pr) => (pr.number === number ? { ...pr, state, mergedAt } : pr)) }
      : item;
  return new Map([...items].map(([key, item]) => [key, update(item)]));
}
