/**
 * How the crawl talks to GitHub. The graph logic is pure; only this seam does
 * I/O, so the same code runs from the CLI (shelling out to an authenticated
 * `gh`) and from a server with no `gh` binary (plain `fetch` and a token).
 *
 * This module stays dependency-free and importable from any runtime — the two
 * implementations live in `./transports/*` so that importing the core never
 * pulls in `node:child_process`.
 */

/** A seed resolved from a search, in the crawl's own coordinates. */
export interface SeedRef {
  owner: string;
  repo: string;
  number: number;
}

export async function paginate<T>(
  limit: number,
  fetchPage: (page: number, perPage: number) => Promise<T[]>,
): Promise<T[]> {
  const target = Math.max(0, Math.min(Math.floor(limit), 1000));
  const results: T[] = [];
  for (let page = 1; results.length < target; page++) {
    const perPage = Math.min(100, target - results.length);
    const items = await fetchPage(page, perPage);
    results.push(...items.slice(0, perPage));
    if (items.length < perPage) break;
  }
  return results.slice(0, target);
}

export interface GhTransport {
  /**
   * Run a GraphQL query and return the raw `{data, errors}` envelope. The
   * caller inspects `errors`; a transport only throws when the request itself
   * failed (network, auth, rate limit) so a retry can be distinguished from a
   * query the server understood and rejected.
   */
  graphql(query: string, variables?: Record<string, string | number>): Promise<unknown>;

  /**
   * Resolve seeds from a GitHub search query (`repo:o/r is:open is:issue`).
   * Separate from `graphql` because the CLI answers it with `gh issue list`,
   * which needs no query string of its own.
   */
  search(query: string, limit: number): Promise<SeedRef[]>;
}

/** Thrown when a request failed in a way that says nothing about the data. */
export class GhTransportError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "GhTransportError";
  }
}
