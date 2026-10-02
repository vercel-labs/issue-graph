import { describe, expect, test } from "vitest";
import { prioritize, renderPriority, score } from "./priority.js";
import type { Edge, GraphNode, HeatMeta, NodeKey } from "./types.js";

const NOW = new Date("2026-07-16T00:00:00Z");

function node(
  key: NodeKey,
  heat: Partial<HeatMeta> = {},
  over: Partial<GraphNode> = {},
): GraphNode {
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
    url: `https://github.com/${key}`,
    depth: 1,
    edges: [],
    externalLinks: [],
    fetched: true,
    heat: {
      createdAt: "2026-07-01T00:00:00Z",
      comments: 0,
      participants: 0,
      reactions: 0,
      ...heat,
    },
    ...over,
  };
}

const asMap = (ns: GraphNode[]) => new Map(ns.map((n) => [n.key, n]));
const mentions = (to: NodeKey): Edge => ({ to, via: "text" });

describe("prioritize", () => {
  test("ranks the hottest discussion first", () => {
    const nodes = asMap([
      node("o/r#1", { comments: 2 }),
      node("o/r#2", { comments: 20, participants: 8, reactions: 14 }),
      node("o/r#3"),
    ]);
    const rows = prioritize(nodes, NOW);
    expect(rows.map((r) => r.key)).toEqual(["o/r#2", "o/r#1", "o/r#3"]);
  });

  test("only OPEN fetched nodes are ranked", () => {
    const nodes = asMap([
      node("o/r#1"),
      node("o/r#2", {}, { state: "CLOSED" }),
      node("o/r#3", {}, { state: "MERGED", kind: "PullRequest" }),
      node("o/r#4", {}, { fetched: false, state: "OPEN" }),
    ]);
    expect(prioritize(nodes, NOW).map((r) => r.key)).toEqual(["o/r#1"]);
  });

  test("counts inbound refs from other nodes", () => {
    const nodes = asMap([
      node("o/r#1"),
      node("o/r#2", {}, { edges: [mentions("o/r#1")] }),
      node("o/r#3", {}, { edges: [mentions("o/r#1")] }),
    ]);
    const target = prioritize(nodes, NOW).find((r) => r.key === "o/r#1");
    expect(target?.inboundRefs).toBe(2);
    expect(target?.key).toBe(prioritize(nodes, NOW)[0].key); // inbound heat wins
  });

  test("sub-issues do not add inbound heat to their parent", () => {
    const nodes = asMap([
      node("o/r#1"),
      node("o/r#2", {}, { edges: [{ to: "o/r#1", via: "sub-issue" }] }),
      node("o/r#3", {}, { edges: [mentions("o/r#1")] }),
    ]);
    expect(prioritize(nodes, NOW).find((r) => r.key === "o/r#1")?.inboundRefs).toBe(1);
  });

  test("computes whole days open and caps the age boost", () => {
    const nodes = asMap([
      node("o/r#1", { createdAt: "2026-07-06T00:00:00Z" }),
      node("o/r#2", { createdAt: "2020-01-01T00:00:00Z" }),
      node("o/r#3", { createdAt: "" }),
    ]);
    const byKey = new Map(prioritize(nodes, NOW).map((r) => [r.key, r]));
    expect(byKey.get("o/r#1")?.daysOpen).toBe(10);
    expect(byKey.get("o/r#2")?.score).toBe(12); // age contribution capped at 12
    expect(byKey.get("o/r#3")?.daysOpen).toBe(0);
  });

  test("score formula is linear and transparent", () => {
    expect(
      score({
        key: "o/r#1",
        kind: "Issue",
        title: "",
        url: "",
        comments: 10,
        participants: 4,
        reactions: 3,
        inboundRefs: 2,
        daysOpen: 60,
      }),
    ).toBe(10 * 3 + 4 * 2 + 3 * 2 + 2 * 2 + 2); // 50
  });

  test("ties break by key for a deterministic order", () => {
    const nodes = asMap([node("o/r#9"), node("o/r#2")]);
    expect(prioritize(nodes, NOW).map((r) => r.key)).toEqual(["o/r#2", "o/r#9"]);
  });
});

describe("renderPriority", () => {
  test("renders rank, signals, and the formula", () => {
    const md = renderPriority(
      prioritize(asMap([node("o/r#1", { comments: 5, reactions: 2 })]), NOW),
    );
    expect(md).toContain("## Triage priority");
    expect(md).toContain("1. **o/r#1**");
    expect(md).toContain("5 comments");
    expect(md).toContain("2 reactions");
    expect(md).toContain("score = comments×3");
  });

  test("handles an empty graph", () => {
    expect(renderPriority([])).toContain("(no open nodes)");
  });
});
