import { execFileSync } from "node:child_process";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { clusterJsonPrompt, parseClustersReply, renderClusters, runAgent } from "./cluster.js";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn(() => "agent reply") }));

beforeEach(() => vi.clearAllMocks());

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

test("reply with a cluster missing members is rejected, so the explorer falls back", () => {
  expect(() => parseClustersReply('{"clusters":[{"label":"A"}]}')).toThrow(/no members array/);
});

test("runs Codex with the requested model and reasoning effort", () => {
  expect(
    runAgent("codex", "cluster this graph", {
      model: "gpt-6-luna",
      reasoningEffort: "high",
    }),
  ).toBe("agent reply");
  expect(execFileSync).toHaveBeenCalledWith(
    "codex",
    ["exec", "--model", "gpt-6-luna", "--config", 'model_reasoning_effort="high"', "-"],
    expect.objectContaining({ input: "cluster this graph", encoding: "utf8" }),
  );
});
