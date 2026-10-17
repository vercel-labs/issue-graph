import {
  LINEAR_CONNECTIONS,
  LINEAR_ISSUE_QUERY,
  LINEAR_PROJECT_OPEN_QUERY,
  LINEAR_PROJECT_QUERY,
  LINEAR_WORKSPACE_QUERY,
  LinearReadError,
  type LinearReader,
} from "../linear-queries.js";

export const LINEAR_API_URL = "https://api.linear.app/graphql";

export interface LinearReaderOptions {
  apiKey?: string;
  accessToken?: string;
  timeoutMs?: number;
  maxRetries?: number;
  maxBackoffMs?: number;
}

interface Failure {
  code: string;
  retry: boolean;
  delay?: number;
  resetAt?: number;
}

const RESET_HEADERS = [
  "x-ratelimit-requests-reset",
  "x-ratelimit-complexity-reset",
  "x-ratelimit-endpoint-requests-reset",
];

/** Latest reset among Linear's rate-limit windows, in epoch milliseconds. */
function resetAt(headers: Headers): number | undefined {
  const times = RESET_HEADERS.map((name) => Number(headers.get(name))).filter(
    (value) => Number.isFinite(value) && value > 0,
  );
  return times.length ? Math.max(...times) : undefined;
}

function classify(status: number, headers: Headers, errors: unknown[]): Failure {
  const codes = errors.flatMap((error) => {
    const extensions = (error as { extensions?: Record<string, unknown> })?.extensions;
    return [extensions?.code, extensions?.type].filter((v): v is string => typeof v === "string");
  });
  // Linear signals throttling with HTTP 400 and extensions.code RATELIMITED, resets in epoch ms.
  if (status === 429 || codes.some((code) => /rate.?limit/i.test(code))) {
    const reset = resetAt(headers);
    const retryAfter = Number(headers.get("retry-after"));
    return {
      code: "RATE_LIMITED",
      retry: true,
      resetAt: reset,
      delay:
        reset !== undefined
          ? Math.max(0, reset - Date.now())
          : headers.has("retry-after") && Number.isFinite(retryAfter)
            ? retryAfter * 1000
            : undefined,
    };
  }
  if (status === 401 || codes.some((code) => /^authentication/i.test(code)))
    return { code: "AUTHENTICATION", retry: false };
  if (status === 403 || codes.some((code) => /^forbidden$/i.test(code)))
    return { code: "FORBIDDEN", retry: false };
  if (status >= 500) return { code: "UPSTREAM", retry: true };
  if (errors.length) return { code: "GRAPHQL_ERROR", retry: false };
  return { code: `HTTP_${status}`, retry: false };
}

/** Rate-limit failure that names when the window reopens. */
export class LinearRateLimitError extends LinearReadError {
  constructor(readonly resetAt?: number) {
    super("RATE_LIMITED");
    if (resetAt)
      this.message = `Linear read failed (RATE_LIMITED); the limit resets at ${new Date(resetAt).toISOString()}`;
  }
}

class AttemptError extends Error {
  constructor(readonly failure: Failure) {
    super(failure.code);
  }
}

/** Fixed read-only GraphQL queries over fetch, with bounded retries and Linear's rate-limit headers. */
export function linearReader(options: LinearReaderOptions): LinearReader {
  if (Boolean(options.apiKey) === Boolean(options.accessToken))
    throw new Error("Set exactly one of LINEAR_API_KEY or LINEAR_ACCESS_TOKEN");
  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxRetries = options.maxRetries ?? 2;
  const maxBackoffMs = options.maxBackoffMs ?? 5_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
    throw new RangeError("Linear timeoutMs must be from 1 to 120000");
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 3)
    throw new RangeError("Linear maxRetries must be from 0 to 3");
  if (!Number.isInteger(maxBackoffMs) || maxBackoffMs < 0 || maxBackoffMs > 30_000)
    throw new RangeError("Linear maxBackoffMs must be from 0 to 30000");
  // API keys go bare; OAuth access tokens use the Bearer scheme.
  const authorization = options.apiKey ?? `Bearer ${options.accessToken}`;

  async function attempt(query: string, variables: Record<string, unknown>): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(LINEAR_API_URL, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const name = (error as { name?: string })?.name;
      throw new AttemptError({
        code: name === "AbortError" || name === "TimeoutError" ? "TIMEOUT" : "NETWORK",
        retry: false,
      });
    }
    const body = (await response.json().catch(() => ({}))) as {
      data?: unknown;
      errors?: unknown[];
    };
    const errors = Array.isArray(body.errors) ? body.errors : [];
    if (response.ok && !errors.length && body.data !== undefined) return body.data;
    throw new AttemptError(classify(response.status, response.headers, errors));
  }

  async function read(query: string, variables: Record<string, unknown>): Promise<unknown> {
    for (let tries = 0; ; tries++) {
      try {
        return await attempt(query, variables);
      } catch (error) {
        const state =
          error instanceof AttemptError ? error.failure : { code: "NETWORK", retry: false };
        const delay = state.delay ?? 1_000 * 2 ** tries;
        if (!state.retry || tries >= maxRetries || delay > maxBackoffMs)
          throw state.code === "RATE_LIMITED"
            ? new LinearRateLimitError(state.resetAt)
            : new LinearReadError(state.code);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  return {
    workspace: () => read(LINEAR_WORKSPACE_QUERY, {}),
    projectOpenIssues: (id, after) => read(LINEAR_PROJECT_OPEN_QUERY, { id, after: after ?? null }),
    projectIssues: (id, after) => read(LINEAR_PROJECT_QUERY, { id, after: after ?? null }),
    issue(id, page) {
      return read(LINEAR_ISSUE_QUERY, {
        id,
        size: page.size,
        ...Object.fromEntries(
          LINEAR_CONNECTIONS.flatMap((name) => [
            [name, page.include.includes(name)],
            [`${name}After`, page.cursors[name] ?? null],
          ]),
        ),
      });
    },
  };
}
