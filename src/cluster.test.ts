import { describe, expect, test } from "vitest";
import { clusterJsonPrompt, parseClustersReply, renderClusters } from "./cluster.js";

describe("cluster JSON for the explorer", () => {
  const payload = [{ key: "o/r#1", kind: "issue", state: "OPEN", title: "t", edges: [] }];

  test("prompt asks for the --clusters shape and keeps the node list", () => {
    const p = clusterJsonPrompt("o/r", payload);
    expect(p).toContain('"clusters"');
    expect(p).toContain("- o/r#1 | issue | OPEN | t");
    expect(p).not.toContain("OUTPUT (markdown");
  });

  test("reply parsing tolerates surrounding prose", () => {
    const got = parseClustersReply(
      'Here you go:\n{"clusters":[{"label":"A","members":[{"key":"o/r#1"}]}],"cleanup":[]}\nDone.',
    );
    expect(got.clusters[0].label).toBe("A");
    expect(renderClusters(got)).toContain("| A |  | 1 |");
  });

  test("reply without clusters is an error, not an empty dashboard", () => {
    expect(() => parseClustersReply("no json")).toThrow(/no JSON/);
    expect(() => parseClustersReply('{"groups":[]}')).toThrow(/no clusters/);
  });
});
