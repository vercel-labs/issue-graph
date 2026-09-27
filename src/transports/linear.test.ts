import { afterEach, expect, test, vi } from "vitest";
import { issue, workspace } from "../../tests/linear-fixtures.js";
import { LINEAR_CONNECTIONS } from "../linear-queries.js";
import { linearSdkReader } from "./linear.js";

afterEach(() => vi.unstubAllGlobals());

test("the pinned SDK sends only fixed queries, API-key auth, and independent cursors", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    const body = JSON.parse(String(init.body));
    return Response.json({
      data: body.query.includes("IssueGraphWorkspace")
        ? { organization: workspace }
        : { issue: issue(1) },
    });
  });
  const reader = linearSdkReader({ apiKey: "fixture-key" });
  await reader.workspace();
  await reader.issue("ENG-1", { size: 50, cursors: { children: "next" }, include: ["children"] });
  await reader.projectOpenIssues?.("project-id", "count-next");
  await reader.projectIssues?.("project-id", "inventory-next");
  expect(requests).toHaveLength(4);
  for (const { url, init } of requests) {
    expect(url).toBe("https://api.linear.app/graphql");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe("fixture-key");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init.body)).query).toMatch(/^query IssueGraph/);
    expect(JSON.parse(String(init.body)).query).not.toMatch(/\bmutation\b/);
  }
  const second = JSON.parse(String(requests[1].init.body));
  expect(second.query).toContain("title description updatedAt");
  expect(second.variables).toMatchObject({
    children: true,
    relations: false,
    inverseRelations: false,
    attachments: false,
    childrenAfter: "next",
  });
  expect(second.query).toMatch(
    /children\(first: \$size, after: \$childrenAfter, includeArchived: true\)/,
  );
  for (const connection of ["relations", "inverseRelations", "attachments"])
    expect(second.query).toContain(
      `${connection}(first: $size, after: $${connection}After, includeArchived: false)`,
    );
  const count = JSON.parse(String(requests[2].init.body));
  expect(count.variables).toEqual({ id: "project-id", after: "count-next" });
  expect(count.query).toContain("issues(first: 250, after: $after, includeArchived: false");
  expect(count.query).toContain('in: ["triage", "backlog", "unstarted", "started"]');
  expect(count.query).not.toContain("team:");
  const inventory = JSON.parse(String(requests[3].init.body));
  expect(inventory.variables).toEqual({ id: "project-id", after: "inventory-next" });
  expect(inventory.query).toContain("issues(first: 250, after: $after, includeArchived: false");
  expect(inventory.query).toContain("id updatedAt project { id }");
  expect(inventory.query).not.toMatch(/filter:|team:/);
});

test("OAuth and per-request deadlines are applied to the actual SDK", async () => {
  const signals: AbortSignal[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer fixture-oauth");
    signals.push(init.signal as AbortSignal);
    return Response.json({ data: { organization: workspace } });
  });
  const reader = linearSdkReader({ accessToken: "fixture-oauth", timeoutMs: 100 });
  await reader.workspace();
  await reader.workspace();
  expect(signals[0]).not.toBe(signals[1]);
  expect(() => linearSdkReader({})).toThrow("exactly one");
  expect(() => linearSdkReader({ apiKey: "a", accessToken: "b" })).toThrow("exactly one");
});

test.each([
  401, 403, 429, 500,
])("surfaces HTTP%s without exposing upstream content", async (status) => {
  let requests = 0;
  vi.stubGlobal("fetch", async () => {
    requests++;
    return Response.json({ errors: [{ message: "private upstream detail" }] }, { status });
  });
  const reader = linearSdkReader({ apiKey: "fixture-key", maxRetries: 0 });
  await expect(reader.workspace()).rejects.toThrow(
    status === 401
      ? "AUTHENTICATION"
      : status === 403
        ? "FORBIDDEN"
        : status === 429
          ? "RATE_LIMITED"
          : "UPSTREAM",
  );
  expect(requests).toBe(1);
});

test("GraphQL partial data does not become a successful complete read", async () => {
  vi.stubGlobal("fetch", async () =>
    Response.json({ data: { issue: issue(1) }, errors: [{ message: "Incomplete field" }] }),
  );
  await expect(
    linearSdkReader({ apiKey: "fixture-key" }).issue("ENG-1", {
      size: 50,
      cursors: {},
      include: [...LINEAR_CONNECTIONS],
    }),
  ).rejects.toThrow("GRAPHQL_ERROR");
});

test("retries bounded rate limits and respects a retry delay outside its budget", async () => {
  let requests = 0;
  vi.stubGlobal("fetch", async () => {
    requests++;
    return requests === 1
      ? Response.json(
          { errors: [{ message: "Rate limit" }] },
          { status: 429, headers: { "retry-after": "0" } },
        )
      : Response.json({ data: { organization: workspace } });
  });
  await expect(linearSdkReader({ apiKey: "fixture-key" }).workspace()).resolves.toEqual({
    organization: workspace,
  });
  expect(requests).toBe(2);
  vi.stubGlobal("fetch", async () =>
    Response.json({}, { status: 429, headers: { "retry-after": "60" } }),
  );
  await expect(linearSdkReader({ apiKey: "fixture-key" }).workspace()).rejects.toThrow(
    "RATE_LIMITED",
  );
});

test("aborts a stalled SDK request at its deadline", async () => {
  vi.stubGlobal(
    "fetch",
    (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }),
  );
  await expect(
    linearSdkReader({ apiKey: "fixture-key", timeoutMs: 10 }).workspace(),
  ).rejects.toThrow("TIMEOUT");
});

test("stops after the configured retry budget and does not retry authentication failures", async () => {
  let requests = 0;
  vi.stubGlobal("fetch", async () => {
    requests++;
    return Response.json({}, { status: 429, headers: { "retry-after": "0" } });
  });
  await expect(
    linearSdkReader({ apiKey: "fixture-key", maxRetries: 2 }).workspace(),
  ).rejects.toThrow("RATE_LIMITED");
  expect(requests).toBe(3);
  requests = 0;
  vi.stubGlobal("fetch", async () => {
    requests++;
    return Response.json({}, { status: 401 });
  });
  await expect(
    linearSdkReader({ apiKey: "fixture-key", maxRetries: 2 }).workspace(),
  ).rejects.toThrow("AUTHENTICATION");
  expect(requests).toBe(1);
});
