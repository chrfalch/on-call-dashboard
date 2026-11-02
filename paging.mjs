/**
 * Yields each page of a GraphQL connection. `fetchPage(cursor, first)` returns
 * `{ nodes, pageInfo: { hasNextPage, endCursor } }`. When a page times out, it
 * retries the same cursor with half as many items, down to one; the next page
 * asks for the full `size` again.
 */
export async function* pages(fetchPage, { size, isTimeout, onSplit = () => {} }) {
  let cursor = null;
  let first = size;
  for (;;) {
    let conn;
    try {
      conn = await fetchPage(cursor, first);
    } catch (error) {
      if (first === 1 || !isTimeout(error)) throw error;
      first = Math.ceil(first / 2);
      onSplit(first);
      continue;
    }
    yield conn;
    if (!conn.pageInfo.hasNextPage) return;
    cursor = conn.pageInfo.endCursor;
    first = size;
  }
}
