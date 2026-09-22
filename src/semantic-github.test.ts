import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";
import {
  comment,
  connection,
  envelope,
  fixture,
  issue,
  record,
  repoData,
} from "../tests/semantic-github-fixture.js";
import { buildEvaluationInput, fingerprintInput } from "./semantic.js";
import {
  collectSemanticEvidence,
  revalidateSemanticEvidence,
  revalidateSemanticEvidenceBatch,
} from "./semantic-github.js";
import type { SemanticCapture } from "./semantic-types.js";
import { SemanticError } from "./semantic-types.js";
import type { GhTransport } from "./transport.js";

const TIME = "2026-09-20T00:00:00Z";
const EDITED = "2026-09-20T01:00:00Z";
const SECRET = "upstream-secret-body-token";
const OPTIONS = { repo: "o/r", limit: 50, now: () => TIME };

function first(response: unknown): Record<string, unknown> {
  return (record(repoData(response).issues).nodes as Record<string, unknown>[])[0];
}

function alias(response: unknown): Record<string, unknown> {
  return record(repoData(response).i0);
}

async function expectSafeFailure(promise: Promise<unknown>, code: string) {
  const failure = await promise.catch((cause: unknown) => cause);
  expect(failure).toBeInstanceOf(SemanticError);
  expect(failure).toMatchObject({ code });
  expect(String(failure)).not.toContain(SECRET);
  expect(JSON.stringify(failure)).not.toContain(SECRET);
}

describe("collectSemanticEvidence", () => {
  test("captures more than 100 issues and comments with stable independent cursors", async () => {
    const { transport, calls } = fixture(105, { comments: { 1: 101 } });
    const onProgress = vi.fn();
    const result = await collectSemanticEvidence(transport, { ...OPTIONS, limit: 500, onProgress });
    expect(result.coverage).toEqual({
      captured: 105,
      total: 105,
      hasNextPage: false,
      pages: 6,
      complete: true,
      reasonCodes: [],
    });
    expect(result.items).toHaveLength(105);
    expect(result.items.every((item) => item.status === "ready")).toBe(true);
    expect(result.items[0]).toMatchObject({
      key: "o/r#1",
      url: "https://github.com/o/r/issues/1",
      commentsCoverage: { captured: 101, total: 101, hasNextPage: false, pages: 2, complete: true },
      captureWindow: { startedAt: TIME, completedAt: TIME },
    });
    expect(result.items[0]?.comments[1]?.author).toBeNull();
    expect(result.items[0]?.comments[0]?.author).toBe("alice");
    expect(result.captureWindow).toEqual({ startedAt: TIME, completedAt: TIME });
    expect(calls[0]?.operation).toBe("Repository");
    expect(calls.at(-1)?.operation).toBe("Repository");
    for (const call of calls.filter((call) => call.operation === "Issues")) {
      expect(call.query).toContain("states: OPEN, first: 20, after: $after");
      expect(call.query).toContain("orderBy: {field: CREATED_AT, direction: ASC}");
      expect(call.query).toContain("comments(first: 10)");
    }
    expect(
      calls.filter((call) => call.operation === "Issues").map((call) => call.variables.after),
    ).toEqual([undefined, "20", "40", "60", "80", "100"]);
    expect(
      calls
        .filter((call) => call.operation === "Bodies" && call.variables.number0 === 1)
        .map((call) => call.variables.after0),
    ).toEqual(["10"]);
    expect(onProgress.mock.calls).toEqual([
      [{ captured: 20, pages: 1 }],
      [{ captured: 40, pages: 2 }],
      [{ captured: 60, pages: 3 }],
      [{ captured: 80, pages: 4 }],
      [{ captured: 100, pages: 5 }],
      [{ captured: 105, pages: 6 }],
    ]);
    expect(transport.search).not.toHaveBeenCalled();
    for (const call of calls) {
      expect(call.query).not.toMatch(/\b(search|mutation|issueOrPullRequest)\b/);
      if (call.operation === "Repository" || call.operation === "Versions") {
        expect(call.query).not.toContain("body");
      }
    }
  });

  test.each([
    75, 100, 105,
  ])("the CLI default limit 50 is explicitly partial for %i issues", async (total) => {
    const { transport, calls } = fixture(total);
    const result = await collectSemanticEvidence(transport, OPTIONS);
    expect(result.coverage).toMatchObject({
      captured: 50,
      total,
      hasNextPage: true,
      pages: 3,
      complete: false,
    });
    expect(result.coverage.reasonCodes).toEqual(["issue-limit"]);
    expect(result.items.at(-1)?.number).toBe(50);
    expect(calls.filter((call) => call.operation === "Bodies")).toHaveLength(0);
    expect(result.items.every((item) => item.commentsCoverage.complete)).toBe(true);
  });

  test.each([1, 100, 500])("an exact limit of %i can be complete", async (limit) => {
    const { transport } = fixture(limit);
    const result = await collectSemanticEvidence(transport, { ...OPTIONS, limit });
    expect(result.coverage).toMatchObject({ captured: limit, complete: true, reasonCodes: [] });
  });

  test.each([
    0,
    -1,
    501,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])("rejects invalid limit %s before I/O", async (limit) => {
    const { transport } = fixture();
    await expectSafeFailure(
      collectSemanticEvidence(transport, { ...OPTIONS, limit }),
      "invalid-capture-options",
    );
    expect(transport.graphql).not.toHaveBeenCalled();
  });

  test.each([
    "",
    "o",
    "o/r/x",
    "o/..",
    "o/.",
    "o/r?x",
    "o/r#1",
    "https://github.com/o/r",
    "o/r\n",
    "-o/r",
    `o/${SECRET}/r`,
  ])("rejects malformed repository %s before I/O", async (repo) => {
    const { transport } = fixture();
    await expectSafeFailure(
      collectSemanticEvidence(transport, { ...OPTIONS, repo }),
      "invalid-capture-options",
    );
    expect(transport.graphql).not.toHaveBeenCalled();
  });

  test.each([
    { visibility: "PRIVATE", isPrivate: true },
    { visibility: "INTERNAL", isPrivate: false },
    { visibility: "UNKNOWN", isPrivate: false },
    { visibility: "PUBLIC", isPrivate: true },
    { visibility: undefined, isPrivate: false },
    { visibility: "PUBLIC", isPrivate: undefined },
    { visibility: "PUBLIC", isPrivate: "false" },
  ])("blocks non-public or ambiguous visibility before body queries: %j", async (visibility) => {
    const { transport, calls } = fixture(2, { respond: () => envelope({ ...visibility }) });
    await expectSafeFailure(collectSemanticEvidence(transport, OPTIONS), "repository-not-public");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.query).not.toContain("body");
  });

  test.each([
    2, 3,
  ])("fails closed when repository metadata check %i loses visibility", async (ordinal) => {
    const { transport } = fixture(2, {
      respond: (call, response) =>
        call.operation === "Repository" && call.ordinal === ordinal
          ? envelope({ visibility: "PRIVATE", isPrivate: true })
          : response,
    });
    await expectSafeFailure(collectSemanticEvidence(transport, OPTIONS), "repository-not-public");
  });

  test.each([
    "Issues",
    "Versions",
    "Bodies",
  ] as const)("fails closed on unknown visibility in %s responses", async (operation) => {
    const { transport } = fixture(2, {
      comments: { 1: 11 },
      respond: (call, response) => {
        if (call.operation === operation) repoData(response).visibility = null;
        return response;
      },
    });
    await expectSafeFailure(collectSemanticEvidence(transport, OPTIONS), "repository-not-public");
  });

  test("distinguishes a truly empty census from a GraphQL failure", async () => {
    const empty = await collectSemanticEvidence(fixture(0).transport, OPTIONS);
    expect(empty.items).toEqual([]);
    expect(empty.coverage).toEqual({
      captured: 0,
      total: 0,
      hasNextPage: false,
      pages: 1,
      complete: true,
      reasonCodes: [],
    });
    const { transport } = fixture(0, {
      respond: (call, response) =>
        call.operation === "Issues"
          ? { ...record(response), errors: [{ message: SECRET }] }
          : response,
    });
    const failed = await collectSemanticEvidence(transport, OPTIONS);
    expect(failed.coverage).toMatchObject({
      captured: 0,
      complete: false,
      hasNextPage: null,
      reasonCodes: ["github-graphql-error"],
    });
    expect(JSON.stringify(failed)).not.toContain(SECRET);
  });

  test.each([
    "throw",
    "graphql",
    "malformed",
  ])("sanitizes initial metadata %s failures", async (mode) => {
    const { transport } = fixture(2, {
      respond: () => {
        if (mode === "throw") throw new Error(SECRET);
        return mode === "graphql" ? { errors: [{ message: SECRET }] } : { data: SECRET };
      },
    });
    await expectSafeFailure(
      collectSemanticEvidence(transport, OPTIONS),
      mode === "throw"
        ? "github-read-failed"
        : mode === "graphql"
          ? "github-graphql-error"
          : "malformed-response",
    );
  });

  test("final census failure is fatal and sanitized", async () => {
    const { transport } = fixture(1, {
      respond: (call, response) => {
        if (call.operation === "Repository" && call.ordinal === 3) throw new Error(SECRET);
        return response;
      },
    });
    await expectSafeFailure(collectSemanticEvidence(transport, OPTIONS), "github-read-failed");
  });

  test("detects repeated issue cursors without looping", async () => {
    const { transport, calls } = fixture(250, {
      respond: (call, response) => {
        if (call.operation === "Issues" && call.ordinal === 2) {
          record(record(repoData(response).issues).pageInfo).endCursor = "20";
        }
        return response;
      },
    });
    const result = await collectSemanticEvidence(transport, { ...OPTIONS, limit: 500 });
    expect(result.coverage).toMatchObject({ captured: 40, complete: false });
    expect(result.coverage.reasonCodes).toContain("repeated-cursor");
    expect(calls.filter((call) => call.operation === "Issues")).toHaveLength(2);
  });

  test.each(["id", "number"])("detects duplicate issue %s across pages", async (field) => {
    const { transport } = fixture(101, {
      respond: (call, response) => {
        if (call.operation === "Issues" && call.ordinal === 2) {
          const nodes = record(repoData(response).issues).nodes as Record<string, unknown>[];
          const first = nodes[0];
          if (first) first[field] = field === "id" ? "I_1" : 1;
        }
        return response;
      },
    });
    const result = await collectSemanticEvidence(transport, { ...OPTIONS, limit: 500 });
    expect(result.coverage.captured).toBe(39);
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.reasonCodes).toContain("duplicate-issue");
  });

  test.each(["page", "before-comments", "final"])("detects census drift at %s", async (phase) => {
    const { transport } = fixture(2, {
      respond: (call, response) => {
        if (
          (phase === "page" && call.operation === "Issues") ||
          (call.operation === "Repository" &&
            call.ordinal === (phase === "before-comments" ? 2 : phase === "final" ? 3 : 0))
        ) {
          record(repoData(response).issues).totalCount = 3;
        }
        return response;
      },
    });
    const result = await collectSemanticEvidence(transport, OPTIONS);
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.reasonCodes).toContain("total-count-drift");
    expect(result.items).toHaveLength(2);
  });

  test.each([
    "Issues",
    "Bodies",
    "Versions",
  ] as const)("preserves closure receipt at %s", async (operation) => {
    const { transport, calls } = fixture(2, {
      comments: { 1: 11 },
      respond: (call, response) => {
        if (call.operation === operation)
          (operation === "Issues" ? first(response) : alias(response)).state = "CLOSED";
        return response;
      },
    });
    const result = await collectSemanticEvidence(transport, OPTIONS);
    expect(result.items[0]).toMatchObject({
      id: "I_1",
      state: "CLOSED",
      status: "excluded",
      reasonCodes: ["state-changed"],
    });
    expect(result.items[1]?.status).toBe("ready");
    expect(result.coverage.complete).toBe(false);
    if (operation === "Issues")
      expect(calls.some((call) => call.operation === "Bodies")).toBe(false);
  });

  test.each([
    "first-continuation",
    "second-continuation",
    "final",
  ])("excludes edits at %s preserving captured evidence", async (phase) => {
    const { transport } = fixture(2, {
      comments: { 1: 150 },
      respond: (call, response) => {
        if (
          (call.operation === "Bodies" &&
            call.ordinal ===
              (phase === "first-continuation" ? 1 : phase === "second-continuation" ? 2 : 0)) ||
          (phase === "final" && call.operation === "Versions")
        )
          alias(response).updatedAt = EDITED;
        return response;
      },
    });
    const result = await collectSemanticEvidence(transport, OPTIONS);
    expect(result.items[0]).toMatchObject({
      updatedAt: TIME,
      status: "excluded",
      reasonCodes: ["needs-refresh"],
    });
    expect(result.items[1]?.status).toBe("ready");
    expect(result.coverage.complete).toBe(false);
  });

  test.each([
    "Versions",
    "Bodies",
  ] as const)("identity mismatch during %s fails only that item", async (operation) => {
    const { transport } = fixture(2, {
      comments: { 1: 11 },
      respond: (call, response) => {
        if (call.operation === operation && call.variables.number0 === 1)
          alias(response).id = "OTHER";
        return response;
      },
    });
    const result = await collectSemanticEvidence(transport, OPTIONS);
    expect(result.items[0]).toMatchObject({
      status: "failed",
      reasonCodes: ["issue-identity-unverified"],
    });
    expect(result.items[1]?.status).toBe("ready");
  });

  test.each([
    "Versions",
    "Bodies",
  ] as const)("retains other batches after a sanitized %s request failure", async (operation) => {
    const { transport } = fixture(21, {
      comments: { 1: 11 },
      respond: (call, response) => {
        if (call.operation === operation && call.variables.number0 === 1) throw new Error(SECRET);
        return response;
      },
    });
    const result = await collectSemanticEvidence(transport, OPTIONS);
    expect(result.items[0]?.status).toBe("failed");
    expect(result.items[20]?.status).toBe("ready");
    expect(result.coverage.complete).toBe(false);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  test.each([300, 301, 405])("caps %i comments at 10/100/100/90", async (total) => {
    const { transport, calls } = fixture(1, { comments: { 1: total } });
    const result = await collectSemanticEvidence(transport, OPTIONS);
    expect(result.items[0]?.commentsCoverage).toEqual({
      captured: 300,
      total,
      pages: 4,
      hasNextPage: total > 300,
      complete: total === 300,
      reasonCodes: total > 300 ? ["comments-page-limit"] : [],
    });
    expect(result.coverage.complete).toBe(total === 300);
    const requests = calls.filter((call) => call.operation === "Bodies");
    expect(requests).toHaveLength(3);
    expect(requests.map((call) => call.variables.first0)).toEqual([100, 100, 90]);
    expect(requests.map((call) => call.variables.after0)).toEqual(["10", "110", "210"]);
  });

  test.each([
    "duplicate",
    "cursor",
    "drift",
    "failure",
  ])("preserves earlier comment evidence after %s", async (mode) => {
    const { transport } = fixture(1, {
      comments: { 1: 250 },
      respond: (call, response) => {
        if (call.operation === "Bodies" && call.ordinal === 2) {
          const comments = record(alias(response).comments);
          if (mode === "failure") return { errors: [{ message: SECRET }] };
          if (mode === "duplicate") (comments.nodes as unknown[])[0] = comment(1, 1);
          if (mode === "cursor") record(comments.pageInfo).endCursor = "110";
          if (mode === "drift") comments.totalCount = 251;
        }
        return response;
      },
    });
    const result = await collectSemanticEvidence(transport, OPTIONS);
    expect(result.items[0]?.comments.length).toBeGreaterThanOrEqual(100);
    expect(result.items[0]?.commentsCoverage.complete).toBe(false);
    expect(result.items[0]?.commentsCoverage.reasonCodes).toContain(
      {
        duplicate: "duplicate-comment",
        cursor: "repeated-cursor",
        drift: "total-count-drift",
        failure: "github-graphql-error",
      }[mode],
    );
    expect(result.coverage.complete).toBe(false);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  test.each([
    null,
    { totalCount: 0, nodes: [], pageInfo: null },
    connection([], 3, true, null),
    connection([], 3, true, "next"),
    connection([issue(1)], -1),
    connection([issue(1)], "1" as unknown as number),
    connection(
      Array.from({ length: 21 }, (_, index) => issue(index + 1)),
      21,
    ),
    { totalCount: 2, nodes: {}, pageInfo: { hasNextPage: false, endCursor: null } },
    { totalCount: 2, nodes: [], pageInfo: { hasNextPage: "false", endCursor: null } },
  ])("malformed issue pages are not a complete empty census: %j", async (issues) => {
    const { transport } = fixture(2, {
      respond: (call, response) => (call.operation === "Issues" ? envelope({ issues }) : response),
    });
    const result = await collectSemanticEvidence(transport, OPTIONS);
    expect(result.coverage).toMatchObject({ complete: false, hasNextPage: null });
    expect(result.coverage.reasonCodes).toContain("malformed-page");
  });

  test.each([
    null,
    {},
    { ...issue(1), __typename: "PullRequest" },
    { ...issue(1), number: 1.5 },
    { ...issue(1), body: null },
    { ...issue(1), updatedAt: SECRET },
  ])("malformed issue nodes retain healthy siblings: %j", async (bad) => {
    const { transport } = fixture(2, {
      respond: (call, response) =>
        call.operation === "Issues"
          ? envelope({ issues: connection([bad, issue(2)], 2) })
          : response,
    });
    const result = await collectSemanticEvidence(transport, OPTIONS);
    expect(result.items.map((item) => item.number)).toEqual([2]);
    expect(result.coverage.reasonCodes).toContain("malformed-issue");
    expect(result.coverage.complete).toBe(false);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  test.each([
    null,
    { ...comment(1, 1), author: {} },
    { ...comment(1, 1), url: "https://evil.test/issuecomment-1" },
    { ...comment(1, 1), url: "https://github.com/o/r/issues/2#issuecomment-1" },
    { ...comment(1, 1), updatedAt: null },
    { ...comment(1, 1), body: {} },
    { ...comment(1, 1), __typename: "Issue" },
  ])("malformed comments fail the item without leaking rejected fields: %j", async (bad) => {
    const { transport } = fixture(2, {
      respond: (call, response) => {
        if (call.operation === "Issues") first(response).comments = connection([bad], 1);
        return response;
      },
    });
    const result = await collectSemanticEvidence(transport, OPTIONS);
    expect(result.items[0]).toMatchObject({
      status: "failed",
      comments: [],
      commentsCoverage: { complete: false },
    });
    expect(result.items[1]?.status).toBe("ready");
  });

  test.each([
    null,
    { visibility: "PRIVATE", isPrivate: true },
    { isPrivate: false },
  ])("partial GraphQL errors cannot hide revoked visibility: %j", async (repository) => {
    const { transport } = fixture(1, {
      respond: (call, response) =>
        call.operation === "Versions"
          ? { data: { repository }, errors: [{ message: SECRET }] }
          : response,
    });
    await expectSafeFailure(collectSemanticEvidence(transport, OPTIONS), "repository-not-public");
  });

  test.each([
    null,
    [],
    { data: null },
    { errors: SECRET },
    { data: {}, errors: [] },
  ])("rejects malformed initial envelopes without exposing content: %j", async (response) => {
    const { transport, calls } = fixture(1, { respond: () => response });
    await expectSafeFailure(
      collectSemanticEvidence(transport, OPTIONS),
      response !== null && !Array.isArray(response) && "data" in response && response.data !== null
        ? "repository-not-public"
        : "malformed-response",
    );
    expect(calls).toHaveLength(1);
  });

  test("a failed later issue page preserves selected evidence and unknown continuation", async () => {
    const { transport } = fixture(101, {
      respond: (call, response) => {
        if (call.operation === "Issues" && call.ordinal === 2) throw new Error(SECRET);
        return response;
      },
    });
    const result = await collectSemanticEvidence(transport, { ...OPTIONS, limit: 500 });
    expect(result.coverage).toMatchObject({
      captured: 20,
      total: 101,
      pages: 2,
      hasNextPage: null,
      complete: false,
      reasonCodes: ["github-read-failed"],
    });
    expect(result.items.every((item) => item.status === "ready")).toBe(true);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  test("detects an edit between comment pages and preserves earlier comments", async () => {
    const { transport } = fixture(1, {
      comments: { 1: 150 },
      respond: (call, response) => {
        if (call.operation === "Bodies" && call.ordinal === 2) {
          alias(response).updatedAt = EDITED;
        }
        return response;
      },
    });
    const result = await collectSemanticEvidence(transport, OPTIONS);
    expect(result.items[0]).toMatchObject({ status: "excluded", reasonCodes: ["needs-refresh"] });
    expect(result.items[0]?.comments).toHaveLength(110);
    expect(result.items[0]?.commentsCoverage).toMatchObject({
      captured: 110,
      total: 150,
      hasNextPage: true,
      complete: false,
    });
  });

  test("malformed comment connections fail only the affected item", async () => {
    const { transport } = fixture(2, {
      respond: (call, response) => {
        if (call.operation === "Issues") {
          first(response).comments = { nodes: [] };
        }
        return response;
      },
    });
    const result = await collectSemanticEvidence(transport, OPTIONS);
    expect(result.items[0]).toMatchObject({ status: "failed", reasonCodes: ["malformed-page"] });
    expect(result.items[1]?.status).toBe("ready");
    expect(result.coverage.complete).toBe(false);
  });

  test("canonicalizes comment URLs for case-insensitive GitHub repository names", async () => {
    const { transport } = fixture(1, {
      comments: { 1: 1 },
      respond: (call, response) => {
        if (call.operation === "Issues" || call.operation === "Versions") {
          record((call.operation === "Issues" ? first(response) : alias(response)).comments).nodes =
            [{ ...comment(1, 1), url: "https://github.com/O/R/issues/1#issuecomment-1" }];
        }
        return response;
      },
    });
    const result = await collectSemanticEvidence(transport, OPTIONS);
    expect(result.items[0]?.comments[0]?.url).toBe(
      "https://github.com/o/r/issues/1#issuecomment-1",
    );
    expect(result.coverage.complete).toBe(true);
  });

  test("records injected capture start and completion times", async () => {
    const now = vi.fn().mockReturnValueOnce(TIME).mockReturnValue(EDITED);
    const result = await collectSemanticEvidence(fixture(1).transport, { ...OPTIONS, now });
    expect(result.captureWindow).toEqual({ startedAt: TIME, completedAt: EDITED });
    expect(result.items[0]?.captureWindow).toEqual({ startedAt: TIME, completedAt: EDITED });
  });

  test("constructs canonical issue identity rather than trusting upstream URL", async () => {
    const { transport } = fixture(1, {
      respond: (call, response) => {
        if (call.operation === "Issues") {
          record(repoData(response).issues).nodes = [
            { ...issue(1), url: "https://evil.test", key: "evil/repo#2" },
          ];
        }
        return response;
      },
    });
    const result = await collectSemanticEvidence(transport, OPTIONS);
    expect(result.items[0]).toMatchObject({ key: "o/r#1", url: "https://github.com/o/r/issues/1" });
    expect(JSON.stringify(result)).not.toContain("evil");
  });
});

function mutateIssue(response: unknown, change: (node: Record<string, unknown>) => void) {
  const repo = repoData(response);
  const nodes =
    repo.issues && "nodes" in record(repo.issues)
      ? (record(repo.issues).nodes as Record<string, unknown>[])
      : Object.entries(repo)
          .filter(([key]) => /^i\d+$/.test(key))
          .map(([, value]) => record(value));
  for (const node of nodes) if (node.number === 1) change(node);
  return response;
}

async function saved(total = 2, count = 1) {
  return collectSemanticEvidence(fixture(total, { comments: { 1: count } }).transport, OPTIONS);
}

const changes: Record<string, (node: Record<string, unknown>) => void> = {
  "comment-only edit": (node) => {
    const c = record((record(node.comments).nodes as unknown[])[0]);
    c.updatedAt = EDITED;
    if ("body" in c) c.body = "Edited comment";
  },
  addition: (node) => {
    const c = record(node.comments);
    (c.nodes as unknown[]).push(comment(1, 2));
    c.totalCount = 2;
  },
  removal: (node) => {
    node.comments = connection([], 0);
  },
  author: (node) => {
    record((record(node.comments).nodes as unknown[])[0]).author = { login: "bob" };
  },
  url: (node) => {
    record((record(node.comments).nodes as unknown[])[0]).url = comment(1, 9).url;
  },
  id: (node) => {
    record((record(node.comments).nodes as unknown[])[0]).id = "C_NEW";
  },
  title: (node) => {
    node.title = "Changed title";
  },
  "parent edit": (node) => {
    node.updatedAt = EDITED;
    if ("body" in node) node.body = "Changed body";
  },
};

describe("evidence reuse", () => {
  test("76 low-comment items cost exactly 11 queries cold and warm, four to revalidate", async () => {
    const comments = Object.fromEntries(Array.from({ length: 76 }, (_, i) => [i + 1, i % 11]));
    const cold = fixture(76, { comments });
    const capture = await collectSemanticEvidence(cold.transport, { ...OPTIONS, limit: 100 });
    expect(capture.coverage.complete).toBe(true);
    expect(cold.calls).toHaveLength(11);
    const warm = fixture(76, { comments });
    const onEvidenceReuse = vi.fn();
    const reused = await collectSemanticEvidence(warm.transport, {
      ...OPTIONS,
      limit: 100,
      previousCapture: capture,
      onEvidenceReuse,
      now: () => EDITED,
    });
    expect(warm.calls).toHaveLength(11);
    expect(warm.calls.every((call) => !/\bbody\b/.test(call.query))).toBe(true);
    expect(onEvidenceReuse.mock.calls).toEqual(capture.items.map((item) => [item.key]));
    expect(reused.coverage.complete).toBe(true);
    for (let i = 0; i < capture.items.length; i++) {
      expect(reused.items[i].reasonCodes).toEqual([]);
      expect(reused.items[i].captureWindow).toEqual({ startedAt: EDITED, completedAt: EDITED });
      expect(buildEvaluationInput(reused.items[i], null)).toEqual(
        buildEvaluationInput(capture.items[i], null),
      );
    }
    const check = fixture(76, { comments });
    const result = await revalidateSemanticEvidenceBatch(check.transport, "o/r", capture.items);
    expect(check.calls).toHaveLength(4);
    expect([...result.values()]).toEqual(Array(76).fill("current"));
    for (const call of [...cold.calls, ...warm.calls, ...check.calls]) {
      expect(call.query).toContain("nameWithOwner visibility isPrivate");
      expect(call.variables).toMatchObject({ owner: "o", repo: "r" });
      expect(call.query).not.toContain('"o"');
      expect([...call.query.matchAll(/i\d+: issue/g)].length).toBeLessThanOrEqual(20);
    }
  });

  test.each(Object.keys(changes))("%s refetches only affected full evidence", async (name) => {
    const capture = await saved();
    const original = structuredClone(capture);
    const options = {
      comments: { 1: 1 },
      respond: (_call: unknown, response: unknown) => mutateIssue(response, changes[name]),
    };
    const checked = await revalidateSemanticEvidenceBatch(
      fixture(2, options).transport,
      "o/r",
      capture.items,
    );
    expect([...checked]).toEqual([
      ["o/r#1", "needs-refresh"],
      ["o/r#2", "current"],
    ]);
    const warm = fixture(2, options);
    const onEvidenceReuse = vi.fn();
    const result = await collectSemanticEvidence(warm.transport, {
      ...OPTIONS,
      previousCapture: capture,
      onEvidenceReuse,
    });
    expect(result.coverage.complete).toBe(true);
    expect(
      warm.calls.filter((c) => c.operation === "Bodies").map((c) => c.variables.number0),
    ).toEqual([1]);
    expect(onEvidenceReuse.mock.calls).toEqual([["o/r#2"]]);
    expect(capture).toEqual(original);
    const fresh = await collectSemanticEvidence(fixture(2, options).transport, OPTIONS);
    expect(buildEvaluationInput(result.items[0], null)).toEqual(
      buildEvaluationInput(fresh.items[0], null),
    );
    expect(await fingerprintInput(buildEvaluationInput(result.items[0], null), null)).not.toBe(
      await fingerprintInput(buildEvaluationInput(capture.items[0], null), null),
    );
  });

  test("old 3x100 page counts do not affect reuse or input hash", async () => {
    const capture = await saved(1, 300);
    capture.items[0].commentsCoverage.pages = 3;
    const hash = await fingerprintInput(buildEvaluationInput(capture.items[0], null), null);
    const { transport, calls } = fixture(1, { comments: { 1: 300 } });
    const onEvidenceReuse = vi.fn();
    const result = await collectSemanticEvidence(transport, {
      ...OPTIONS,
      previousCapture: capture,
      onEvidenceReuse,
    });
    expect(result.items[0].commentsCoverage.pages).toBe(4);
    expect(onEvidenceReuse).toHaveBeenCalledExactlyOnceWith("o/r#1");
    expect(calls.every((c) => !/\bbody\b/.test(c.query))).toBe(true);
    expect(await fingerprintInput(buildEvaluationInput(result.items[0], null), null)).toBe(hash);
  });

  test("ready item in a partial snapshot is reusable but incomplete siblings are not", async () => {
    const capture = await saved(2, 301);
    const onEvidenceReuse = vi.fn();
    const { transport, calls } = fixture(2, { comments: { 1: 301 } });
    const result = await collectSemanticEvidence(transport, {
      ...OPTIONS,
      previousCapture: capture,
      onEvidenceReuse,
    });
    expect(result.coverage.complete).toBe(false);
    expect(onEvidenceReuse.mock.calls).toEqual([["o/r#2"]]);
    expect(calls.filter((c) => c.operation === "Bodies")).toHaveLength(4);
    expect(result.items[0].commentsCoverage).toMatchObject({
      captured: 300,
      total: 301,
      complete: false,
    });
  });
});

describe("stored evidence is not freshness proof", () => {
  test.each([
    "wrong-repo",
    "private",
    "null",
    "missing-items",
    "duplicate-item",
    "bad-key",
    "bad-url",
    "bad-body",
    "bad-comment",
    "duplicate-comment",
    "bad-window",
    "bad-coverage",
    "excluded",
    "failed",
    "reasons",
  ])("invalid old capture %s cannot supply bodies", async (mode) => {
    const capture = await saved(1);
    const item = capture.items[0];
    let previous: unknown = capture;
    if (mode === "wrong-repo") capture.repo = "other/repo";
    if (mode === "private") record(capture).visibility = "PRIVATE";
    if (mode === "null") previous = null;
    if (mode === "missing-items") record(capture).items = null;
    if (mode === "duplicate-item") {
      capture.items.push(item);
      capture.coverage.captured = 2;
    }
    if (mode === "bad-key") record(item).key = "other/repo#1";
    if (mode === "bad-url") item.url = "https://evil.test";
    if (mode === "bad-body") record(item).body = null;
    if (mode === "bad-comment") record(item.comments[0]).updatedAt = "invalid";
    if (mode === "duplicate-comment") {
      item.comments.push(item.comments[0]);
      item.commentsCoverage.captured = 2;
      item.commentsCoverage.total = 2;
    }
    if (mode === "bad-window") item.captureWindow.completedAt = "invalid";
    if (mode === "bad-coverage") item.commentsCoverage.captured = 99;
    if (mode === "excluded" || mode === "failed") item.status = mode;
    if (mode === "reasons") item.reasonCodes = ["needs-refresh"];
    const onEvidenceReuse = vi.fn();
    const { transport, calls } = fixture(1, { comments: { 1: 1 } });
    const result = await collectSemanticEvidence(transport, {
      ...OPTIONS,
      previousCapture: previous as SemanticCapture,
      onEvidenceReuse,
    });
    expect(onEvidenceReuse).not.toHaveBeenCalled();
    expect(result.coverage.complete).toBe(true);
    expect(result.items[0].body).toBe(issue(1).body);
    expect(calls.find((c) => c.operation === "Issues")?.query).toMatch(/\bbody\b/);
  });

  test.each([
    "Issues",
    "Versions",
    "Bodies",
  ] as const)("fresh %s errors never fall back to stored bodies", async (operation) => {
    const capture = await saved();
    const onEvidenceReuse = vi.fn();
    const { transport } = fixture(2, {
      comments: { 1: 1 },
      respond: (call, response) => {
        if (call.operation === operation) throw new Error(SECRET);
        return mutateIssue(response, changes.title);
      },
    });
    const result = await collectSemanticEvidence(transport, {
      ...OPTIONS,
      previousCapture: capture,
      onEvidenceReuse,
    });
    expect(result.coverage.complete).toBe(false);
    expect(result.items.find((i) => i.number === 1)?.status).not.toBe("ready");
    expect(onEvidenceReuse.mock.calls.flat()).not.toContain("o/r#1");
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  test("comment edits during final verification suppress reuse callbacks", async () => {
    const capture = await saved(1);
    const onEvidenceReuse = vi.fn();
    const { transport } = fixture(1, {
      comments: { 1: 1 },
      respond: (call, response) =>
        call.operation === "Versions"
          ? mutateIssue(response, changes["comment-only edit"])
          : response,
    });
    const result = await collectSemanticEvidence(transport, {
      ...OPTIONS,
      previousCapture: capture,
      onEvidenceReuse,
    });
    expect(result.items[0]).toMatchObject({ status: "excluded", reasonCodes: ["needs-refresh"] });
    expect(onEvidenceReuse).not.toHaveBeenCalled();
  });

  test("comment ordering changes invalidate reuse", async () => {
    const capture = await saved(1, 2);
    const { transport } = fixture(1, {
      comments: { 1: 2 },
      respond: (_call, response) =>
        mutateIssue(response, (node) => {
          (record(node.comments).nodes as unknown[]).reverse();
        }),
    });
    expect(await revalidateSemanticEvidence(transport, "o/r", capture.items[0])).toBe(
      "needs-refresh",
    );
  });

  test.each([
    10, 11, 100, 101, 110, 111, 210, 211,
  ])("comment boundary %i is complete without loss", async (total) => {
    const { transport, calls } = fixture(1, { comments: { 1: total } });
    const result = await collectSemanticEvidence(transport, OPTIONS);
    const pages = total <= 10 ? 1 : total <= 110 ? 2 : total <= 210 ? 3 : 4;
    expect(result.items[0].commentsCoverage).toEqual({
      captured: total,
      total,
      pages,
      hasNextPage: false,
      complete: true,
      reasonCodes: [],
    });
    expect(result.coverage.complete).toBe(true);
    expect(calls.filter((c) => c.operation === "Bodies").map((c) => c.variables.first0)).toEqual(
      [100, 100, 90].slice(0, pages - 1),
    );
    expect(result.items[0].comments.map((c) => c.id)).toEqual(
      Array.from({ length: total }, (_, i) => `C_1_${i + 1}`),
    );
  });
});

describe("batch revalidation fail-closed boundary", () => {
  test.each([
    "missing",
    "null",
    "wrong-id",
    "wrong-number",
    "pull-request",
    "bad-date",
    "missing-title",
  ])("rejects %s alias even if another is current", async (mode) => {
    const capture = await saved();
    const { transport } = fixture(2, {
      respond: (_call, response) => {
        const node = record(repoData(response).i1);
        if (mode === "missing") delete repoData(response).i1;
        if (mode === "null") repoData(response).i1 = null;
        if (mode === "wrong-id") node.id = "OTHER";
        if (mode === "wrong-number") node.number = 5;
        if (mode === "pull-request") node.__typename = "PullRequest";
        if (mode === "bad-date") node.updatedAt = "invalid";
        if (mode === "missing-title") delete node.title;
        return response;
      },
    });
    await expectSafeFailure(
      revalidateSemanticEvidenceBatch(transport, "o/r", capture.items),
      mode === "missing-title" ? "malformed-issue" : "issue-identity-unverified",
    );
  });

  test.each([
    "private",
    "repo",
    "missing-repo",
    "empty",
    "malformed",
    "error",
    "throw",
  ])("rejects %s response", async (mode) => {
    const capture = await saved();
    const { transport } = fixture(2, {
      respond: (_call, response) => {
        if (mode === "private") repoData(response).isPrivate = true;
        if (mode === "repo") repoData(response).nameWithOwner = "other/repo";
        if (mode === "missing-repo") delete repoData(response).nameWithOwner;
        if (mode === "empty") return {};
        if (mode === "malformed") return null;
        if (mode === "error") return { errors: [{ message: SECRET }] };
        if (mode === "throw") throw new Error(SECRET);
        return response;
      },
    });
    await expectSafeFailure(
      revalidateSemanticEvidenceBatch(transport, "o/r", capture.items),
      mode === "private"
        ? "repository-not-public"
        : mode === "repo" || mode === "missing-repo"
          ? "repository-identity-unverified"
          : mode === "error"
            ? "github-graphql-error"
            : mode === "throw"
              ? "github-read-failed"
              : "malformed-response",
    );
  });

  test.each([
    "duplicate-id",
    "duplicate-url",
    "cursor",
    "drift",
    "empty",
    "over-limit",
    "missing-version",
  ])("rejects %s comment pagination", async (mode) => {
    const capture = await saved(1, 211);
    const { transport } = fixture(1, {
      comments: { 1: 211 },
      respond: (call, response) => {
        if (call.ordinal === 2) {
          const c = record(alias(response).comments);
          if (mode === "duplicate-id") record((c.nodes as unknown[])[0]).id = "C_1_1";
          if (mode === "duplicate-url") record((c.nodes as unknown[])[0]).url = comment(1, 1).url;
          if (mode === "cursor") record(c.pageInfo).endCursor = "10";
          if (mode === "drift") c.totalCount = 212;
          if (mode === "empty") c.nodes = [];
          if (mode === "over-limit") (c.nodes as unknown[]).push(comment(1, 999));
          if (mode === "missing-version") delete record((c.nodes as unknown[])[0]).updatedAt;
        }
        return response;
      },
    });
    await expectSafeFailure(
      revalidateSemanticEvidenceBatch(transport, "o/r", capture.items),
      mode.startsWith("duplicate")
        ? "duplicate-comment"
        : mode === "cursor"
          ? "repeated-cursor"
          : mode === "drift"
            ? "total-count-drift"
            : mode === "missing-version"
              ? "malformed-comment"
              : "malformed-page",
    );
  });

  test("validates all requested identities before I/O and supports empty batches", async () => {
    const capture = await saved();
    const { transport } = fixture();
    expect(await revalidateSemanticEvidenceBatch(transport, "o/r", [])).toEqual(new Map());
    await expectSafeFailure(
      revalidateSemanticEvidenceBatch(transport, "o/r", [...capture.items, capture.items[0]]),
      "issue-identity-unverified",
    );
    await expectSafeFailure(
      revalidateSemanticEvidenceBatch(transport, "other/repo", capture.items),
      "issue-identity-unverified",
    );
    expect(transport.graphql).not.toHaveBeenCalled();
  });

  test("single helper delegates and preserves closed state", async () => {
    const capture = await saved(1);
    expect(
      await revalidateSemanticEvidence(
        fixture(1, { comments: { 1: 1 } }).transport,
        "o/r",
        capture.items[0],
      ),
    ).toBe("current");
    const { transport } = fixture(1, {
      respond: (_call, response) =>
        mutateIssue(response, (node) => {
          node.state = "CLOSED";
        }),
    });
    expect(await revalidateSemanticEvidence(transport, "o/r", capture.items[0])).toBe(
      "state-changed",
    );
  });

  test("incomplete 301-comment evidence is never current", async () => {
    const capture = await saved(1, 301);
    const { transport, calls } = fixture(1, { comments: { 1: 301 } });
    expect(await revalidateSemanticEvidence(transport, "o/r", capture.items[0])).toBe(
      "needs-refresh",
    );
    expect(calls).toHaveLength(4);
  });

  test("oversized response fails rather than truncating text", async () => {
    const { transport } = fixture(1, {
      respond: (call, response) => {
        if (call.operation === "Issues") first(response).body = "x".repeat(16 * 1024 * 1024);
        return response;
      },
    });
    const result = await collectSemanticEvidence(transport, OPTIONS);
    expect(result.items).toEqual([]);
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.reasonCodes).toContain("github-response-too-large");
  });
});

describe("batch pagination regression cases", () => {
  test("independent alias cursors survive batch boundaries and different comment lengths", async () => {
    const { transport, calls } = fixture(42, {
      comments: { 1: 300, 2: 211, 21: 101, 22: 11, 41: 111 },
    });
    const result = await collectSemanticEvidence(transport, OPTIONS);
    expect(result.coverage.complete).toBe(true);
    expect(result.items.map((i) => i.number)).toEqual(Array.from({ length: 42 }, (_, i) => i + 1));
    for (const [number, count] of [
      [1, 300],
      [2, 211],
      [21, 101],
      [22, 11],
      [41, 111],
    ]) {
      expect(result.items[number - 1].comments.map((c) => c.id)).toEqual(
        Array.from({ length: count }, (_, i) => `C_${number}_${i + 1}`),
      );
    }
    for (const call of calls) {
      expect([...call.query.matchAll(/i\d+: issue/g)].length).toBeLessThanOrEqual(20);
      const sizes = Object.entries(call.variables)
        .filter(([key]) => key.startsWith("first"))
        .map(([, value]) => Number(value));
      expect(sizes.every((size) => size <= 100)).toBe(true);
      if (call.operation === "Bodies") {
        expect(sizes.length).toBeLessThanOrEqual(2);
        expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(200);
      }
    }
  });

  test("a late comment-only edit past the first two pages refetches the full affected issue", async () => {
    const capture = await saved(1, 300);
    const { transport, calls } = fixture(1, {
      comments: { 1: 300 },
      respond: (_call, response) =>
        mutateIssue(response, (node) => {
          for (const c of record(node.comments).nodes as Record<string, unknown>[]) {
            if (c.id === "C_1_299") {
              c.updatedAt = EDITED;
              if ("body" in c) c.body = "Late edit";
            }
          }
        }),
    });
    const onEvidenceReuse = vi.fn();
    const result = await collectSemanticEvidence(transport, {
      ...OPTIONS,
      previousCapture: capture,
      onEvidenceReuse,
    });
    expect(result.coverage.complete).toBe(true);
    expect(result.items[0].updatedAt).toBe(TIME);
    expect(result.items[0].comments[298]).toMatchObject({ updatedAt: EDITED, body: "Late edit" });
    expect(calls.filter((c) => c.operation === "Bodies")).toHaveLength(4);
    expect(onEvidenceReuse).not.toHaveBeenCalled();
  });

  test.each([
    "CLOSED",
    "EDITED",
  ])("known %s transition during revalidation is not current", async (state) => {
    const capture = await saved(1, 111);
    const { transport } = fixture(1, {
      comments: { 1: 111 },
      respond: (call, response) => {
        if (call.ordinal === 2) {
          if (state === "CLOSED") alias(response).state = "CLOSED";
          else alias(response).updatedAt = EDITED;
        }
        return response;
      },
    });
    expect(await revalidateSemanticEvidence(transport, "o/r", capture.items[0])).toBe(
      state === "CLOSED" ? "state-changed" : "needs-refresh",
    );
  });

  test("untrusted cursor values stay in GraphQL variables", async () => {
    const cursor = 'opaque-"} query { privateRepository }';
    const { transport, calls } = fixture(1, {
      comments: { 1: 11 },
      respond: (call, response) => {
        if (call.operation === "Issues")
          record(record(first(response).comments).pageInfo).endCursor = cursor;
        if (call.operation === "Bodies")
          alias(response).comments = connection([comment(1, 11)], 11, false, "11");
        return response;
      },
    });
    const result = await collectSemanticEvidence(transport, OPTIONS);
    expect(result.coverage.complete).toBe(true);
    expect(calls.find((c) => c.operation === "Bodies")?.variables.after0).toBe(cursor);
    expect(calls.every((c) => !c.query.includes(cursor))).toBe(true);
  });

  test("short pages exhausting the four-page bound remain explicitly incomplete", async () => {
    const { transport } = fixture(1, {
      comments: { 1: 300 },
      respond: (call, response) => {
        if (call.operation === "Bodies" || call.operation === "Versions") {
          const node = alias(response);
          const start = Number(call.variables.after0 ?? 0);
          node.comments = connection([comment(1, start + 1)], 300, true, String(start + 1));
        }
        return response;
      },
    });
    const result = await collectSemanticEvidence(transport, OPTIONS);
    expect(result.items[0].commentsCoverage).toMatchObject({
      captured: 13,
      pages: 4,
      complete: false,
      reasonCodes: ["comments-page-limit"],
    });
    expect(result.coverage.complete).toBe(false);
  });
});

describe("compiled CLI gh fixture contract", () => {
  test.each([
    "good",
    "demo",
    "empty",
  ])("%s supports the real batched query shapes", async (mode) => {
    let calls = 0;
    const transport: GhTransport = {
      async graphql(query, variables = {}) {
        calls++;
        const args = [
          fileURLToPath(new URL("../tests/fixtures/classify/gh.cjs", import.meta.url)),
          "api",
          "graphql",
          "-f",
          `query=${query}`,
        ];
        for (const [key, value] of Object.entries(variables))
          args.push(typeof value === "number" ? "-F" : "-f", `${key}=${value}`);
        return JSON.parse(
          execFileSync(process.execPath, args, {
            encoding: "utf8",
            env: { CLASSIFY_TEST_LOG: "/dev/null", CLASSIFY_TEST_CASE: mode },
          }),
        );
      },
      async search() {
        throw new Error("Unexpected search");
      },
    };
    const result = await collectSemanticEvidence(transport, {
      ...OPTIONS,
      repo: "sample/public-repo",
    });
    expect(result.coverage.complete).toBe(mode !== "demo");
    expect(calls).toBe(mode === "good" ? 5 : mode === "demo" ? 7 : 4);
    expect(result.items).toHaveLength(mode === "good" ? 1 : mode === "demo" ? 3 : 0);
    if (mode === "demo") {
      expect(result.items[0].comments).toHaveLength(101);
      expect(result.items[0].commentsCoverage.complete).toBe(true);
      expect(result.items[2]).toMatchObject({
        state: "CLOSED",
        status: "excluded",
        reasonCodes: ["state-changed"],
      });
    }
  });
});
