import { afterEach, describe, expect, test, vi } from "vitest";
import {
  evaluateWithJev,
  JEV_ADAPTER_VERSION,
  JEV_ENDPOINT,
  JEV_MAX_REQUEST_BYTES,
  JEV_MAX_RESPONSE_BYTES,
  JEV_TIMEOUT_MS,
  JevError,
} from "./semantic-jev.js";
import { type GatewayEvaluationRequest, SemanticError } from "./semantic-types.js";

const KEY = "synthetic-api-key-never-real";
const SECRET = "synthetic-private-payload";
const encoder = new TextEncoder();

function request(): GatewayEvaluationRequest {
  return {
    model: "typesafe-ai/jev",
    state: {
      issue: {
        key: "o/r#1",
        id: "I_1",
        url: "https://github.com/o/r/issues/1",
        state: "OPEN",
        title: "Example issue",
        body: SECRET,
        updatedAt: "2026-09-21T00:00:00Z",
        comments: [],
        commentsCoverage: { captured: 0, total: 0, hasNextPage: false, complete: true },
      },
    },
    questions: {
      applicable: { type: "boolean", instructions: "Is this applicable?" },
      component: {
        type: "choice",
        instructions: "Choose a component.",
        criteria: { cli: "CLI", docs: "Documentation" },
      },
      severity: { type: "score", instructions: "Score severity.", criteria: ["low", "high"] },
    },
    providerOptions: { gateway: { only: ["typesafe-ai"] } },
  };
}

function mockFetch(respond: () => Response | Promise<Response> = () => new Response("{}")) {
  return vi.fn<typeof globalThis.fetch>(async () => respond());
}

async function safeError(promise: Promise<unknown>, code: string, attempted = true) {
  const error: unknown = await promise.catch((error: unknown) => error);
  expect(error).toBeInstanceOf(JevError);
  expect(error).toBeInstanceOf(SemanticError);
  expect(error).toMatchObject({ code, attempted });
  for (const text of [String(error), JSON.stringify(error), (error as Error).stack ?? ""]) {
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(SECRET);
  }
  expect(error).not.toHaveProperty("cause");
  return error as JevError;
}

function streamResponse(chunks: Uint8Array[], headers?: HeadersInit) {
  let index = 0;
  const cancel = vi.fn();
  const response = new Response(
    new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          const chunk = chunks[index++];
          if (chunk) controller.enqueue(chunk);
          else controller.close();
        },
        cancel,
      },
      { highWaterMark: 0 },
    ),
    { headers },
  );
  return { response, cancel };
}

function stalledBody() {
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"partial":'));
      },
      cancel,
    }),
  );
  const fetch = mockFetch(() => response);
  return { fetch, cancel, response };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("evaluateWithJev", () => {
  test("exports the fixed adapter contract", () => {
    expect(JEV_ADAPTER_VERSION).toBe("gateway-http-v1");
    expect(JEV_ENDPOINT).toBe("https://ai-gateway.vercel.sh/v1/evaluate");
    expect(JEV_MAX_REQUEST_BYTES).toBe(24000);
    expect(JEV_MAX_RESPONSE_BYTES).toBe(262144);
    expect(JEV_TIMEOUT_MS).toBe(30000);
    expect(new JevError("gateway-network-error", { attempted: false })).toMatchObject({
      name: "JevError",
      code: "gateway-network-error",
      attempted: false,
      status: null,
      retryAfterSeconds: null,
      exitCode: 1,
    });
  });

  test("sends the exact documented payload, supplied key and fixed routing once", async () => {
    const input = request();
    const before = JSON.stringify(input);
    const result = {
      model: "typesafe-ai/jev",
      answers: { applicable: { probability: 0.9 }, unknown: { untouched: true } },
      usage: { inputTokens: 100, outputTokens: 20 },
      providerMetadata: {
        gateway: {
          routing: {
            originalModelId: "typesafe-ai/jev",
            resolvedProvider: "typesafe-ai",
            canonicalSlug: "typesafe-ai/jev",
            finalProvider: "typesafe-ai",
          },
          cost: "0.00001",
        },
      },
    };
    const order: string[] = [];
    const onAttempt = vi.fn(() => order.push("attempt"));
    const fetch = mockFetch(() => {
      order.push("fetch");
      return Response.json(result);
    });
    const evaluated: unknown = await evaluateWithJev(input, { apiKey: KEY, fetch, onAttempt });
    expect(evaluated).toEqual(result);
    expect(JSON.stringify(input)).toBe(before);
    expect(order).toEqual(["attempt", "fetch"]);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(JEV_ENDPOINT, {
      method: "POST",
      headers: expect.any(Headers),
      body: before,
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
    const init = fetch.mock.calls[0][1];
    expect(Object.fromEntries(new Headers(init?.headers))).toEqual({
      authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
      accept: "application/json",
    });
    expect(JSON.parse(String(init?.body))).toEqual(input);
    expect(onAttempt).toHaveBeenCalledTimes(1);
  });

  test.each([
    { value: null },
    { value: [] },
    { value: 42 },
    { value: "uninterpreted" },
    { value: { invalidSemanticShape: true } },
  ])("does not interpret parsed JSON: $value", async ({ value }) => {
    const fetch = mockFetch(() => Response.json(value));
    await expect(evaluateWithJev(request(), { apiKey: KEY, fetch })).resolves.toEqual(value);
  });

  test("uses global fetch only when no injected fetch is supplied", async () => {
    const fetch = mockFetch();
    vi.stubGlobal("fetch", fetch);
    await evaluateWithJev(request(), { apiKey: KEY });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test.each([
    "",
    " ",
    `${KEY}\r\nX-Secret: ${SECRET}`,
    `${KEY}\n`,
    `${KEY}\0`,
    "é",
    `${KEY} value`,
  ])("rejects absent or invalid header keys without attempting HTTP (%#)", async (apiKey) => {
    const fetch = mockFetch();
    const onAttempt = vi.fn();
    const error = await safeError(
      evaluateWithJev(request(), { apiKey, fetch, onAttempt }),
      "gateway-invalid-api-key",
      false,
    );
    expect(error.status).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(onAttempt).not.toHaveBeenCalled();
  });

  test("rejects a missing runtime key without consulting any fallback", async () => {
    const fetch = mockFetch();
    await safeError(
      evaluateWithJev(request(), { apiKey: undefined as unknown as string, fetch }),
      "gateway-invalid-api-key",
      false,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each([
    { model: "other/model" },
    { providerOptions: undefined },
    { providerOptions: { gateway: { only: ["other"] } } },
    { providerOptions: { gateway: { only: ["typesafe-ai", "other"] } } },
    { providerOptions: { gateway: { only: [] } } },
    { providerOptions: { gateway: { only: ["typesafe-ai"], order: ["other"] } } },
    { providerOptions: { gateway: { only: ["typesafe-ai"] }, other: {} } },
    { models: ["other/model"] },
  ])("rejects model or routing overrides (%#)", async (override) => {
    const fetch = mockFetch();
    const onAttempt = vi.fn();
    await safeError(
      evaluateWithJev({ ...request(), ...override } as GatewayEvaluationRequest, {
        apiKey: KEY,
        fetch,
        onAttempt,
      }),
      "gateway-invalid-request",
      false,
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(onAttempt).not.toHaveBeenCalled();
  });

  test("checks the actual serialized model and routing", async () => {
    const fetch = mockFetch();
    const input = Object.assign(request(), {
      toJSON: () => ({ ...request(), model: "other/model" }),
    });
    await safeError(
      evaluateWithJev(input, { apiKey: KEY, fetch }),
      "gateway-invalid-request",
      false,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  test("sanitizes serialization failures", async () => {
    const fetch = mockFetch();
    const input = Object.assign(request(), {
      toJSON() {
        throw new Error(`${KEY} ${SECRET}`);
      },
    });
    await safeError(
      evaluateWithJev(input, { apiKey: KEY, fetch }),
      "gateway-invalid-request",
      false,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  test("enforces the exact UTF-8 request boundary before onAttempt or fetch", async () => {
    const input = request();
    input.state.issue.body = "";
    const overhead = encoder.encode(JSON.stringify(input)).byteLength;
    const remaining = JEV_MAX_REQUEST_BYTES - overhead;
    input.state.issue.body = "é".repeat(Math.floor(remaining / 2)) + "x".repeat(remaining % 2);
    expect(encoder.encode(JSON.stringify(input))).toHaveLength(JEV_MAX_REQUEST_BYTES);
    const fetch = mockFetch();
    const onAttempt = vi.fn();
    await evaluateWithJev(input, { apiKey: KEY, fetch, onAttempt });
    expect(fetch).toHaveBeenCalledTimes(1);
    input.state.issue.body += "é";
    expect(JSON.stringify(input).length).toBeLessThan(JEV_MAX_REQUEST_BYTES);
    await safeError(
      evaluateWithJev(input, { apiKey: KEY, fetch, onAttempt }),
      "input-too-large",
      false,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(onAttempt).toHaveBeenCalledTimes(1);
  });

  test.each([
    0,
    -1,
    30001,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    null as unknown as number,
    "10" as unknown as number,
  ])("rejects timeoutMs outside the integer range: %s", async (timeoutMs) => {
    const fetch = mockFetch();
    const onAttempt = vi.fn();
    await safeError(
      evaluateWithJev(request(), { apiKey: KEY, fetch, timeoutMs, onAttempt }),
      "gateway-invalid-timeout",
      false,
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(onAttempt).not.toHaveBeenCalled();
  });

  test.each([1, 30000])("accepts timeoutMs at the boundary: %s", async (timeoutMs) => {
    const fetch = mockFetch();
    await expect(evaluateWithJev(request(), { apiKey: KEY, fetch, timeoutMs })).resolves.toEqual(
      {},
    );
  });

  test.each([
    401, 403, 422, 429, 529, 500, 502, 503, 504, 599, 302,
  ])("returns sanitized HTTP status %s after bounded diagnostic reading without retrying", async (status) => {
    const { response, cancel } = streamResponse([encoder.encode(`${KEY} ${SECRET}`)]);
    const errorResponse = new Response(response.body, {
      status,
      statusText: SECRET,
      headers: { "retry-after": "15", "x-error": `${KEY} ${SECRET}` },
    });
    const fetch = mockFetch(() => errorResponse);
    const onAttempt = vi.fn();
    const error = await safeError(
      evaluateWithJev(request(), { apiKey: KEY, fetch, onAttempt }),
      "gateway-http-error",
    );
    expect(error.status).toBe(status);
    expect(error.retryAfterSeconds).toBe(status === 429 ? 15 : null);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(onAttempt).toHaveBeenCalledTimes(1);
    expect(error.diagnostic).toMatchObject({
      availability: "unavailable",
      unavailableReason: "invalid-json",
    });
    expect(errorResponse.bodyUsed).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["0", 0],
    ["12", 12],
    ["86400", 86400],
    ["86401", 86401],
    ["9".repeat(400), Number.POSITIVE_INFINITY],
    ["1.5", 1.5],
    ["-1", null],
    ["Infinity", null],
    ["1e3", null],
    ["Wed, 21 Oct 2030 07:28:00 GMT", 60],
    [SECRET, null],
    [null, null],
  ])("parses 429 Retry-After without shortening server hints (%#)", async (value, expected) => {
    const fetch = mockFetch(
      () =>
        new Response(SECRET, {
          status: 429,
          headers: value === null ? {} : { "Retry-After": value },
        }),
    );
    const error = await safeError(
      evaluateWithJev(request(), { apiKey: KEY, fetch, nowMs: Date.parse("2030-10-21T07:27:00Z") }),
      "gateway-http-error",
    );
    expect(error.retryAfterSeconds).toBe(expected);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test.each([
    "sync",
    "async",
    "abort-shaped",
  ])("sanitizes %s transport errors without retry", async (kind) => {
    const error =
      kind === "abort-shaped"
        ? new DOMException(`${KEY} ${SECRET}`, "AbortError")
        : new Error(`${KEY} ${SECRET}`);
    const fetch = vi.fn<typeof globalThis.fetch>(() => {
      if (kind === "sync") throw error;
      return Promise.reject(error);
    });
    await safeError(evaluateWithJev(request(), { apiKey: KEY, fetch }), "gateway-network-error");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("asynchronous callback failure never fetches", async () => {
    const fetch = mockFetch();
    const onAttempt = vi.fn(async () => {
      throw new Error(`${KEY} ${SECRET}`);
    });
    await safeError(
      evaluateWithJev(request(), { apiKey: KEY, fetch, onAttempt }),
      "gateway-attempt-error",
      false,
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(onAttempt).toHaveBeenCalledTimes(1);
  });

  test("callback completion after the deadline cannot start a request", async () => {
    vi.useFakeTimers();
    let complete: () => void = () => {};
    const fetch = mockFetch();
    const onAttempt = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    const checked = safeError(
      evaluateWithJev(request(), { apiKey: KEY, fetch, onAttempt, timeoutMs: 1 }),
      "gateway-timeout",
      false,
    );
    await vi.advanceTimersByTimeAsync(1);
    await checked;
    complete();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(onAttempt).toHaveBeenCalledTimes(1);
  });

  test("does not trust an upstream exception masquerading as an adapter error", async () => {
    const upstream = new JevError("gateway-network-error", { attempted: true });
    upstream.message = `${KEY} ${SECRET}`;
    const response = new Response("{}");
    Object.defineProperty(response, "body", {
      get() {
        throw upstream;
      },
    });
    await safeError(
      evaluateWithJev(request(), { apiKey: KEY, fetch: mockFetch(() => response) }),
      "gateway-network-error",
    );
  });

  test("callback failure is sanitized and never fetches", async () => {
    vi.useFakeTimers();
    const fetch = mockFetch();
    const onAttempt = vi.fn(() => {
      throw new Error(`${KEY} ${SECRET}`);
    });
    await safeError(
      evaluateWithJev(request(), { apiKey: KEY, fetch, onAttempt }),
      "gateway-attempt-error",
      false,
    );
    expect(onAttempt).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  test.each([
    undefined,
    "1",
    "garbage",
    "-1",
  ])("caps streamed UTF-8 bytes despite missing or false Content-Length (%#)", async (length) => {
    const bytes = encoder.encode(`"${"é".repeat(JEV_MAX_RESPONSE_BYTES / 2)}"`);
    const { response, cancel } = streamResponse(
      [bytes.slice(0, 1000), bytes.slice(1000)],
      length === undefined ? undefined : { "Content-Length": length },
    );
    const fetch = mockFetch(() => response);
    await safeError(
      evaluateWithJev(request(), { apiKey: KEY, fetch }),
      "gateway-response-too-large",
    );
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("rejects an oversized declared response without reading a stalled body", async () => {
    const { response, fetch, cancel } = stalledBody();
    response.headers.set("content-length", String(JEV_MAX_RESPONSE_BYTES + 1));
    await safeError(
      evaluateWithJev(request(), { apiKey: KEY, fetch }),
      "gateway-response-too-large",
    );
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test("accepts the exact byte cap and decodes multibyte characters across chunks", async () => {
    const value = "é".repeat((JEV_MAX_RESPONSE_BYTES - 2) / 2);
    const bytes = encoder.encode(JSON.stringify(value));
    expect(bytes).toHaveLength(JEV_MAX_RESPONSE_BYTES);
    const { response } = streamResponse([bytes.slice(0, 2), bytes.slice(2)]);
    await expect(
      evaluateWithJev(request(), { apiKey: KEY, fetch: mockFetch(() => response) }),
    ).resolves.toBe(value);
  });

  test.each([
    "",
    `${KEY} ${SECRET}`,
    '{"broken":',
    "{} {}",
  ])("sanitizes invalid JSON (%#)", async (body) => {
    const fetch = mockFetch(() => new Response(body));
    await safeError(evaluateWithJev(request(), { apiKey: KEY, fetch }), "gateway-invalid-json");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("rejects malformed UTF-8 instead of silently replacing bytes", async () => {
    const { response } = streamResponse([new Uint8Array([34, 0xc3, 34])]);
    await safeError(
      evaluateWithJev(request(), { apiKey: KEY, fetch: mockFetch(() => response) }),
      "gateway-invalid-json",
    );
  });

  test("sanitizes a failed body reader", async () => {
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          controller.error(new Error(`${KEY} ${SECRET}`));
        },
      }),
    );
    const fetch = mockFetch(() => response);
    await safeError(evaluateWithJev(request(), { apiKey: KEY, fetch }), "gateway-network-error");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("the default 30-second timer bounds fetch even when it ignores AbortSignal", async () => {
    vi.useFakeTimers();
    const fetch = mockFetch(() => new Promise<Response>(() => {}));
    const onAttempt = vi.fn();
    let settled = false;
    const checked = safeError(
      evaluateWithJev(request(), { apiKey: KEY, fetch, onAttempt }),
      "gateway-timeout",
    ).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(29999);
    expect(settled).toBe(false);
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await checked;
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(onAttempt).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("one default deadline covers fetch and a stalled body, even if cancellation hangs", async () => {
    vi.useFakeTimers();
    const { response, cancel } = stalledBody();
    const fetch = mockFetch(
      () => new Promise<Response>((resolve) => setTimeout(() => resolve(response), 20000)),
    );
    let settled = false;
    const checked = safeError(
      evaluateWithJev(request(), { apiKey: KEY, fetch }),
      "gateway-timeout",
    ).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(29999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await checked;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("timeout bounds an injected reader whose read and cancel both never settle", async () => {
    vi.useFakeTimers();
    const read = vi.fn(() => new Promise<ReadableStreamReadResult<Uint8Array>>(() => {}));
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const releaseLock = vi.fn();
    const response = {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: { getReader: () => ({ read, cancel, releaseLock }) },
    } as unknown as Response;
    const fetch = mockFetch(() => response);
    const checked = safeError(
      evaluateWithJev(request(), { apiKey: KEY, fetch, timeoutMs: 10 }),
      "gateway-timeout",
    );
    await vi.advanceTimersByTimeAsync(10);
    await checked;
    expect(read).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("preabort makes zero attempts and does not leak the abort reason", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort(new Error(`${KEY} ${SECRET}`));
    const fetch = mockFetch();
    const onAttempt = vi.fn();
    await safeError(
      evaluateWithJev(request(), { apiKey: KEY, fetch, signal: controller.signal, onAttempt }),
      "gateway-aborted",
      false,
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(onAttempt).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("abort inside onAttempt prevents fetch", async () => {
    const controller = new AbortController();
    const fetch = mockFetch();
    const onAttempt = vi.fn(() => controller.abort(SECRET));
    await safeError(
      evaluateWithJev(request(), { apiKey: KEY, fetch, signal: controller.signal, onAttempt }),
      "gateway-aborted",
      false,
    );
    expect(onAttempt).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each([
    "fetch",
    "body",
  ])("abort during %s promptly rejects despite ignored signals", async (phase) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const stalled = stalledBody();
    const fetch =
      phase === "body" ? stalled.fetch : mockFetch(() => new Promise<Response>(() => {}));
    const checked = safeError(
      evaluateWithJev(request(), { apiKey: KEY, fetch, signal: controller.signal }),
      "gateway-aborted",
    );
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new Error(`${KEY} ${SECRET}`));
    await checked;
    if (phase === "body") expect(stalled.cancel).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("cancels a response that arrives after timeout without reading or retrying", async () => {
    vi.useFakeTimers();
    let resolve: (response: Response) => void = () => {};
    const fetch = mockFetch(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    const checked = safeError(
      evaluateWithJev(request(), { apiKey: KEY, fetch, timeoutMs: 1 }),
      "gateway-timeout",
    );
    await vi.advanceTimersByTimeAsync(1);
    await checked;
    const { response, cancel } = stalledBody();
    resolve(response);
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("cleans up timers and signal listeners after success", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const fetch = mockFetch();
    await evaluateWithJev(request(), { apiKey: KEY, fetch, signal: controller.signal });
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledExactlyOnceWith("abort", expect.any(Function));
    controller.abort();
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(false);
  });

  test("re-exports the dependency-free adapter version unchanged", async () => {
    const version = await import("./semantic-version.js");
    expect(version.JEV_ADAPTER_VERSION).toBe("gateway-http-v1");
    expect(version.JEV_ADAPTER_VERSION).toBe(JEV_ADAPTER_VERSION);
  });

  test("publishes 429 synchronously at headers so another worker defers during diagnostic reading", async () => {
    vi.useFakeTimers();
    const stalled = stalledBody();
    const response = new Response(stalled.response.body, {
      status: 429,
      headers: { "retry-after": "15" },
    });
    const events: string[] = [];
    const getReader = response.body?.getReader.bind(response.body);
    vi.spyOn(response.body as ReadableStream<Uint8Array>, "getReader").mockImplementation(() => {
      events.push("read");
      expect(events).toEqual(["throttle", "read"]);
      return getReader?.() as ReadableStreamDefaultReader<Uint8Array>;
    });
    let throttleUntil = 0;
    let finished = false;
    const onHttpError = vi.fn((error: JevError) => {
      events.push("throttle");
      expect(error).toMatchObject({
        code: "gateway-http-error",
        attempted: true,
        status: 429,
        retryAfterSeconds: 15,
      });
      expect(error.diagnostic).toBeUndefined();
      expect(response.bodyUsed).toBe(false);
      throttleUntil = Date.now() + (error.retryAfterSeconds ?? 0) * 1000;
    });
    const fetch = mockFetch(() => response);
    const pending = safeError(
      evaluateWithJev(request(), { apiKey: KEY, fetch, onHttpError }),
      "gateway-http-error",
    ).then((error) => {
      finished = true;
      return error;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(onHttpError).toHaveBeenCalledOnce();
    const otherWorker = async () => {
      if (Date.now() < throttleUntil) return "deferred";
      return evaluateWithJev(request(), { apiKey: KEY, fetch });
    };
    await expect(otherWorker()).resolves.toBe("deferred");
    await vi.advanceTimersByTimeAsync(499);
    expect(finished).toBe(false);
    await expect(otherWorker()).resolves.toBe("deferred");
    await vi.advanceTimersByTimeAsync(1);
    const error = await pending;
    expect(error.diagnostic).toMatchObject({
      availability: "unavailable",
      unavailableReason: "read-budget",
    });
    expect(error).not.toBe(onHttpError.mock.calls[0][0]);
    expect(onHttpError.mock.calls[0][0].diagnostic).toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();
    expect(stalled.cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  test.each([
    401, 429, 500,
  ])("reports HTTP %s once before projecting the final diagnostic", async (status) => {
    const onHttpError = vi.fn();
    const error = await safeError(
      evaluateWithJev(request(), {
        apiKey: KEY,
        onHttpError,
        fetch: mockFetch(() =>
          Response.json({ error: { code: "denied" } }, { status, headers: { "retry-after": "3" } }),
        ),
      }),
      "gateway-http-error",
    );
    expect(onHttpError).toHaveBeenCalledOnce();
    expect(onHttpError.mock.calls[0][0]).toMatchObject({
      status,
      retryAfterSeconds: status === 429 ? 3 : null,
      attempted: true,
    });
    expect(onHttpError.mock.calls[0][0].diagnostic).toBeUndefined();
    expect(error.diagnostic).toMatchObject({ code: "denied", availability: "available" });
  });

  test.each([
    "success",
    "network",
    "validation",
  ])("does not emit the HTTP-error hook for %s", async (kind) => {
    const onHttpError = vi.fn();
    await evaluateWithJev(request(), {
      apiKey: kind === "validation" ? "" : KEY,
      onHttpError,
      fetch: mockFetch(() => {
        if (kind === "network") throw new Error(KEY);
        return new Response("{}");
      }),
    }).catch(() => {});
    expect(onHttpError).not.toHaveBeenCalled();
  });

  test.each([
    "throw",
    "async-reject",
    "async-resolve",
  ])("fails safely for %s HTTP-error callbacks without reading or ignoring failure", async (kind) => {
    vi.useFakeTimers();
    const stalled = stalledBody();
    const response = new Response(stalled.response.body, {
      status: 429,
      headers: { "retry-after": "15" },
    });
    const getReader = vi.spyOn(response.body as ReadableStream<Uint8Array>, "getReader");
    const fetch = mockFetch(() => response);
    const onHttpError = vi.fn(() => {
      if (kind === "throw") throw new Error(`${KEY} ${SECRET}`);
      return kind === "async-reject"
        ? Promise.reject(new Error(`${KEY} ${SECRET}`))
        : Promise.resolve();
    });
    const error = await safeError(
      evaluateWithJev(request(), { apiKey: KEY, fetch, onHttpError }),
      "gateway-http-callback-error",
    );
    expect(error).toMatchObject({ status: 429, retryAfterSeconds: 15, attempted: true });
    expect(error.diagnostic).toBeUndefined();
    expect(onHttpError).toHaveBeenCalledOnce();
    expect(getReader).not.toHaveBeenCalled();
    expect(stalled.cancel).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("abort inside the header hook prevents diagnostic reading", async () => {
    const controller = new AbortController();
    const stalled = stalledBody();
    const response = new Response(stalled.response.body, { status: 429 });
    const getReader = vi.spyOn(response.body as ReadableStream<Uint8Array>, "getReader");
    await safeError(
      evaluateWithJev(request(), {
        apiKey: KEY,
        fetch: mockFetch(() => response),
        signal: controller.signal,
        onHttpError: () => controller.abort(KEY),
      }),
      "gateway-aborted",
    );
    expect(getReader).not.toHaveBeenCalled();
    expect(stalled.cancel).toHaveBeenCalledOnce();
  });

  test("omits partial request prose, taxonomy fragments and nested free prose", async () => {
    const input = request();
    input.state.issue.body = "First private sentence. Second unrelated sentence.";
    input.questions.component.instructions =
      "Choose a component using the confidentialtaxonomy rules.";
    const response = Response.json(
      {
        error: {
          code: "First private sentence.",
          type: "confidentialtaxonomy",
          message: "First private sentence.",
          requestId: "First private sentence.",
          generationId: "confidentialtaxonomy",
          provider: "Nested free prose containing a taxonomy fragment",
          details: { message: "Second unrelated sentence." },
        },
        providerMetadata: {
          gateway: {
            routing: {
              originalModelId: "Nested free prose",
              resolvedProvider: "First private sentence.",
              canonicalSlug: "confidentialtaxonomy",
              finalProvider: { message: "Second unrelated sentence." },
            },
          },
        },
        message: "Second unrelated sentence.",
      },
      {
        status: 429,
        headers: {
          "x-request-id": "First private sentence.",
          "x-vercel-id": "Nested free prose",
          "retry-after": "Second unrelated sentence.",
        },
      },
    );
    const error = await safeError(
      evaluateWithJev(input, { apiKey: KEY, fetch: mockFetch(() => response) }),
      "gateway-http-error",
    );
    const serialized = JSON.stringify(error.diagnostic);
    for (const fragment of [
      "First private",
      "Second unrelated",
      "confidentialtaxonomy",
      "Nested free prose",
    ])
      expect(serialized).not.toContain(fragment);
    expect(error.diagnostic).not.toHaveProperty("message");
    expect(error.diagnostic?.trust).toBe("untrusted");
  });

  test.each([
    "free prose goes here",
    "<script>",
    '{"nested":"prose"}',
    "token?request=echo",
    "token@host",
  ])("rejects non-token identifier fields (%#)", async (value) => {
    const response = Response.json(
      {
        error: {
          code: value,
          type: value,
          message: value,
          provider: value,
          requestId: value,
          generationId: value,
        },
        providerMetadata: { gateway: { routing: { finalProvider: value } } },
      },
      { status: 429, headers: { "x-vercel-id": value, "retry-after": value } },
    );
    const error = await safeError(
      evaluateWithJev(request(), { apiKey: KEY, fetch: mockFetch(() => response) }),
      "gateway-http-error",
    );
    for (const field of [
      "code",
      "type",
      "requestId",
      "generationId",
      "vercelId",
      "retryAfterRaw",
      "providerReported",
      "message",
    ] as const)
      expect(error.diagnostic?.[field]).toBeUndefined();
  });

  test("redacts standalone encoded keys and patterned secrets in token fields", async () => {
    const encoded = [...KEY].map((char) => `%${char.charCodeAt(0).toString(16)}`).join("");
    const response = Response.json(
      {
        error: {
          code: KEY,
          type: encoded,
          provider: "sk_private-key",
          requestId: "Bearer\tprivate-key",
          generationId: "vck_private-key",
        },
      },
      { status: 429 },
    );
    const error = await safeError(
      evaluateWithJev(request(), { apiKey: KEY, fetch: mockFetch(() => response) }),
      "gateway-http-error",
    );
    expect(error.diagnostic).toMatchObject({
      code: "[redacted]",
      type: "[redacted]",
      requestId: "[redacted]",
      generationId: "[redacted]",
      providerReported: { provider: "[redacted]" },
    });
    expect(JSON.stringify(error.diagnostic)).not.toContain("private-key");
  });

  test("reads the original response before cancellation, without cloning or extra HTTP", async () => {
    const response = Response.json(
      {
        error: { code: "rate_limit", type: "quota", message: "Try later" },
        requestId: "req-1",
        generationId: "gen-1",
      },
      { status: 429 },
    );
    const clone = vi.spyOn(response, "clone").mockImplementation(() => {
      throw new Error("No clones");
    });
    const fetch = mockFetch(() => response);
    const error = await safeError(
      evaluateWithJev(request(), { apiKey: KEY, fetch }),
      "gateway-http-error",
    );
    expect(error.diagnostic).toMatchObject({
      trust: "untrusted",
      availability: "available",
      code: "rate_limit",
      type: "quota",
      requestId: "req-1",
      generationId: "gen-1",
    });
    expect(clone).not.toHaveBeenCalled();
    expect(response.bodyUsed).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("whitelists bounded identifiers and treats all reported routing as untrusted", async () => {
    const response = Response.json(
      {
        error: {
          code: "quota",
          type: "account",
          message: "Provider says free tier",
          provider: "made-up-provider",
          model: "unverified-model",
          accountTier: "free",
          source: "confirmed",
        },
        providerMetadata: {
          gateway: {
            cost: "0",
            routing: {
              originalModelId: "claimed",
              resolvedProvider: "claimed-provider",
              canonicalSlug: "claimed/model",
              finalProvider: "claimed-final",
              apiKey: KEY,
            },
          },
        },
        request: request(),
        rawBody: SECRET,
        arbitrary: KEY,
      },
      {
        status: 429,
        headers: {
          "retry-after": "15",
          "x-request-id": "request-1",
          "x-generation-id": "generation-1",
          "x-vercel-id": "route-1",
          "x-secret": KEY,
          authorization: `Bearer ${KEY}`,
        },
      },
    );
    const error = await safeError(
      evaluateWithJev(request(), { apiKey: KEY, fetch: mockFetch(() => response) }),
      "gateway-http-error",
    );
    expect(error.diagnostic).toEqual({
      trust: "untrusted",
      availability: "available",
      code: "quota",
      type: "account",
      requestId: "request-1",
      generationId: "generation-1",
      vercelId: "route-1",
      retryAfterRaw: "15",
      providerReported: {
        provider: "made-up-provider",
        model: "unverified-model",
        originalModelId: "claimed",
        resolvedProvider: "claimed-provider",
        canonicalSlug: "claimed/model",
        finalProvider: "claimed-final",
      },
    });
    expect(Object.isFrozen(error.diagnostic)).toBe(true);
    expect(Object.isFrozen(error.diagnostic?.providerReported)).toBe(true);
    expect(error.diagnostic).not.toHaveProperty("accountTier");
    expect(error.diagnostic).not.toHaveProperty("source");
    expect(error.diagnostic).not.toHaveProperty("cost");
  });

  test("redacts exact, encoded and patterned secrets plus controls before truncation", async () => {
    const percentKey = [...KEY].map((char) => `%${char.charCodeAt(0).toString(16)}`).join("");
    const unicodeKey = [...KEY]
      .map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)
      .join("");
    const malicious = `${KEY} ${percentKey} ${encodeURIComponent(percentKey)} ${unicodeKey} ${SECRET} Bearer stolen-token sk_stolen-secret vck-stolen-secret \u001b[31mred\u001b[0m\u0000\u0008\r\n\u202etext`;
    const response = Response.json(
      {
        error: {
          code: malicious,
          type: malicious,
          message: malicious,
          requestId: malicious,
          generationId: malicious,
          provider: malicious,
        },
        providerMetadata: { gateway: { routing: { finalProvider: malicious } } },
      },
      {
        status: 429,
        headers: {
          "retry-after": percentKey,
          "x-request-id": percentKey,
          "x-generation-id": percentKey,
          "x-vercel-id": percentKey,
        },
      },
    );
    const error = await safeError(
      evaluateWithJev(request(), { apiKey: KEY, fetch: mockFetch(() => response) }),
      "gateway-http-error",
    );
    const serialized = JSON.stringify(error.diagnostic);
    for (const secret of [
      percentKey,
      unicodeKey,
      "stolen-token",
      "stolen-secret",
      "\\u001b",
      "\\u0000",
      "\\r",
      "\\n",
      "\u202e",
    ])
      expect(serialized).not.toContain(secret);
    expect(error.diagnostic).not.toHaveProperty("message");
    expect(error.diagnostic?.code).toBe("[redacted]");
    expect(error.diagnostic?.requestId).toBe("[redacted]");
    expect(error.diagnostic?.providerReported?.provider).toBe("[redacted]");
  });

  test("redacts tab-separated bearer credentials and embedded token prefixes", async () => {
    const response = Response.json(
      {
        error: {
          message: "Bearer\tprivate-token prefixsk_private-key suffixvck_private-key",
          provider: "typesafe-ai",
          model: "typesafe-ai/jev",
        },
      },
      { status: 429 },
    );
    const error = await safeError(
      evaluateWithJev(request(), { apiKey: KEY, fetch: mockFetch(() => response) }),
      "gateway-http-error",
    );
    expect(error.diagnostic).not.toHaveProperty("message");
    expect(JSON.stringify(error.diagnostic)).not.toContain("private-token");
    expect(JSON.stringify(error.diagnostic)).not.toContain("private-key");
    expect(error.diagnostic?.providerReported).toEqual({
      provider: "typesafe-ai",
      model: "typesafe-ai/jev",
    });
    expect(error.diagnostic?.trust).toBe("untrusted");
  });

  test("redacts keys with regex and URI metacharacters and JSON Unicode escapes", async () => {
    const apiKey = "key.with+slash/equal=";
    const response = new Response(
      `{"error":{"message":"key.with+slash/equal= ${encodeURIComponent(apiKey)} key\\u002ewith+slash/equal="}}`,
      { status: 429 },
    );
    const error = await safeError(
      evaluateWithJev(request(), { apiKey, fetch: mockFetch(() => response) }),
      "gateway-http-error",
    );
    expect(error.diagnostic).not.toHaveProperty("message");
    expect(JSON.stringify(error)).not.toContain(apiKey);
  });

  test("bounds whitelisted headers and long strings without retaining arbitrary headers", async () => {
    const response = Response.json(
      {
        error: {
          code: "c".repeat(500),
          type: "t".repeat(500),
          message: `${"m".repeat(2000)}${KEY}`,
        },
        requestId: "r".repeat(500),
        generationId: "g".repeat(500),
      },
      {
        status: 429,
        headers: {
          "retry-after": "9".repeat(1200),
          "x-vercel-id": `${"v".repeat(10000)}${KEY}`,
          "x-secret": SECRET,
        },
      },
    );
    const error = await safeError(
      evaluateWithJev(request(), { apiKey: KEY, fetch: mockFetch(() => response) }),
      "gateway-http-error",
    );
    for (const field of [
      "code",
      "type",
      "requestId",
      "generationId",
      "retryAfterRaw",
      "vercelId",
    ] as const)
      expect(error.diagnostic?.[field]?.length).toBeLessThanOrEqual(128);
    expect(error.diagnostic).not.toHaveProperty("message");
    expect(error.retryAfterSeconds).toBe(Number.POSITIVE_INFINITY);
    expect(JSON.stringify(error.diagnostic).length).toBeLessThan(1600);
  });

  test.each([
    "",
    "{",
    '{"error":{"message":"partial"}',
    "[]",
    "null",
    '"text"',
  ])("malformed or non-object diagnostics are unavailable (%#)", async (body) => {
    const error = await safeError(
      evaluateWithJev(request(), {
        apiKey: KEY,
        fetch: mockFetch(() => new Response(body, { status: 500 })),
      }),
      "gateway-http-error",
    );
    expect(error.diagnostic).toMatchObject({
      availability: "unavailable",
      unavailableReason: "invalid-json",
    });
    expect(error.diagnostic).not.toHaveProperty("message");
  });

  test.each([
    undefined,
    "1",
    "garbage",
    "-1",
  ])("caps error streams at 8 KiB despite Content-Length %s", async (length) => {
    const streamed = streamResponse([
      encoder.encode(`{"error":{"message":"${"é".repeat(4096)}"}}`),
    ]);
    const response = new Response(streamed.response.body, {
      status: 429,
      headers: length === undefined ? undefined : { "content-length": length },
    });
    const error = await safeError(
      evaluateWithJev(request(), { apiKey: KEY, fetch: mockFetch(() => response) }),
      "gateway-http-error",
    );
    expect(error.diagnostic).toMatchObject({
      availability: "unavailable",
      unavailableReason: "too-large",
    });
    expect(error.diagnostic).not.toHaveProperty("message");
    expect(streamed.cancel).toHaveBeenCalledTimes(1);
  });

  test("accepts exactly 8 KiB of diagnostic JSON", async () => {
    const body = JSON.stringify({ error: { message: "bounded" } });
    const fetch = mockFetch(
      () => new Response(body + " ".repeat(8192 - encoder.encode(body).length), { status: 429 }),
    );
    const error = await safeError(
      evaluateWithJev(request(), { apiKey: KEY, fetch }),
      "gateway-http-error",
    );
    expect(error.diagnostic).toMatchObject({ availability: "available" });
    expect(error.diagnostic).not.toHaveProperty("message");
  });

  test("rejects declared oversized diagnostics without reading and cancels a hanging body", async () => {
    const { response: stalled, cancel } = stalledBody();
    const response = new Response(stalled.body, {
      status: 429,
      headers: { "content-length": "8193" },
    });
    const getReader = vi.spyOn(response.body as ReadableStream<Uint8Array>, "getReader");
    const error = await safeError(
      evaluateWithJev(request(), { apiKey: KEY, fetch: mockFetch(() => response) }),
      "gateway-http-error",
    );
    expect(error.diagnostic).toMatchObject({ unavailableReason: "too-large" });
    expect(getReader).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test("a 500 ms diagnostic budget cancels even when read and cancel never settle", async () => {
    vi.useFakeTimers();
    const read = vi.fn(() => new Promise<ReadableStreamReadResult<Uint8Array>>(() => {}));
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const releaseLock = vi.fn();
    const response = {
      ok: false,
      status: 429,
      headers: new Headers(),
      body: { getReader: () => ({ read, cancel, releaseLock }) },
    } as unknown as Response;
    const fetch = mockFetch(() => response);
    let finished = false;
    const checked = safeError(
      evaluateWithJev(request(), { apiKey: KEY, fetch }),
      "gateway-http-error",
    ).then((error) => {
      finished = true;
      return error;
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await checked).diagnostic).toMatchObject({
      availability: "unavailable",
      unavailableReason: "read-budget",
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("diagnostic reading never extends the original request deadline", async () => {
    vi.useFakeTimers();
    const stalled = stalledBody();
    const response = new Response(stalled.response.body, { status: 429 });
    const fetch = mockFetch(
      () => new Promise<Response>((resolve) => setTimeout(() => resolve(response), 29900)),
    );
    const onTiming = vi.fn();
    const checked = safeError(
      evaluateWithJev(request(), { apiKey: KEY, fetch, onTiming }),
      "gateway-timeout",
    );
    await vi.advanceTimersByTimeAsync(30000);
    const error = await checked;
    expect(error.diagnostic).toBeUndefined();
    expect(stalled.cancel).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(onTiming).toHaveBeenCalledOnce();
    expect(Number.isFinite(onTiming.mock.calls[0][0].totalMs)).toBe(true);
  });

  test("abort during diagnostics cancels promptly, without retry or reason leakage", async () => {
    vi.useFakeTimers();
    const stalled = stalledBody();
    const fetch = mockFetch(() => new Response(stalled.response.body, { status: 429 }));
    const controller = new AbortController();
    const checked = safeError(
      evaluateWithJev(request(), { apiKey: KEY, fetch, signal: controller.signal }),
      "gateway-aborted",
    );
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(KEY);
    await checked;
    expect(stalled.cancel).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test.each([
    "invalid-utf8",
    "reader-error",
  ])("unavailable diagnostic for %s contains no partial body", async (kind) => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          if (kind === "reader-error") controller.error(new Error(KEY));
          else {
            controller.enqueue(new Uint8Array([34, 0xc3, 34]));
            controller.close();
          }
        },
      }),
      { status: 429 },
    );
    const error = await safeError(
      evaluateWithJev(request(), { apiKey: KEY, fetch: mockFetch(() => response) }),
      "gateway-http-error",
    );
    expect(error.diagnostic).toMatchObject({
      availability: "unavailable",
      unavailableReason: kind === "reader-error" ? "read-error" : "invalid-json",
    });
    expect(error.diagnostic).not.toHaveProperty("message");
  });

  test.each([
    "success",
    "http",
    "network",
    "validation",
  ])("emits finite timing once for %s without secrets", async (kind) => {
    const onTiming = vi.fn();
    const fetch = mockFetch(() => {
      if (kind === "network") throw new Error(KEY);
      return new Response("{}", { status: kind === "http" ? 429 : 200 });
    });
    await evaluateWithJev(request(), {
      apiKey: kind === "validation" ? "" : KEY,
      fetch,
      onTiming,
    }).catch(() => {});
    expect(onTiming).toHaveBeenCalledOnce();
    const timing = onTiming.mock.calls[0][0];
    expect(Number.isFinite(timing.totalMs)).toBe(true);
    expect(timing.totalMs).toBeGreaterThanOrEqual(0);
    if (["network", "validation"].includes(kind)) expect(timing.headersMs).toBeNull();
    else {
      expect(Number.isFinite(timing.headersMs)).toBe(true);
      expect(timing.totalMs).toBeGreaterThanOrEqual(timing.headersMs);
    }
    expect(Object.keys(timing).sort()).toEqual(["headersMs", "totalMs"]);
    expect(JSON.stringify(timing)).not.toContain(KEY);
  });

  test("timing observer failure cannot replace the provider outcome", async () => {
    const onTiming = () => {
      throw new Error(KEY);
    };
    await expect(
      evaluateWithJev(request(), { apiKey: KEY, fetch: mockFetch(), onTiming }),
    ).resolves.toEqual({});
    await safeError(
      evaluateWithJev(request(), {
        apiKey: KEY,
        fetch: mockFetch(() => new Response("{}", { status: 429 })),
        onTiming,
      }),
      "gateway-http-error",
    );
  });

  test("never logs keys, payloads, or upstream failures", async () => {
    const logs = ["log", "error", "warn", "info", "debug"] as const;
    const spies = logs.map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
    const fetch = mockFetch(() => {
      throw new Error(`${KEY} ${SECRET}`);
    });
    await safeError(evaluateWithJev(request(), { apiKey: KEY, fetch }), "gateway-network-error");
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
