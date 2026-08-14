import { afterEach, describe, expect, test } from "bun:test";
import { GhTransportError } from "../transport.js";
import { httpTransport } from "./http.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Replace fetch with a scripted sequence of responses, recording the calls. */
function scriptFetch(responses: Response[]): { calls: Request[] } {
  const calls: Request[] = [];
  let i = 0;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push(new Request(url, { method: init?.method ?? "GET" }));
    const res = responses[Math.min(i, responses.length - 1)];
    i++;
    return res.clone();
  }) as typeof fetch;
  return { calls };
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const err = (status: number, headers: Record<string, string> = {}) =>
  new Response("nope", { status, headers });

describe("httpTransport", () => {
  test("returns the GraphQL envelope on success", async () => {
    scriptFetch([ok({ data: { repository: null } })]);
    const t = httpTransport({ token: "x" });
    expect(await t.graphql("query{}")).toEqual({ data: { repository: null } });
  });

  test("retries a 500 and succeeds", async () => {
    const { calls } = scriptFetch([err(500), ok({ data: 1 })]);
    const t = httpTransport({ token: "x", maxRetries: 2 });
    expect(await t.graphql("query{}")).toEqual({ data: 1 });
    expect(calls.length).toBe(2);
  });

  test("honors retry-after on a 429", async () => {
    const { calls } = scriptFetch([err(429, { "retry-after": "0" }), ok({ data: 1 })]);
    const t = httpTransport({ token: "x" });
    await t.graphql("query{}");
    expect(calls.length).toBe(2);
  });

  test("throws rather than retrying forever when the reset window is long", async () => {
    const reset = Math.floor(Date.now() / 1000) + 3600;
    scriptFetch([err(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) })]);
    const t = httpTransport({ token: "x", maxBackoffMs: 1000 });
    expect(t.graphql("query{}")).rejects.toThrow(/does not reset/);
  });

  test("a 401 fails immediately, without retries", async () => {
    const { calls } = scriptFetch([err(401)]);
    const t = httpTransport({ token: "bad", maxRetries: 3 });
    await expect(t.graphql("query{}")).rejects.toBeInstanceOf(GhTransportError);
    expect(calls.length).toBe(1);
  });

  test("a GraphQL-level RATE_LIMITED is retried, not returned as data", async () => {
    const { calls } = scriptFetch([ok({ errors: [{ type: "RATE_LIMITED" }] }), ok({ data: 1 })]);
    const t = httpTransport({ token: "x", maxBackoffMs: 1 });
    expect(await t.graphql("query{}")).toEqual({ data: 1 });
    expect(calls.length).toBe(2);
  });

  test("search maps repository_url back to owner/repo", async () => {
    scriptFetch([
      ok({
        items: [
          { number: 7, repository_url: "https://api.github.com/repos/vercel-labs/portless" },
          { number: 8, html_url: "https://github.com/vercel-labs/native/pull/8" },
          { number: 9 }, // unattributable, dropped
        ],
      }),
    ]);
    const t = httpTransport({ token: "x" });
    expect(await t.search("repo:vercel-labs/portless is:open", 10)).toEqual([
      { owner: "vercel-labs", repo: "portless", number: 7 },
      { owner: "vercel-labs", repo: "native", number: 8 },
    ]);
  });

  test("search follows pagination", async () => {
    const first = Array.from({ length: 100 }, (_, index) => ({
      number: index + 1,
      repository_url: "https://api.github.com/repos/o/r",
    }));
    const second = Array.from({ length: 20 }, (_, index) => ({
      number: index + 101,
      repository_url: "https://api.github.com/repos/o/r",
    }));
    const { calls } = scriptFetch([ok({ items: first }), ok({ items: second })]);
    const result = await httpTransport({ token: "x" }).search("repo:o/r is:open", 120);
    expect(result).toHaveLength(120);
    expect(calls[0].url).toContain("page=1");
    expect(calls[1].url).toContain("page=2");
  });

  test("resolves a function token per request", async () => {
    scriptFetch([ok({ data: 1 })]);
    let resolved = 0;
    const t = httpTransport({
      token: () => {
        resolved++;
        return "fresh";
      },
    });
    await t.graphql("query{}");
    expect(resolved).toBe(1);
  });
});
