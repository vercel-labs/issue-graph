import {
  PLANE_OPEN_STATE_GROUPS,
  type PlanePage,
  PlaneReadError,
  type PlaneReader,
} from "../plane-queries.js";

export const PLANE_API_URL = "https://api.plane.so";
export const PLANE_WEB_URL = "https://app.plane.so";

export interface PlaneReaderOptions {
  apiKey: string;
  workspace: string;
  /** API origin for self-hosted Plane. Defaults to Plane Cloud. */
  apiUrl?: string;
  /** Web app origin used for links. Defaults to Plane Cloud, or `apiUrl` when that is set. */
  webUrl?: string;
  /** Client-side request budget. Plane Cloud allows 60 requests per minute per key. */
  requestsPerMinute?: number;
  timeoutMs?: number;
  maxRetries?: number;
  /** Longest single wait for a rate-limit reset before giving up. */
  maxBackoffMs?: number;
  /** Called before the reader sleeps for the rate limit, with the wait in milliseconds. */
  onWait?(ms: number, reason: "budget" | "rate-limited"): void;
  fetch?: typeof fetch;
  now?(): number;
  sleep?(ms: number): Promise<void>;
}

interface Failure {
  code: string;
  retry: boolean;
  delay?: number;
}

class AttemptError extends Error {
  constructor(readonly failure: Failure) {
    super(failure.code);
  }
}

const SLUG = /^[a-z0-9][a-z0-9_-]*$/i;
const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** An origin that is safe to send an API key to: https, or plain http on loopback only. */
export function planeOrigin(raw: string, name: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  if (url.username || url.password) throw new Error(`${name} must not contain credentials`);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL.has(url.hostname)))
    throw new Error(`${name} must use https (http is allowed only for localhost)`);
  return url.origin;
}

function seconds(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function classify(status: number, headers: Headers, now: number): Failure {
  if (status === 429) {
    const retryAfter = seconds(headers.get("retry-after"));
    const reset = seconds(headers.get("x-ratelimit-reset"));
    return {
      code: "RATE_LIMITED",
      retry: true,
      delay:
        retryAfter !== undefined
          ? retryAfter * 1000
          : reset !== undefined
            ? Math.max(0, reset * 1000 - now)
            : undefined,
    };
  }
  if (status === 401) return { code: "AUTHENTICATION", retry: false };
  if (status === 402) return { code: "PAYMENT_REQUIRED", retry: false };
  if (status === 403) return { code: "FORBIDDEN", retry: false };
  if (status === 404) return { code: "NOT_FOUND", retry: false };
  if (status >= 500) return { code: "UPSTREAM", retry: true };
  return { code: `HTTP_${status}`, retry: false };
}

const PAGE_KEYS = ["cursor", "offset", "page"];

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nextFromString(value: string): string | undefined {
  if (/^\d+$/.test(value)) return `offset=${value}`;
  try {
    const url = new URL(value);
    const params = new URLSearchParams();
    for (const key of PAGE_KEYS) {
      const found = url.searchParams.get(key);
      if (found !== null) params.set(key, found);
    }
    return params.size ? params.toString() : undefined;
  } catch {
    return new URLSearchParams({ cursor: value }).toString();
  }
}

/**
 * Normalize Plane's list envelopes: v2 `{ data, next }` with an offset or URL,
 * v1 `{ results, next_cursor, next_page_results }`, or a bare array.
 */
export function planePage(body: unknown): PlanePage {
  if (Array.isArray(body)) return { items: body };
  const value = record(body);
  if (!value) throw new PlaneReadError("INVALID_PAYLOAD");
  const items = Array.isArray(value.data)
    ? value.data
    : Array.isArray(value.results)
      ? value.results
      : undefined;
  if (!items) throw new PlaneReadError("INVALID_PAYLOAD");
  const meta = record(value.meta);
  const totalValue = value.total_count ?? value.total_results ?? meta?.total;
  const total = typeof totalValue === "number" ? totalValue : undefined;
  let next: string | undefined;
  if (typeof value.next_page_results === "boolean") {
    if (value.next_page_results && typeof value.next_cursor === "string" && value.next_cursor)
      next = new URLSearchParams({ cursor: value.next_cursor }).toString();
  } else if (typeof value.next === "number") next = `offset=${value.next}`;
  else if (typeof value.next === "string" && value.next) next = nextFromString(value.next);
  else if (typeof value.next_cursor === "string" && value.next_cursor)
    next = new URLSearchParams({ cursor: value.next_cursor }).toString();
  else if (
    meta &&
    typeof meta.offset === "number" &&
    typeof meta.per_page === "number" &&
    typeof meta.total === "number" &&
    meta.offset + meta.per_page < meta.total
  )
    next = `offset=${meta.offset + meta.per_page}`;
  return { items, ...(next && { next }), ...(total !== undefined && { total }) };
}

/** Read-only GET requests to the Plane REST API with an API key, a request budget, and bounded retries. */
export function planeReader(options: PlaneReaderOptions): PlaneReader {
  if (!options.apiKey) throw new Error("Set PLANE_API_KEY to a Plane API key");
  if (!SLUG.test(options.workspace)) throw new Error("Invalid Plane workspace slug");
  const apiUrl = planeOrigin(options.apiUrl ?? PLANE_API_URL, "PLANE_API_URL");
  const webUrl = planeOrigin(
    options.webUrl ?? (options.apiUrl ? apiUrl : PLANE_WEB_URL),
    "PLANE_WEB_URL",
  );
  const perMinute = options.requestsPerMinute ?? 50;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxRetries = options.maxRetries ?? 3;
  const maxBackoffMs = options.maxBackoffMs ?? 65_000;
  if (!Number.isInteger(perMinute) || perMinute < 1 || perMinute > 6_000)
    throw new RangeError("Plane requestsPerMinute must be from 1 to 6000");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
    throw new RangeError("Plane timeoutMs must be from 1 to 120000");
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 5)
    throw new RangeError("Plane maxRetries must be from 0 to 5");
  if (!Number.isInteger(maxBackoffMs) || maxBackoffMs < 0 || maxBackoffMs > 300_000)
    throw new RangeError("Plane maxBackoffMs must be from 0 to 300000");
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const workspace = encodeURIComponent(options.workspace);
  const v1 = `${apiUrl}/api/v1/workspaces/${workspace}`;
  const v2 = `${apiUrl}/api/v2/workspaces/${workspace}`;
  const segment = (value: string) => encodeURIComponent(value);

  // Sliding one-minute window shared by every request from this reader.
  const sent: number[] = [];
  let gate: Promise<void> = Promise.resolve();
  function reserve(): Promise<void> {
    const turn = gate.then(async () => {
      for (;;) {
        const current = now();
        while (sent.length && current - sent[0] >= 60_000) sent.shift();
        if (sent.length < perMinute) {
          sent.push(current);
          return;
        }
        const wait = sent[0] + 60_000 - current;
        options.onWait?.(wait, "budget");
        await sleep(wait);
      }
    });
    gate = turn.catch(() => {});
    return turn;
  }

  async function attempt(url: string): Promise<unknown> {
    await reserve();
    let response: Response;
    try {
      response = await doFetch(url, {
        method: "GET",
        headers: { "x-api-key": options.apiKey, accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const name = (error as { name?: string })?.name;
      throw new AttemptError({
        code: name === "AbortError" || name === "TimeoutError" ? "TIMEOUT" : "NETWORK",
        retry: true,
      });
    }
    if (response.ok) {
      try {
        return await response.json();
      } catch {
        throw new AttemptError({ code: "INVALID_PAYLOAD", retry: false });
      }
    }
    await response.body?.cancel().catch(() => {});
    throw new AttemptError(classify(response.status, response.headers, now()));
  }

  async function get(url: string): Promise<unknown> {
    for (let tries = 0; ; tries++) {
      try {
        return await attempt(url);
      } catch (error) {
        const failure =
          error instanceof AttemptError ? error.failure : { code: "NETWORK", retry: false };
        const delay = failure.delay ?? Math.min(maxBackoffMs, 1_000 * 2 ** tries);
        if (!failure.retry || tries >= maxRetries || delay > maxBackoffMs)
          throw new PlaneReadError(failure.code);
        if (failure.code === "RATE_LIMITED") options.onWait?.(delay, "rate-limited");
        await sleep(delay);
      }
    }
  }

  function url(base: string, params: Record<string, string>, next?: string): string {
    const search = new URLSearchParams(params);
    if (next) for (const [key, value] of new URLSearchParams(next)) search.set(key, value);
    const query = search.toString();
    return query ? `${base}?${query}` : base;
  }

  const list = async (base: string, params: Record<string, string>, next?: string) =>
    planePage(await get(url(base, params, next)));
  const withState = { expand: "state", per_page: "100" };

  return {
    label: `Plane REST API (${new URL(apiUrl).host})`,
    workspace: options.workspace,
    webUrl,
    projects: (next) => list(`${v2}/projects/`, { per_page: "100" }, next),
    workItemByIdentifier: (identifier) =>
      get(url(`${v2}/work-items/${segment(identifier)}/`, { expand: "state" })),
    workItem: (projectId, id) =>
      get(
        url(`${v2}/projects/${segment(projectId)}/work-items/${segment(id)}/`, {
          expand: "state",
        }),
      ),
    // Relations are documented only on v1.
    relations: (projectId, id) =>
      get(`${v1}/projects/${segment(projectId)}/work-items/${segment(id)}/relations/`),
    links: (projectId, id, next) =>
      list(
        `${v2}/projects/${segment(projectId)}/work-items/${segment(id)}/links/`,
        { per_page: "100" },
        next,
      ),
    workItems: (next) => list(`${v2}/work-items/`, withState, next),
    children: (parentId, next) =>
      list(`${v2}/work-items/`, { ...withState, parent_id: parentId }, next),
    projectWorkItems: (projectId, next) =>
      list(`${v2}/projects/${segment(projectId)}/work-items/`, withState, next),
    async countOpen(projectId) {
      const page = await list(`${v2}/work-items/`, {
        project_id: projectId,
        state_group__in: PLANE_OPEN_STATE_GROUPS.join(","),
        per_page: "1",
        fields: "id",
      });
      return page.total;
    },
  };
}
