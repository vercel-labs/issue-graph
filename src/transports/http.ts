/**
 * Transport that talks to api.github.com over `fetch` with a bearer token, for
 * runtimes with no `gh` binary (a server, a cron job, an edge function).
 *
 * Unlike the shell transport, this one owns its rate-limit behaviour. That is
 * the point: an unattended daily crawl that silently loses half its nodes to a
 * secondary rate limit produces a confidently wrong report, which is worse
 * than no report. Every failure this cannot retry away is thrown.
 */

import { type GhTransport, GhTransportError, paginate, type SeedRef } from "../transport.js";

const API = "https://api.github.com";

export interface HttpTransportOptions {
  /** Bearer token, or a resolver called per request (Connect, STS, App). */
  token: string | (() => string | Promise<string>);
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Retries for a retryable failure, on top of the initial attempt. */
  maxRetries?: number;
  /** Requests allowed in flight at once. */
  concurrency?: number;
  /** Cap on any single backoff sleep, so a long reset window fails fast. */
  maxBackoffMs?: number;
  userAgent?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A counting semaphore. GitHub's secondary rate limits punish burst
 * concurrency harder than sustained volume, so the cap is on requests in
 * flight rather than requests per second.
 */
function gate(limit: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  const release = () => {
    active--;
    waiting.shift()?.();
  };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((r) => waiting.push(r));
    active++;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

/** How long GitHub is asking us to wait, in ms, or null if it did not say. */
function retryDelayFromHeaders(headers: Headers): number | null {
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return seconds * 1000;
  }
  // Primary rate limit: remaining hits 0 and the window resets at an epoch.
  if (headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(headers.get("x-ratelimit-reset"));
    if (Number.isFinite(reset)) return Math.max(0, reset * 1000 - Date.now());
  }
  return null;
}

interface GraphQlError {
  type?: string;
  message?: string;
}

export function httpTransport(opts: HttpTransportOptions): GhTransport {
  const {
    timeoutMs = 20_000,
    maxRetries = 3,
    concurrency = 5,
    maxBackoffMs = 60_000,
    userAgent = "issue-graph",
  } = opts;
  const limit = gate(concurrency);
  const resolveToken = async () =>
    typeof opts.token === "function" ? await opts.token() : opts.token;

  async function request(path: string, init?: RequestInit): Promise<unknown> {
    const token = await resolveToken();

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await limit(() =>
          fetch(`${API}${path}`, {
            ...init,
            headers: {
              authorization: `bearer ${token}`,
              accept: "application/vnd.github+json",
              "x-github-api-version": "2022-11-28",
              "user-agent": userAgent,
              ...(init?.body ? { "content-type": "application/json" } : {}),
            },
            signal: AbortSignal.timeout(timeoutMs),
          }),
        );
      } catch (err) {
        // Network failure or timeout — says nothing about the request's
        // validity, so it is worth retrying.
        if (attempt >= maxRetries) {
          throw new GhTransportError(
            `GitHub request failed after ${attempt + 1} attempts: ${(err as Error).message}`,
            undefined,
            true,
          );
        }
        await sleep(Math.min(maxBackoffMs, 2 ** attempt * 1000));
        continue;
      }

      if (res.ok) return await res.json();

      const throttled = res.status === 429 || res.status === 403;
      const asked = retryDelayFromHeaders(res.headers);
      const retryable = throttled ? asked !== null || res.status === 429 : res.status >= 500;

      if (!retryable || attempt >= maxRetries) {
        const body = await res.text().catch(() => "");
        throw new GhTransportError(
          `GitHub ${res.status} on ${path}: ${body.slice(0, 300)}`,
          res.status,
          retryable,
        );
      }
      const delay = asked ?? 2 ** attempt * 1000;
      if (delay > maxBackoffMs) {
        throw new GhTransportError(
          `GitHub rate limit on ${path} does not reset for ${Math.round(delay / 1000)}s`,
          res.status,
          true,
        );
      }
      await sleep(delay);
    }
  }

  return {
    async graphql(query, variables = {}) {
      const body = JSON.stringify({ query, variables });
      for (let attempt = 0; ; attempt++) {
        const payload = (await request("/graphql", { method: "POST", body })) as {
          errors?: GraphQlError[];
        };
        const rateLimited = payload.errors?.some((e) => e.type === "RATE_LIMITED");
        if (!rateLimited) return payload;
        // GraphQL reports its own rate limit as a 200 with an error entry, so
        // the HTTP-level retry above never sees it.
        if (attempt >= maxRetries) {
          throw new GhTransportError("GitHub GraphQL rate limit exhausted", 200, true);
        }
        await sleep(Math.min(maxBackoffMs, 2 ** attempt * 1000));
      }
    },

    async search(query, limit) {
      const items = await paginate(limit, async (page, perPage) => {
        const payload = (await request(
          `/search/issues?q=${encodeURIComponent(query)}&per_page=${perPage}&page=${page}`,
        )) as { items?: Array<{ number?: number; repository_url?: string; html_url?: string }> };
        return payload.items ?? [];
      });

      const out: SeedRef[] = [];
      for (const item of items) {
        const api = item.repository_url?.match(/\/repos\/([^/]+)\/([^/]+)$/);
        const html = item.html_url?.match(/github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\/\d+/);
        const m = api ?? html;
        if (m && item.number != null) out.push({ owner: m[1], repo: m[2], number: item.number });
      }
      return out;
    },
  };
}
