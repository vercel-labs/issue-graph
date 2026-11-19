import { JevError, parseRetryAfterSeconds } from "./semantic-jev.js";

export type RetryDelayOptions = {
  maxRetries: number;
  maxWaitMs: number;
  now?: () => number;
};

export function retryDelayMs(
  error: JevError,
  retryIndex: number,
  options: RetryDelayOptions,
): number | null {
  if (
    !(error instanceof JevError) ||
    error.code !== "gateway-http-error" ||
    error.status !== 429 ||
    !error.attempted ||
    !Number.isInteger(retryIndex) ||
    retryIndex < 0 ||
    !Number.isInteger(options.maxRetries) ||
    options.maxRetries < 0 ||
    options.maxRetries > 3 ||
    retryIndex >= options.maxRetries ||
    !Number.isFinite(options.maxWaitMs) ||
    options.maxWaitMs < 0 ||
    options.maxWaitMs > 30000
  ) {
    return null;
  }
  let seconds = error.retryAfterSeconds;
  if (seconds !== null && (!Number.isFinite(seconds) || seconds < 0)) return null;
  const raw = error.diagnostic?.retryAfterRaw;
  if (raw !== undefined && seconds !== null) {
    const now = (options.now ?? Date.now)();
    if (!Number.isFinite(now)) return null;
    const current = parseRetryAfterSeconds(raw, now);
    if (current !== null) seconds = current;
  }
  const delay = Math.max(1000 * 2 ** retryIndex, (seconds ?? 0) * 1000);
  return Number.isFinite(delay) && delay <= options.maxWaitMs ? delay : null;
}

export type SemanticWaitOptions = {
  now?: () => number;
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  pollMs?: number;
};

function timerSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

export async function abortableSleep(
  delayMs: number,
  signal?: AbortSignal,
  stopFn: () => boolean | Promise<boolean> = () => false,
  options: SemanticWaitOptions = {},
): Promise<boolean> {
  const pollMs = options.pollMs ?? 50;
  if (
    !Number.isFinite(delayMs) ||
    delayMs < 0 ||
    !Number.isFinite(pollMs) ||
    pollMs < 1 ||
    pollMs > 100
  ) {
    throw new RangeError("Invalid semantic wait bounds.");
  }
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? timerSleep;
  const start = now();
  if (!Number.isFinite(start)) throw new RangeError("Invalid semantic wait clock.");
  const controller = new AbortController();
  let abort = () => {};
  const aborted = new Promise<false>((resolve) => {
    abort = () => {
      controller.abort();
      resolve(false);
    };
  });
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const wait = async (): Promise<boolean> => {
    while (true) {
      if (controller.signal.aborted || (await stopFn()) || controller.signal.aborted) return false;
      const current = now();
      if (!Number.isFinite(current)) throw new RangeError("Invalid semantic wait clock.");
      const remaining = delayMs - Math.max(0, current - start);
      if (remaining <= 0) return true;
      await sleep(Math.min(remaining, pollMs), controller.signal);
    }
  };
  try {
    return await Promise.race([aborted, wait()]);
  } finally {
    controller.abort();
    signal?.removeEventListener("abort", abort);
  }
}
