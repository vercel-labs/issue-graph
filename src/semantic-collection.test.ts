import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fixture, record, repoData, TIME } from "../tests/semantic-github-fixture.js";
import { buildEvaluationInput } from "./semantic.js";
import { collectSemanticEvidence, revalidateSemanticEvidenceBatch } from "./semantic-github.js";

const OPTIONS = { repo: "o/r", limit: 100, now: () => TIME };
const EDITED = "2026-09-20T01:00:00Z";
function nodes(response: unknown): Record<string, unknown>[] {
  const repo = repoData(response);
  return repo.issues && "nodes" in record(repo.issues)
    ? (record(repo.issues).nodes as Record<string, unknown>[])
    : Object.entries(repo)
        .filter(([key]) => /^i\d+$/.test(key))
        .map(([, node]) => record(node));
}
beforeEach(() => vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network forbidden"))));
afterEach(() => {
  const calls = vi.mocked(fetch).mock.calls;
  vi.unstubAllGlobals();
  expect(calls).toHaveLength(0);
});

test("76 issues: 11 cold queries, 11 warm capture plus 4 revalidation queries, stored bodies only", async () => {
  const comments = Object.fromEntries(Array.from({ length: 76 }, (_, i) => [i + 1, i % 11]));
  const cold = fixture(76, { comments });
  const saved = await collectSemanticEvidence(cold.transport, OPTIONS);
  expect(cold.calls).toHaveLength(11);
  expect(saved.coverage).toMatchObject({ captured: 76, complete: true });
  for (const item of saved.items) {
    item.body = `Stored body ${item.number}`;
    for (const comment of item.comments) comment.body = `Stored ${comment.id}`;
  }
  const before = structuredClone(saved);
  const warm = fixture(76, { comments });
  const reused = vi.fn();
  const result = await collectSemanticEvidence(warm.transport, {
    ...OPTIONS,
    previousCapture: saved,
    onEvidenceReuse: reused,
    now: () => EDITED,
  });
  expect(warm.calls).toHaveLength(11);
  expect(result.coverage.complete).toBe(true);
  expect(reused.mock.calls.flat()).toEqual(saved.items.map((item) => item.key));
  expect(result.items.map((item) => buildEvaluationInput(item, null))).toEqual(
    saved.items.map((item) => buildEvaluationInput(item, null)),
  );
  const checked = await revalidateSemanticEvidenceBatch(warm.transport, "o/r", result.items);
  expect([...checked.values()]).toEqual(Array(76).fill("current"));
  expect(warm.calls).toHaveLength(15);
  expect(warm.calls.every((call) => !/\bbody\b/.test(call.query))).toBe(true);
  expect(saved).toEqual(before);
  for (const call of [...cold.calls, ...warm.calls]) {
    expect(call.variables).toMatchObject({ owner: "o", repo: "r" });
    expect(call.query).toContain("nameWithOwner visibility isPrivate");
    expect(call.query).not.toMatch(/\b(mutation|search|pullRequests|issueOrPullRequest)\b/);
    expect([...call.query.matchAll(/i\d+: issue/g)].length).toBeLessThanOrEqual(20);
  }
  expect(warm.transport.search).not.toHaveBeenCalled();
});

const changes = ["updatedAt", "author", "url", "id", "order", "added", "removed"];
test.each(
  changes,
)("comment %s beyond page one invalidates reuse without a parent edit", async (change) => {
  const saved = await collectSemanticEvidence(
    fixture(2, { comments: { 1: 12 } }).transport,
    OPTIONS,
  );
  saved.items[0].body = "Stored body must not survive invalidation";
  const count = change === "added" ? 13 : change === "removed" ? 11 : 12;
  const source = fixture(2, {
    comments: { 1: count },
    respond: (_call, response) => {
      for (const node of nodes(response).filter((node) => node.number === 1)) {
        const comments = record(node.comments).nodes as Record<string, unknown>[];
        const last = comments.find((comment) => comment.id === "C_1_12");
        if (!last) continue;
        if (change === "updatedAt") last.updatedAt = EDITED;
        if (change === "author") last.author = { login: "bob" };
        if (change === "url") last.url = "https://github.com/o/r/issues/1#issuecomment-999";
        if (change === "id") last.id = "REPLACEMENT_COMMENT";
        if (change === "order") comments.reverse();
      }
      return response;
    },
  });
  const reused = vi.fn();
  const result = await collectSemanticEvidence(source.transport, {
    ...OPTIONS,
    previousCapture: saved,
    onEvidenceReuse: reused,
  });
  expect(result.coverage.complete).toBe(true);
  expect(result.items[0].updatedAt).toBe(saved.items[0].updatedAt);
  expect(result.items[0].comments).not.toEqual(saved.items[0].comments);
  expect(result.items[0].body).not.toBe(saved.items[0].body);
  expect(result.items[1]).toEqual(saved.items[1]);
  expect(reused).toHaveBeenCalledExactlyOnceWith("o/r#2");
  expect(
    source.calls
      .filter((call) => call.operation === "Bodies")
      .map((call) => call.variables.number0),
  ).toEqual([1, 1]);
});

test.each([300, 301])("%i comments stop at four pages with honest coverage", async (total) => {
  const source = fixture(1, { comments: { 1: total } });
  const result = await collectSemanticEvidence(source.transport, OPTIONS);
  expect(result.items[0].comments).toHaveLength(300);
  expect(result.items[0].commentsCoverage).toEqual({
    captured: 300,
    total,
    pages: 4,
    hasNextPage: total > 300,
    complete: total === 300,
    reasonCodes: total > 300 ? ["comments-page-limit"] : [],
  });
  expect(result.coverage.complete).toBe(total === 300);
  const pages = source.calls.filter((call) => call.operation === "Bodies");
  expect(pages.map((call) => [call.variables.after0, call.variables.first0])).toEqual([
    ["10", 100],
    ["110", 100],
    ["210", 90],
  ]);
});

test.each([
  ["private", "Repository", "repository-not-public"],
  ["private", "Versions", "repository-not-public"],
  ["scope", "Repository", "repository-identity-unverified"],
  ["graphql", "Repository", "github-graphql-error"],
])("%s at %s rejects the capture", async (change, operation, code) => {
  const source = fixture(1, {
    respond: (call, response) => {
      if (call.operation !== operation) return response;
      if (change === "private") repoData(response).visibility = "PRIVATE";
      if (change === "scope") repoData(response).nameWithOwner = "other/repo";
      return change === "graphql"
        ? { ...record(response), errors: [{ message: "upstream-private-text" }] }
        : response;
    },
  });
  await expect(collectSemanticEvidence(source.transport, OPTIONS)).rejects.toMatchObject({ code });
  if (operation === "Repository") {
    expect(source.calls).toHaveLength(1);
    expect(source.calls[0].query).not.toMatch(/\bbody\b/);
  }
});

test.each([
  ["identity", "issue-identity-unverified"],
  ["graphql", "github-graphql-error"],
  ["cursor", "repeated-cursor"],
  ["count", "total-count-drift"],
])("%s drift cannot produce complete evidence", async (change, code) => {
  const source = fixture(41, {
    respond: (call, response) => {
      if (change === "identity" && call.operation === "Versions") nodes(response)[0].id = "OTHER";
      if (change === "graphql" && call.operation === "Issues" && call.ordinal === 2)
        return { ...record(response), errors: [{ message: "upstream-private-text" }] };
      if (change === "cursor" && call.operation === "Issues" && call.ordinal === 2)
        record(record(repoData(response).issues).pageInfo).endCursor = "20";
      if (change === "count" && call.operation === "Repository" && call.ordinal === 3)
        record(repoData(response).issues).totalCount = 42;
      return response;
    },
  });
  const result = await collectSemanticEvidence(source.transport, OPTIONS);
  expect(result.coverage.complete).toBe(false);
  expect([
    ...result.coverage.reasonCodes,
    ...result.items.flatMap((item) => item.reasonCodes),
  ]).toContain(code);
  expect(result.items.some((item) => item.status === "ready")).toBe(true);
  expect(JSON.stringify(result)).not.toContain("upstream-private-text");
  if (change === "cursor" || change === "graphql")
    expect(source.calls.filter((call) => call.operation === "Issues")).toHaveLength(2);
});
