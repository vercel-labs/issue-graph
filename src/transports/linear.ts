import { LinearClient } from "@linear/sdk";
import {
  LINEAR_CONNECTIONS,
  LINEAR_ISSUE_QUERY,
  LINEAR_PROJECT_OPEN_QUERY,
  LINEAR_PROJECT_QUERY,
  LINEAR_WORKSPACE_QUERY,
  LinearReadError,
  type LinearReader,
} from "../linear-queries.js";

export interface LinearSdkOptions {
  apiKey?: string;
  accessToken?: string;
  timeoutMs?: number;
  maxRetries?: number;
  maxBackoffMs?: number;
}

function failure(error: unknown): { code: string; retry: boolean; delay?: number } {
  const raw = error as {
    name?: string;
    raw?: { response?: { status?: number; headers?: Headers; errors?: unknown[] } };
    response?: { status?: number; headers?: Headers; errors?: unknown[] };
  };
  if (raw?.name === "AbortError" || raw?.name === "TimeoutError")
    return { code: "TIMEOUT", retry: false };
  const response = raw?.raw?.response ?? raw?.response;
  const types = (response?.errors ?? []).flatMap((error) => {
    const extensions = (error as { extensions?: Record<string, unknown> })?.extensions;
    return [extensions?.code, extensions?.type];
  });
  const throttled =
    response?.status === 429 ||
    types.some((type) => typeof type === "string" && /rate.?limit/i.test(type));
  if (throttled) {
    const value = response?.headers?.get("retry-after");
    const seconds = value ? Number(value) : Number.NaN;
    const dateDelay =
      value && !Number.isFinite(seconds) ? Date.parse(value) - Date.now() : Number.NaN;
    return {
      code: "RATE_LIMITED",
      retry: true,
      delay:
        Number.isFinite(seconds) && seconds >= 0
          ? seconds * 1000
          : Number.isFinite(dateDelay)
            ? Math.max(0, dateDelay)
            : undefined,
    };
  }
  if (response?.status === 401 || types.includes("AuthenticationError"))
    return { code: "AUTHENTICATION", retry: false };
  if (response?.status === 403 || types.includes("Forbidden"))
    return { code: "FORBIDDEN", retry: false };
  if (response?.status && response.status >= 500) return { code: "UPSTREAM", retry: true };
  if (response?.errors?.length) return { code: "GRAPHQL_ERROR", retry: false };
  return { code: response?.status ? `HTTP_${response.status}` : "NETWORK", retry: false };
}

export function linearSdkReader(options: LinearSdkOptions): LinearReader {
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

  async function read(query: string, variables: Record<string, unknown>): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try {
        const client = new LinearClient({
          apiKey: options.apiKey,
          accessToken: options.accessToken,
          signal: AbortSignal.timeout(timeoutMs),
          redirect: "error",
        });
        const result = await client.client.rawRequest<unknown, Record<string, unknown>>(
          query,
          variables,
        );
        return result.data;
      } catch (error) {
        const state = failure(error);
        const delay = state.delay ?? 1_000 * 2 ** attempt;
        if (!state.retry || attempt >= maxRetries || delay > maxBackoffMs)
          throw new LinearReadError(state.code);
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
