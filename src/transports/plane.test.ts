import { describe, expect, test } from "vitest";
import { PlaneReadError } from "../plane-queries.js";
import { planeOrigin, planePage, planeReader } from "./plane.js";

function harness(responses: Array<() => Response>) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const waits: Array<[number, string]> = [];
  let clock = 0;
  const reader = planeReader({
    apiKey: "secret-key",
    workspace: "fixture",
    requestsPerMinute: 2,
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      const next = responses.shift();
      if (!next) throw new Error("unexpected request");
      return next();
    },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    onWait: (ms, reason) => waits.push([ms, reason]),
  });
  return { reader, requests, waits, tick: (ms: number) => (clock += ms) };
}

const json =
  (body: unknown, init: ResponseInit = {}) =>
  () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
      ...init,
    });

describe("planePage", () => {
  test.each([
    [
      { data: [1], next: 20, total_count: 40 },
      { items: [1], next: "offset=20", total: 40 },
    ],
    [
      { data: [1], next: null, total_count: 1 },
      { items: [1], total: 1 },
    ],
    [
      { data: [1], next: "https://api.plane.so/api/v2/x/?offset=40&per_page=20" },
      { items: [1], next: "offset=40" },
    ],
    [
      { results: [1], next_cursor: "100:1:0", next_page_results: true, total_count: 300 },
      { items: [1], next: "cursor=100%3A1%3A0", total: 300 },
    ],
    [{ results: [1], next_cursor: "100:1:0", next_page_results: false }, { items: [1] }],
    [
      { data: [1], meta: { offset: 0, per_page: 1, total: 2 } },
      { items: [1], next: "offset=1", total: 2 },
    ],
    [[1, 2], { items: [1, 2] }],
  ])("normalizes %j", (body, expected) => expect(planePage(body)).toEqual(expected));

  test("rejects an envelope without items", () => {
    expect(() => planePage({ next: 1 })).toThrow(PlaneReadError);
  });
});

describe("planeReader", () => {
  test("sends read-only requests with the key in a header, never the URL", async () => {
    const { reader, requests } = harness([json({ id: "x" }), json({ data: [] })]);
    await reader.workItemByIdentifier("ENG-1");
    await reader.children("00000000-0000-4000-8000-000000000001");
    expect(requests[0].url).toBe(
      "https://api.plane.so/api/v2/workspaces/fixture/work-items/ENG-1/?expand=state",
    );
    expect(requests[1].url).toContain("parent_id=00000000-0000-4000-8000-000000000001");
    for (const request of requests) {
      expect(request.init?.method).toBe("GET");
      expect(request.init?.redirect).toBe("error");
      expect(new Headers(request.init?.headers).get("x-api-key")).toBe("secret-key");
      expect(request.url).not.toContain("secret-key");
    }
    expect(reader.label).toBe("Plane REST API (api.plane.so)");
  });

  test("reads relations from v1 and passes page tokens through", async () => {
    const { reader, requests } = harness([json({ blocking: [] }), json({ data: [] })]);
    await reader.relations("p", "i");
    await reader.links("p", "i", "offset=100");
    expect(requests[0].url).toBe(
      "https://api.plane.so/api/v1/workspaces/fixture/projects/p/work-items/i/relations/",
    );
    expect(requests[1].url).toContain("offset=100");
  });

  test("paces requests to the per-minute budget", async () => {
    const { reader, waits } = harness([json({}), json({}), json({})]);
    await reader.relations("p", "a");
    await reader.relations("p", "b");
    await reader.relations("p", "c");
    expect(waits).toEqual([[60_000, "budget"]]);
  });

  test("honors Retry-After on 429 and then succeeds", async () => {
    const { reader, waits } = harness([
      () => new Response("{}", { status: 429, headers: { "retry-after": "3" } }),
      json({ ok: true }),
    ]);
    await expect(reader.relations("p", "a")).resolves.toEqual({ ok: true });
    expect(waits).toContainEqual([3_000, "rate-limited"]);
  });

  test.each([
    [401, "AUTHENTICATION"],
    [403, "FORBIDDEN"],
    [404, "NOT_FOUND"],
  ])("does not retry HTTP %i", async (status, code) => {
    const { reader, requests } = harness([() => new Response("{}", { status })]);
    await expect(reader.relations("p", "a")).rejects.toThrow(code);
    expect(requests).toHaveLength(1);
  });

  test("counts open work items through the workspace list", async () => {
    const { reader, requests } = harness([json({ data: [{ id: "x" }], next: 1, total_count: 7 })]);
    await expect(reader.countOpen?.("p")).resolves.toBe(7);
    expect(requests[0].url).toContain("state_group__in=triage%2Cbacklog%2Cunstarted%2Cstarted");
  });

  test("requires a key and a valid workspace", () => {
    expect(() => planeReader({ apiKey: "", workspace: "fixture" })).toThrow("PLANE_API_KEY");
    expect(() => planeReader({ apiKey: "k", workspace: "../x" })).toThrow("workspace");
  });
});

describe("planeOrigin", () => {
  test.each([
    ["https://plane.example.com/path", "https://plane.example.com"],
    ["http://localhost:8000", "http://localhost:8000"],
  ])("accepts %s", (input, expected) => expect(planeOrigin(input, "X")).toBe(expected));
  test.each([
    "http://plane.example.com",
    "https://u:p@plane.example.com",
    "not a url",
  ])("rejects %s", (input) => expect(() => planeOrigin(input, "X")).toThrow());
});
