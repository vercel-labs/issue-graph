import { describe, expect, test } from "vitest";
import { classify, fillMentionedBy } from "./classify.js";
import type { Edge, GraphNode, NodeKey } from "./types.js";

function node(key: NodeKey, over: Partial<GraphNode> = {}): GraphNode {
  const [ownerRepo, num] = key.split("#");
  const [owner, repo] = ownerRepo.split("/");
  return {
    key,
    owner,
    repo,
    number: Number(num),
    kind: "Issue",
    title: key,
    state: "OPEN",
    url: "",
    depth: 1,
    edges: [],
    externalLinks: [],
    fetched: true,
    ...over,
  };
}

const asMap = (ns: GraphNode[]) => new Map(ns.map((n) => [n.key, n]));
const closes = (to: NodeKey): Edge => ({ to, via: "closes" });
const prMeta = (createdAt: string, mergedAt = "") => ({
  isDraft: false,
  reviewDecision: "",
  mergeable: "UNKNOWN",
  createdAt,
  mergedAt,
  updatedAt: createdAt,
  additions: 0,
  deletions: 0,
  changedFiles: 0,
  files: [],
});

describe("classify", () => {
  test("flags an open PR as superseded when a merged PR closes the same issue", () => {
    const nodes = asMap([
      node("o/r#352", { kind: "PullRequest", state: "MERGED", edges: [closes("o/r#343")] }),
      node("o/r#349", { kind: "PullRequest", state: "OPEN", edges: [closes("o/r#343")] }),
      node("o/r#343", { state: "CLOSED" }),
    ]);
    classify(nodes);
    expect(nodes.get("o/r#349")?.verdict).toMatch(/^SUPERSEDED by merged o\/r#352/);
  });

  test("an unrelated open PR is untriaged, not superseded", () => {
    const nodes = asMap([
      node("o/r#500", { kind: "PullRequest", state: "OPEN", edges: [closes("o/r#501")] }),
      node("o/r#501", { state: "OPEN" }),
    ]);
    classify(nodes);
    expect(nodes.get("o/r#500")?.verdict).toBe("OPEN PR — untriaged");
  });

  test("flags an open PR as possibly superseded through an issue closed by another PR", () => {
    const nodes = asMap([
      node("o/r#1589", {
        kind: "PullRequest",
        state: "MERGED",
        edges: [closes("o/r#214")],
        pr: prMeta("2026-07-21T00:00:00Z", "2026-08-10T00:00:00Z"),
      }),
      node("o/r#215", {
        kind: "PullRequest",
        state: "OPEN",
        edges: [{ to: "o/r#214", via: "cross-ref" }],
        pr: prMeta("2026-01-23T00:00:00Z"),
      }),
      node("o/r#214", { state: "CLOSED" }),
    ]);
    classify(nodes);
    expect(nodes.get("o/r#215")?.verdict).toBe(
      "POSSIBLY SUPERSEDED by merged o/r#1589 via closed issue o/r#214 — verify scope, then close with credit",
    );
  });

  test("finds possible supersession when only the closed issue links to the open PR", () => {
    const nodes = asMap([
      node("o/r#1589", {
        kind: "PullRequest",
        state: "MERGED",
        edges: [closes("o/r#214")],
        pr: prMeta("2026-07-21T00:00:00Z", "2026-08-10T00:00:00Z"),
      }),
      node("o/r#215", {
        kind: "PullRequest",
        state: "OPEN",
        pr: prMeta("2026-01-23T00:00:00Z"),
      }),
      node("o/r#214", {
        state: "CLOSED",
        edges: [{ to: "o/r#215", via: "connected" }],
      }),
    ]);
    classify(nodes);
    expect(nodes.get("o/r#215")?.verdict).toContain(
      "POSSIBLY SUPERSEDED by merged o/r#1589 via closed issue o/r#214",
    );
  });

  test("does not infer possible supersession from a text mention", () => {
    const nodes = asMap([
      node("o/r#1589", {
        kind: "PullRequest",
        state: "MERGED",
        edges: [closes("o/r#214")],
        pr: prMeta("2026-07-21T00:00:00Z", "2026-08-10T00:00:00Z"),
      }),
      node("o/r#215", {
        kind: "PullRequest",
        state: "OPEN",
        edges: [{ to: "o/r#214", via: "text" }],
        pr: prMeta("2026-01-23T00:00:00Z"),
      }),
      node("o/r#214", { state: "CLOSED" }),
    ]);
    classify(nodes);
    expect(nodes.get("o/r#215")?.verdict).toBe("OPEN PR — untriaged");
  });

  test("does not infer possible supersession while the related issue is open", () => {
    const nodes = asMap([
      node("o/r#1589", {
        kind: "PullRequest",
        state: "MERGED",
        edges: [closes("o/r#214")],
        pr: prMeta("2026-07-21T00:00:00Z", "2026-08-10T00:00:00Z"),
      }),
      node("o/r#215", {
        kind: "PullRequest",
        state: "OPEN",
        edges: [{ to: "o/r#214", via: "cross-ref" }],
        pr: prMeta("2026-01-23T00:00:00Z"),
      }),
      node("o/r#214"),
    ]);
    classify(nodes);
    expect(nodes.get("o/r#215")?.verdict).toBe("OPEN PR — untriaged");
  });

  test("does not infer possible supersession from work merged before the open PR existed", () => {
    const nodes = asMap([
      node("o/r#184", {
        kind: "PullRequest",
        state: "MERGED",
        edges: [closes("o/r#86")],
        pr: prMeta("2026-01-20T00:00:00Z", "2026-01-20T12:00:00Z"),
      }),
      node("o/r#1117", {
        kind: "PullRequest",
        state: "OPEN",
        edges: [{ to: "o/r#86", via: "cross-ref" }],
        pr: prMeta("2026-04-02T00:00:00Z"),
      }),
      node("o/r#86", { state: "CLOSED" }),
    ]);
    classify(nodes);
    expect(nodes.get("o/r#1117")?.verdict).toBe("OPEN PR — untriaged");
  });

  test("a sub-issue link is not a closing link", () => {
    const subIssueOf = (to: NodeKey): Edge => ({ to, via: "sub-issue" });
    const nodes = asMap([
      node("o/r#7848", { state: "CLOSED" }),
      node("o/r#8343", { kind: "PullRequest", state: "MERGED", edges: [subIssueOf("o/r#7848")] }),
      node("o/r#8344", { kind: "PullRequest", state: "OPEN", edges: [subIssueOf("o/r#7848")] }),
      node("o/r#8345", { kind: "PullRequest", state: "OPEN", edges: [subIssueOf("o/r#7848")] }),
    ]);
    classify(nodes);
    expect(nodes.get("o/r#8344")?.verdict).toBe("OPEN PR — untriaged");
    expect(nodes.get("o/r#8344")?.flags).toBeUndefined();
    expect(nodes.get("o/r#8345")?.flags).toBeUndefined();
  });

  test("depth-0 nodes are marked as seeds", () => {
    const nodes = asMap([node("o/r#1", { depth: 0 })]);
    classify(nodes);
    expect(nodes.get("o/r#1")?.verdict).toBe("seed");
  });

  test("flags two open PRs closing the same issue as competing", () => {
    const nodes = asMap([
      node("o/r#10", { kind: "PullRequest", state: "OPEN", edges: [closes("o/r#1")] }),
      node("o/r#11", { kind: "PullRequest", state: "OPEN", edges: [closes("o/r#1")] }),
      node("o/r#1"),
    ]);
    classify(nodes);
    expect(nodes.get("o/r#10")?.flags?.join()).toContain("competes with o/r#11");
    expect(nodes.get("o/r#11")?.flags?.join()).toContain("competes with o/r#10");
  });

  test("flags a PR that claims to close an issue with no structural link", () => {
    const nodes = asMap([
      node("o/r#20", {
        kind: "PullRequest",
        state: "OPEN",
        claimsClose: ["o/r#2"], // body says "fixes #2"
        edges: [{ to: "o/r#2", via: "text" }], // but only a text mention, no closes
      }),
      node("o/r#2"),
    ]);
    classify(nodes);
    expect(nodes.get("o/r#20")?.flags?.join()).toContain("no closing link");
  });

  test("does not flag when the closing claim has a structural link", () => {
    const nodes = asMap([
      node("o/r#30", {
        kind: "PullRequest",
        state: "OPEN",
        claimsClose: ["o/r#3"],
        edges: [closes("o/r#3")],
      }),
      node("o/r#3"),
    ]);
    classify(nodes);
    expect(nodes.get("o/r#30")?.flags ?? []).toEqual([]);
  });
});

describe("fillMentionedBy", () => {
  test("collects incoming edge actors, sorted and deduped", () => {
    const nodes = asMap([
      node("o/r#1", { edges: [{ to: "o/r#3", via: "text", by: "bob" }] }),
      node("o/r#2", { edges: [{ to: "o/r#3", via: "cross-ref", by: "alice" }] }),
      node("o/r#3"),
    ]);
    fillMentionedBy(nodes);
    expect(nodes.get("o/r#3")?.mentionedBy).toEqual(["alice", "bob"]);
    expect(nodes.get("o/r#1")?.mentionedBy).toEqual([]);
  });
});
