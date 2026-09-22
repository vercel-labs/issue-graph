import { afterEach, describe, expect, test, vi } from "vitest";
import { JevError, parseRetryAfterSeconds } from "./semantic-jev.js";
import { abortableSleep, retryDelayMs } from "./semantic-rate.js";

const nowMs = Date.parse("2030-10-21T07:27:00Z");
const options = { maxRetries: 3, maxWaitMs: 30000 };

function throttled(seconds: number | null = null, raw?: string) {
  return new JevError("gateway-http-error", {
    attempted: true,
    status: 429,
    retryAfterSeconds: seconds,
    ...(raw === undefined
      ? {}
      : { diagnostic: { trust: "untrusted", availability: "available", retryAfterRaw: raw } }),
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Retry-After", () => {
  test.each([
    [null, null],
    ["", null],
    [" ", null],
    ["0", 0],
    ["12", 12],
    ["1.5", 1.5],
    [" 2 ", 2],
    ["-1", null],
    ["-0.5", null],
    ["+1", null],
    ["1e3", null],
    ["NaN", null],
    ["Infinity", null],
    ["1,2", null],
    ["Mon, 21 Oct 2030 07:28:00 GMT", 60],
    ["Mon, 21 Oct 2030 07:26:00 GMT", 0],
    ["Mon, 21 Oct 2030 07:27:00 GMT", 0],
    ["not a date", null],
    ["2030-10-21", null],
    ["Mon, 99 Oct 2030 07:28:00 GMT", null],
    ["Mon, 30 Feb 2030 07:28:00 GMT", null],
    ["Mon, 21 Oct 2030 99:28:00 GMT", null],
    ["86401", 86401],
    ["999999999", 999999999],
    ["9".repeat(400), Number.POSITIVE_INFINITY],
    ["9".repeat(2000), Number.POSITIVE_INFINITY],
  ])("parses %s without a quota assumption or shortened server wait", (raw, expected) => {
    expect(parseRetryAfterSeconds(raw, nowMs)).toBe(expected);
  });
});

describe("retryDelayMs", () => {
  test("uses 0-based 1s, 2s, 4s backoff and refuses exhausted or disabled retries", () => {
    expect([0, 1, 2, 3].map((index) => retryDelayMs(throttled(), index, options))).toEqual([
      1000,
      2000,
      4000,
      null,
    ]);
    expect(retryDelayMs(throttled(), 0, { ...options, maxRetries: 0 })).toBeNull();
    expect(retryDelayMs(throttled(), 1, { ...options, maxRetries: 1 })).toBeNull();
  });

  test.each([
    0, 0.5, 1, 1.5, 15, 30,
  ])("respects server seconds %s and never reduces backoff", (seconds) => {
    expect(retryDelayMs(throttled(seconds), 0, options)).toBe(Math.max(1000, seconds * 1000));
  });

  test.each([
    30.001,
    86401,
    999999999,
    Number.MAX_VALUE,
    Number.POSITIVE_INFINITY,
    Number.NaN,
    -1,
  ])("defers rather than shortening unsupported or excessive hint %s", (seconds) => {
    expect(retryDelayMs(throttled(seconds), 0, options)).toBeNull();
  });

  test("refuses rather than capping either server hint or exponential wait", () => {
    expect(retryDelayMs(throttled(3), 0, { ...options, maxWaitMs: 2999 })).toBeNull();
    expect(retryDelayMs(throttled(), 2, { ...options, maxWaitMs: 3999 })).toBeNull();
    expect(retryDelayMs(throttled(), 0, { ...options, maxWaitMs: 999 })).toBeNull();
  });

  test("recomputes HTTP-date hints using an injected clock", () => {
    const error = throttled(60, "Mon, 21 Oct 2030 07:28:00 GMT");
    expect(retryDelayMs(error, 0, { ...options, now: () => nowMs })).toBeNull();
    expect(retryDelayMs(error, 0, { ...options, now: () => nowMs + 45000 })).toBe(15000);
    expect(retryDelayMs(error, 0, { ...options, now: () => nowMs + 61000 })).toBe(1000);
    expect(retryDelayMs(error, 0, { ...options, now: () => Number.NaN })).toBeNull();
  });

  test("never shortens an overflow hint because raw projection was truncated", () => {
    expect(
      retryDelayMs(throttled(Number.POSITIVE_INFINITY, `${"9".repeat(127)}…`), 0, {
        ...options,
        now: () => nowMs,
      }),
    ).toBeNull();
    expect(
      retryDelayMs(throttled(86401, "[redacted]"), 0, { ...options, now: () => nowMs }),
    ).toBeNull();
  });

  test.each([
    400, 401, 403, 408, 422, 500, 502, 503, 504, 529,
  ])("refuses HTTP %s even with Retry-After", (status) => {
    expect(
      retryDelayMs(
        new JevError("gateway-http-error", { attempted: true, status, retryAfterSeconds: 1 }),
        0,
        options,
      ),
    ).toBeNull();
  });

  test.each([
    "gateway-network-error",
    "gateway-timeout",
    "gateway-aborted",
    "gateway-invalid-json",
    "gateway-response-too-large",
    "gateway-invalid-request",
    "gateway-attempt-error",
    "gateway-http-callback-error",
  ] as const)("refuses %s even with forged 429 status", (code) => {
    expect(
      retryDelayMs(new JevError(code, { attempted: true, status: 429 }), 0, options),
    ).toBeNull();
  });

  test("refuses unattempted or non-adapter validation and storage failures", () => {
    expect(
      retryDelayMs(
        new JevError("gateway-http-error", { attempted: false, status: 429 }),
        0,
        options,
      ),
    ).toBeNull();
    for (const error of [
      new Error("storage"),
      { code: "gateway-http-error", status: 429, attempted: true },
      null,
    ])
      expect(retryDelayMs(error as JevError, 0, options)).toBeNull();
  });

  test.each([
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])("refuses invalid retry index %s", (index) => {
    expect(retryDelayMs(throttled(), index, options)).toBeNull();
  });

  test.each([
    { maxRetries: -1 },
    { maxRetries: 4 },
    { maxRetries: 1.5 },
    { maxRetries: Number.NaN },
    { maxWaitMs: -1 },
    { maxWaitMs: 30001 },
    { maxWaitMs: Number.POSITIVE_INFINITY },
    { maxWaitMs: Number.NaN },
  ])("refuses invalid bounds %j", (override) => {
    expect(retryDelayMs(throttled(), 0, { ...options, ...override })).toBeNull();
  });
});

describe("abortableSleep", () => {
  test("uses injected sleep and clock, checking STOP while waiting and at wake", async () => {
    let clock = 0;
    const sleep = vi.fn(async (delayMs: number) => {
      clock += delayMs;
    });
    const stop = vi.fn(() => false);
    await expect(abortableSleep(125, undefined, stop, { now: () => clock, sleep })).resolves.toBe(
      true,
    );
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([50, 50, 25]);
    expect(stop).toHaveBeenCalledTimes(4);
  });

  test.each([0, 50, 100])("STOP at %s ms prevents wake permission", async (at) => {
    let clock = 0;
    const sleep = vi.fn(async (delayMs: number) => {
      clock += delayMs;
    });
    await expect(
      abortableSleep(100, undefined, async () => clock >= at, { now: () => clock, sleep }),
    ).resolves.toBe(false);
    expect(clock).toBe(at);
  });

  test("STOP is checked even for zero delay", async () => {
    const sleep = vi.fn();
    const stop = vi.fn(() => true);
    await expect(abortableSleep(0, undefined, stop, { sleep })).resolves.toBe(false);
    expect(stop).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  test("preabort never waits and never exposes the signal reason", async () => {
    const controller = new AbortController();
    controller.abort(new Error("private-reason"));
    const sleep = vi.fn();
    const stop = vi.fn();
    await expect(abortableSleep(100, controller.signal, stop, { sleep })).resolves.toBe(false);
    expect(sleep).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  test("abort while waiting is prompt and cleans up timers and listeners", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const result = abortableSleep(30000, controller.signal);
    await vi.advanceTimersByTimeAsync(10);
    controller.abort("private-reason");
    await expect(result).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledOnce();
  });

  test("polls STOP using real timer behavior and clears timers on stop", async () => {
    vi.useFakeTimers();
    let stopped = false;
    const result = abortableSleep(1000, undefined, () => stopped, { now: Date.now });
    await vi.advanceTimersByTimeAsync(40);
    stopped = true;
    await vi.advanceTimersByTimeAsync(10);
    await expect(result).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("abort wins over an injected sleep that ignores signals", async () => {
    const controller = new AbortController();
    const sleep = vi.fn(() => new Promise<void>(() => {}));
    const result = abortableSleep(100, controller.signal, () => false, { sleep });
    await Promise.resolve();
    expect(sleep).toHaveBeenCalledOnce();
    controller.abort();
    await expect(result).resolves.toBe(false);
  });

  test("abort wins over an asynchronous STOP check that never settles", async () => {
    const controller = new AbortController();
    const result = abortableSleep(100, controller.signal, () => new Promise<boolean>(() => {}));
    controller.abort();
    await expect(result).resolves.toBe(false);
  });

  test("abort during the final STOP check prevents dispatch permission", async () => {
    const controller = new AbortController();
    await expect(
      abortableSleep(0, controller.signal, () => {
        controller.abort();
        return false;
      }),
    ).resolves.toBe(false);
  });

  test("propagates STOP/storage read failure without converting it to retry permission", async () => {
    await expect(
      abortableSleep(100, undefined, () => {
        throw new Error("STOP read failed");
      }),
    ).rejects.toThrow("STOP read failed");
  });

  test.each([
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])("rejects invalid delay %s", async (delay) => {
    await expect(abortableSleep(delay)).rejects.toThrow(RangeError);
  });

  test.each([0, 101, Number.NaN])("rejects invalid polling budget %s", async (pollMs) => {
    await expect(abortableSleep(1, undefined, undefined, { pollMs })).rejects.toThrow(RangeError);
  });

  test("rejects a nonfinite injected clock", async () => {
    await expect(
      abortableSleep(0, undefined, undefined, { now: () => Number.NaN }),
    ).rejects.toThrow(RangeError);
  });
});
