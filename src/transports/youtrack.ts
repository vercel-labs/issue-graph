import { parseYouTrackBase, YouTrackReadError, type YouTrackReader } from "../youtrack.js";

export interface YouTrackReaderOptions {
  /** Base URL of the YouTrack service, such as `https://acme.youtrack.cloud` or `https://host/youtrack`. */
  baseUrl: string;
  /** Permanent token, sent as a Bearer token on every request and never stored. */
  token: string;
  timeoutMs?: number;
  maxRetries?: number;
  maxBackoffMs?: number;
  /** Largest response body accepted, in bytes. */
  maxBytes?: number;
}

interface Failure {
  code: string;
  retry: boolean;
  delay?: number;
}

function classify(status: number, headers: Headers): Failure {
  if (status === 429) {
    const seconds = Number(headers.get("retry-after"));
    return {
      code: "RATE_LIMITED",
      retry: true,
      delay: headers.has("retry-after") && Number.isFinite(seconds) ? seconds * 1000 : undefined,
    };
  }
  if (status === 401) return { code: "AUTHENTICATION", retry: false };
  if (status === 403) return { code: "FORBIDDEN", retry: false };
  if (status === 404) return { code: "NOT_FOUND", retry: false };
  if (status >= 500) return { code: "UPSTREAM", retry: true };
  return { code: `HTTP_${status}`, retry: false };
}

class AttemptError extends Error {
  constructor(readonly failure: Failure) {
    super(failure.code);
  }
}

async function readBody(response: Response, maxBytes: number): Promise<string> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes)
    throw new AttemptError({ code: "TOO_LARGE", retry: false });
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new AttemptError({ code: "TOO_LARGE", retry: false });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Read-only GETs against `<base>/api` over fetch with a permanent token, a timeout, no redirects
 * (the token is never forwarded), a response size cap, and bounded retries for 429 and 5xx.
 */
export function youTrackReader(options: YouTrackReaderOptions): YouTrackReader {
  const baseUrl = parseYouTrackBase(options.baseUrl);
  if (!options.token.trim() || /[\s\p{Cc}]/u.test(options.token))
    throw new Error("A YouTrack permanent token is required");
  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxRetries = options.maxRetries ?? 2;
  const maxBackoffMs = options.maxBackoffMs ?? 5_000;
  const maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
    throw new RangeError("YouTrack timeoutMs must be from 1 to 120000");
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 3)
    throw new RangeError("YouTrack maxRetries must be from 0 to 3");
  if (!Number.isInteger(maxBackoffMs) || maxBackoffMs < 0 || maxBackoffMs > 30_000)
    throw new RangeError("YouTrack maxBackoffMs must be from 0 to 30000");
  if (!Number.isInteger(maxBytes) || maxBytes < 1)
    throw new RangeError("YouTrack maxBytes must be a positive integer");
  const { origin, pathname } = new URL(baseUrl);
  const apiRoot = `${pathname.replace(/\/+$/, "")}/api/`;
  const authorization = `Bearer ${options.token}`;

  async function attempt(url: URL): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: { authorization, accept: "application/json" },
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
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new AttemptError(classify(response.status, response.headers));
    }
    const body = await readBody(response, maxBytes);
    try {
      return JSON.parse(body);
    } catch {
      throw new AttemptError({ code: "INVALID_PAYLOAD", retry: false });
    }
  }

  return {
    label: "YouTrack REST API",
    baseUrl,
    async get(path, query = {}) {
      const url = new URL(`${baseUrl}/api/${path.replace(/^\/+/, "")}`);
      // Dot segments or an absolute path must not move the request off the API root.
      if (url.origin !== origin || !url.pathname.startsWith(apiRoot))
        throw new YouTrackReadError("INVALID_PATH");
      for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
      for (let tries = 0; ; tries++) {
        try {
          return await attempt(url);
        } catch (error) {
          const failure =
            error instanceof AttemptError ? error.failure : { code: "NETWORK", retry: false };
          const delay = failure.delay ?? 1_000 * 2 ** tries;
          if (!failure.retry || tries >= maxRetries || delay > maxBackoffMs)
            throw new YouTrackReadError(failure.code);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    },
  };
}
