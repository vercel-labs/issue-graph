import { describe, expect, test } from "vitest";
import { scoring } from "../../../src/scoring";
import { defaultWeights, heatScore, showcase } from "../src/lib/showcase";

describe("landing showcase", () => {
  test("scores Heat exactly like the CLI", () => {
    expect(defaultWeights).toEqual(scoring.defaults);
    const custom = { comments: 0, participants: 7, reactions: 1, inboundRefs: 10, age: 4 };
    for (const item of showcase.items) {
      expect(heatScore(item.heat)).toBe(scoring.score(item.heat));
      expect(heatScore(item.heat, custom)).toBe(scoring.score(item.heat, custom));
    }
  });

  test("keeps clusters, members, and edges consistent with a real capture", () => {
    const numbers = new Set(showcase.items.map((item) => item.number));
    expect(showcase.clusters.length).toBeGreaterThanOrEqual(4);
    expect(showcase.clusters.length).toBeLessThanOrEqual(showcase.clusterCount);
    showcase.clusters.forEach((cluster, index) => {
      expect(cluster.size).toBe(cluster.members.length);
      expect(cluster.rootCause).not.toBe("");
      for (const n of cluster.members) {
        expect(showcase.items.find((item) => item.number === n)?.cluster).toBe(index);
      }
    });
    for (const [a, b] of showcase.edges) {
      expect(numbers.has(a) && numbers.has(b)).toBe(true);
    }
    for (const item of showcase.items) {
      expect(item.url).toBe(
        `https://github.com/${showcase.repo}/${item.kind === "PullRequest" ? "pull" : "issues"}/${item.number}`,
      );
    }
    expect(showcase.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
