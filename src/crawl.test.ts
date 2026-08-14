import { describe, expect, test } from "bun:test";
import { components, crawl } from "./crawl.js";
import type { FetchNode } from "./github.js";
import type { Edge, GraphNode, NodeKey } from "./types.js";

/** Build an offline FetchNode from a fixture of key -> outgoing edge targets. */
function fakeFetch(graph: Record<NodeKey, Array<Partial<Edge> & { to: NodeKey }>>): FetchNode {
  return async (owner, repo, number, depth) => {
    const key = `${owner}/${repo}#${number}`;
    const edges: Edge[] = (graph[key] ?? []).map((e) => ({ via: "text", ...e }));
    return {
      key,
      owner,
      repo,
      number,
      kind: "Issue",
      title: key,
      state: "OPEN",
      url: `https://github.com/${owner}/${repo}/issues/${number}`,
      depth,
      edges,
      externalLinks: [],
      fetched: true,
    } satisfies GraphNode;
  };
}

const opts = (over: Partial<Parameters<typeof crawl>[1]> = {}) => ({
  maxDepth: 2,
  maxNodes: 80,
  hubThreshold: 12,
  concurrency: 4,
  primaryRepo: { owner: "o", repo: "r" },
  ...over,
});

describe("crawl", () => {
  test("follows edges and dedupes cycles", async () => {
    const fetch = fakeFetch({
      "o/r#1": [{ to: "o/r#2" }],
      "o/r#2": [{ to: "o/r#1" }], // cycle back
    });
    const { nodes } = await crawl([{ owner: "o", repo: "r", number: 1 }], opts(), fetch);
    expect([...nodes.keys()].sort()).toEqual(["o/r#1", "o/r#2"]);
  });

  test("respects the node cap and records what it dropped", async () => {
    const fetch = fakeFetch({
      "o/r#1": [{ to: "o/r#2" }, { to: "o/r#3" }],
    });
    const { nodes, cappedOut } = await crawl(
      [{ owner: "o", repo: "r", number: 1 }],
      opts({ maxNodes: 2 }),
      fetch,
    );
    expect(nodes.size).toBe(2);
    expect(cappedOut.size).toBeGreaterThan(0);
  });

  test("hub guard fetches but does not expand a high-degree node", async () => {
    const hubEdges = Array.from({ length: 5 }, (_, i) => ({ to: `o/r#${100 + i}` }));
    const fetch = fakeFetch({ "o/r#1": [{ to: "o/r#2" }], "o/r#2": hubEdges });
    const { nodes } = await crawl(
      [{ owner: "o", repo: "r", number: 1 }],
      opts({ hubThreshold: 3 }),
      fetch,
    );
    expect(nodes.get("o/r#2")?.hub).toBe(true);
    // hub's targets were never enqueued
    expect(nodes.has("o/r#100")).toBe(false);
  });

  test("fetches cross-repo refs one hop but does not expand them", async () => {
    const fetch = fakeFetch({
      "o/r#1": [{ to: "other/x#9" }],
      "other/x#9": [{ to: "other/x#10" }],
    });
    const { nodes } = await crawl([{ owner: "o", repo: "r", number: 1 }], opts(), fetch);
    expect(nodes.has("other/x#9")).toBe(true); // fetched
    expect(nodes.has("other/x#10")).toBe(false); // not expanded
  });

  test("bounds node requests in flight", async () => {
    let active = 0;
    let peak = 0;
    const fetch: FetchNode = async (owner, repo, number, depth) => {
      active++;
      peak = Math.max(peak, active);
      await Bun.sleep(5);
      active--;
      return {
        key: `${owner}/${repo}#${number}`,
        owner,
        repo,
        number,
        kind: "Issue",
        title: String(number),
        state: "OPEN",
        url: "",
        depth,
        edges: [],
        externalLinks: [],
        fetched: true,
      };
    };
    await crawl(
      Array.from({ length: 9 }, (_, index) => ({ owner: "o", repo: "r", number: index + 1 })),
      opts({ concurrency: 3 }),
      fetch,
    );
    expect(peak).toBe(3);
  });
});

describe("components", () => {
  test("groups connected nodes and separates disjoint ones", async () => {
    const fetch = fakeFetch({
      "o/r#1": [{ to: "o/r#2" }],
      "o/r#2": [],
      "o/r#9": [],
    });
    const { nodes } = await crawl(
      [
        { owner: "o", repo: "r", number: 1 },
        { owner: "o", repo: "r", number: 9 },
      ],
      opts(),
      fetch,
    );
    const comps = components(nodes);
    expect(comps.length).toBe(2);
    expect(comps[0].length).toBe(2); // {#1,#2} largest first
  });
});
