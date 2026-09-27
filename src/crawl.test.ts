import { setTimeout } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import { components, crawl, crawlGraph } from "./crawl.js";
import type { FetchNode } from "./github.js";
import type { CrawlNode, Edge, GraphFetchNode, GraphNode, NodeKey } from "./types.js";

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

interface FixtureNode extends CrawlNode {
  source: string;
  label: string;
}

function fakeGraphFetch(graph: Record<NodeKey, NodeKey[]>): GraphFetchNode<FixtureNode> {
  return async (key, depth) => ({
    key,
    depth,
    edges: (graph[key] ?? []).map((to) => ({ to })),
    source: key.split(":", 1)[0],
    label: `node ${key}`,
  });
}

describe("crawlGraph", () => {
  test("follows arbitrary keys, dedupes cycles, and preserves collector fields", async () => {
    const fetch = fakeGraphFetch({
      "jira:PROJ-1": ["jira:PROJ-2"],
      "jira:PROJ-2": ["jira:PROJ-1"],
    });
    const { nodes } = await crawlGraph(
      [{ key: "jira:PROJ-1" }],
      { maxDepth: 2, maxNodes: 80, hubThreshold: 12, concurrency: 2 },
      fetch,
    );

    expect([...nodes.keys()].sort()).toEqual(["jira:PROJ-1", "jira:PROJ-2"]);
    expect(nodes.get("jira:PROJ-2")).toMatchObject({
      depth: 1,
      source: "jira",
      label: "node jira:PROJ-2",
    });
    expect(components(nodes)).toEqual([["jira:PROJ-1", "jira:PROJ-2"]]);
  });

  test("fetches a cross-source boundary without expanding it", async () => {
    const fetch = fakeGraphFetch({
      "jira:PROJ-1": ["github:o/r#7"],
      "github:o/r#7": ["github:o/r#8"],
    });
    const { nodes } = await crawlGraph(
      [{ key: "jira:PROJ-1" }],
      {
        maxDepth: 2,
        maxNodes: 80,
        hubThreshold: 12,
        depthForEdge: ({ edge, sourceDepth, maxDepth }) =>
          edge.to.startsWith("jira:") ? sourceDepth + 1 : maxDepth,
      },
      fetch,
    );

    expect(nodes.get("github:o/r#7")?.depth).toBe(2);
    expect(nodes.has("github:o/r#8")).toBe(false);
  });

  test("admits nearer nodes before earlier deeper boundaries when capped", async () => {
    const fetch = fakeGraphFetch({
      "jira:PROJ-1": ["jira:TEAM-1", "jira:PROJ-2"],
      "jira:TEAM-1": [],
      "jira:PROJ-2": [],
    });
    const { nodes, cappedOut } = await crawlGraph(
      [{ key: "jira:PROJ-1" }],
      {
        maxDepth: 2,
        maxNodes: 2,
        hubThreshold: 12,
        depthForEdge: ({ edge, sourceDepth, maxDepth }) =>
          edge.to === "jira:TEAM-1" ? maxDepth : sourceDepth + 1,
      },
      fetch,
    );

    expect([...nodes.keys()]).toEqual(["jira:PROJ-1", "jira:PROJ-2"]);
    expect(cappedOut).toEqual(new Set(["jira:TEAM-1"]));
  });

  test("lowers a pending depth when a shorter path is discovered before fetch", async () => {
    const fetch = fakeGraphFetch({
      "jira:PROJ-1": ["jira:PROJ-3", "jira:PROJ-2"],
      "jira:PROJ-2": ["jira:PROJ-3"],
      "jira:PROJ-3": ["jira:PROJ-4"],
      "jira:PROJ-4": [],
    });
    const { nodes } = await crawlGraph(
      [{ key: "jira:PROJ-1" }],
      {
        maxDepth: 3,
        maxNodes: 10,
        hubThreshold: 12,
        depthForEdge: ({ sourceKey, edge, sourceDepth, maxDepth }) =>
          sourceKey === "jira:PROJ-1" && edge.to === "jira:PROJ-3" ? maxDepth : sourceDepth + 1,
      },
      fetch,
    );

    expect(nodes.get("jira:PROJ-3")?.depth).toBe(2);
    expect(nodes.get("jira:PROJ-4")?.depth).toBe(3);
  });

  test("fetches a same-layer sibling exactly once at its shortest depth", async () => {
    const graph: Record<NodeKey, NodeKey[]> = {
      "jira:PROJ-1": ["jira:PROJ-2", "jira:PROJ-3"],
      "jira:PROJ-2": ["jira:PROJ-3"],
      "jira:PROJ-3": [],
    };
    const calls: Array<[NodeKey, number]> = [];
    const fetch: GraphFetchNode<FixtureNode> = async (key, depth) => {
      calls.push([key, depth]);
      return {
        key,
        depth,
        edges: (graph[key] ?? []).map((to) => ({ to })),
        source: "jira",
        label: `node ${key}`,
      };
    };
    const { nodes } = await crawlGraph(
      [{ key: "jira:PROJ-1" }],
      { maxDepth: 2, maxNodes: 10, hubThreshold: 12, concurrency: 2 },
      fetch,
    );

    expect(calls.filter(([key]) => key === "jira:PROJ-3")).toEqual([["jira:PROJ-3", 1]]);
    expect(nodes.get("jira:PROJ-3")?.depth).toBe(1);
  });

  test("rejects invalid edge depths instead of silently corrupting BFS order", async () => {
    const fetch = fakeGraphFetch({ "jira:PROJ-1": ["jira:PROJ-2"] });
    await expect(
      crawlGraph(
        [{ key: "jira:PROJ-1" }],
        {
          maxDepth: 2,
          maxNodes: 80,
          hubThreshold: 12,
          depthForEdge: () => 0,
        },
        fetch,
      ),
    ).rejects.toThrow(/depthForEdge/);
  });
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
      await setTimeout(5);
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
