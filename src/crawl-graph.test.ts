import { expect, test } from "vitest";
import { crawlGraph } from "./crawl.js";
import type { CrawlNode } from "./types.js";

const bounds = { maxDepth: 3, maxNodes: 10, hubThreshold: 12, concurrency: 2 };

test("generic traversal preserves provider data and accepts opaque identities", async () => {
  const report = await crawlGraph([{ key: "workspace:a" }], bounds, async (key, depth) => ({
    key,
    depth,
    edges: key === "workspace:a" ? [{ to: "workspace:b" }] : [],
    nativeStatus: "Under discussion",
  }));
  expect([...report.nodes.keys()]).toEqual(["workspace:a", "workspace:b"]);
  expect(report.nodes.get("workspace:b")?.nativeStatus).toBe("Under discussion");
});

test("generic traversal rejects a hydrated node for another identity", async () => {
  await expect(
    crawlGraph([{ key: "a" }], bounds, async (_key, depth) => ({ key: "b", depth, edges: [] })),
  ).rejects.toThrow("requested key");
});

test("depth policy candidates are lowered when a shorter path is discovered", async () => {
  const graph: Record<string, string[]> = { a: ["b", "c"], b: ["c"], c: ["d"], d: [] };
  const report = await crawlGraph(
    [{ key: "a" }],
    {
      ...bounds,
      depthForEdge: ({ sourceKey, edge, sourceDepth }) =>
        sourceKey === "a" && edge.to === "c" ? 3 : sourceDepth + 1,
    },
    async (key, depth): Promise<CrawlNode> => ({
      key,
      depth,
      edges: graph[key].map((to) => ({ to })),
    }),
  );
  expect([...report.nodes.values()].map(({ key, depth }) => [key, depth])).toEqual([
    ["a", 0],
    ["b", 1],
    ["c", 2],
    ["d", 3],
  ]);
});
