import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { prepareExample } from "../scripts/prepare-example";
import graph from "../src/lib/example-graph.json";
import { workflows } from "../src/lib/landing-content";
import { exampleCommand, packageReleasePending, repositoryIsPublic } from "../src/lib/site";

function preparationInput() {
  return {
    source: {
      seeds: [graph.seed],
      depth: graph.limits.depth,
      cappedOut: [] as string[],
      nodes: graph.nodes.map((node) => ({
        ...node,
        repo: node.repository,
        fetched: true,
        edges: graph.edges
          .filter((edge) => edge.from === node.key)
          .map((edge) => ({ to: edge.to, via: edge.via })),
      })),
    },
    capture: {
      repository: graph.repository,
      visibility: graph.repositoryVisibility,
      visibilityCheckedAt: graph.visibilityCheckedAt,
      startedAt: graph.captureStartedAt,
      completedAt: graph.capturedAt,
      cliVersion: graph.cliVersion,
      exitCode: 0,
      args: [...graph.command.split(" ").slice(1), "--json", "graph.json"],
    },
  };
}

describe("public launch proof", () => {
  test("uses an explicitly bounded public single-repository capture", () => {
    expect(Number.isFinite(Date.parse(graph.capturedAt))).toBe(true);
    expect(Date.parse(graph.visibilityCheckedAt)).toBeLessThanOrEqual(
      Date.parse(graph.captureStartedAt),
    );
    expect(Date.parse(graph.captureStartedAt)).toBeLessThanOrEqual(Date.parse(graph.capturedAt));
    expect(graph.repository).toBe("vercel-labs/agent-browser");
    expect(graph.repositoryVisibility).toBe("PUBLIC");
    expect(graph.cliVersion).toBe("0.2.0");
    expect(graph.command).toBe(
      "issue-graph 1113 --repo vercel-labs/agent-browser --depth 1 --max-nodes 12 --no-snapshot",
    );
    expect(graph.limits).toEqual({ depth: 1, maxNodes: 12, hubThreshold: 12, concurrency: 4 });
    expect(graph.coverage).toMatchObject({
      completeHistory: false,
      allCapturedNodesIncluded: true,
      capturedNodes: 5,
      omittedNodes: 0,
      crossRepoNodesFiltered: 0,
      cappedNodes: 0,
      unexpandedHubs: 0,
      beyondDepthReferences: 19,
      omittedEdges: 22,
    });
    expect(graph.coverage.note).toContain("not complete history");
  });

  test("retains issue/PR kinds and typed edges without attribution or external metadata", () => {
    expect(graph.nodes).toHaveLength(5);
    expect(graph.edges).toHaveLength(14);
    const keys = new Set(graph.nodes.map((node) => node.key));
    expect(keys.size).toBe(graph.nodes.length);
    expect(keys.has(graph.seed)).toBe(true);
    expect(new Set(graph.nodes.map((node) => node.kind))).toEqual(
      new Set(["Issue", "PullRequest"]),
    );
    for (const node of graph.nodes) {
      expect(Object.keys(node).sort()).toEqual([
        "key",
        "kind",
        "number",
        "repository",
        "state",
        "title",
        "url",
      ]);
      expect(node.key).toBe(`${graph.repository}#${node.number}`);
      expect(node.repository).toBe("agent-browser");
      expect(["OPEN", "CLOSED", "MERGED"]).toContain(node.state);
      expect(node.url).toBe(
        `https://github.com/${graph.repository}/${node.kind === "Issue" ? "issues" : "pull"}/${node.number}`,
      );
    }
    for (const edge of graph.edges) {
      expect(Object.keys(edge).sort()).toEqual(["from", "to", "via"]);
      expect(keys.has(edge.from)).toBe(true);
      expect(keys.has(edge.to)).toBe(true);
      expect(["text", "cross-ref", "connected", "closes"]).toContain(edge.via);
    }
    expect(graph.edges).toContainEqual({
      from: "vercel-labs/agent-browser#1137",
      to: graph.seed,
      via: "closes",
    });
    expect(graph.nodes.find((node) => node.number === 1137)?.state).toBe("MERGED");
    expect(graph.nodes.filter((node) => node.state === "OPEN").map((node) => node.number)).toEqual([
      1371, 1607,
    ]);
  });

  test("labels the terminal excerpt and preserves the actionable CLI checklist", () => {
    expect(graph.terminalExcerpt).toMatchObject({
      source: "CLI stdout",
      excerpt: true,
      attributionRemoved: true,
    });
    expect(graph.terminalExcerpt.stdoutSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(graph.terminalOutput).toContain(`# Reference graph: ${graph.seed}`);
    expect(graph.terminalOutput).toContain(`Nodes: ${graph.nodes.length}`);
    expect(graph.terminalOutput).toContain("## Orphan checklist (classified)");
    expect(graph.terminalOutput).toContain("referenced by merged work, verify if resolved");
    expect(graph.terminalOutput).toContain("OPEN issue — related, untracked");
    expect(graph.terminalOutput).toContain(`closes → ${graph.seed}`);
    for (const node of graph.nodes) expect(graph.terminalOutput).toContain(`**${node.key}**`);
    expect(graph.terminalOutput).not.toMatch(/@|https?:\/\/|mentioned by:|external →/);
    const references = graph.terminalOutput.match(/[\w.-]+\/[\w.-]+#\d+/g) ?? [];
    expect(references.every((key) => graph.nodes.some((node) => node.key === key))).toBe(true);
  });

  test("preparation allowlists fields and removes attribution from real output lines", () => {
    const { source, capture } = preparationInput();
    const annotated = graph.terminalOutput
      .replace("  _(depth 0)_", " _by @fixture-account_  _(depth 0)_")
      .replace(
        `closes → ${graph.seed} 🟣 CLOSED`,
        `closes → ${graph.seed} 🟣 CLOSED _(@fixture-account, 2026-09-22)_`,
      )
      .replace("## Nodes\n", "## Nodes\n    - mentioned by: @fixture-account\n")
      .concat("- [ ] external (unread) — https://example.com\n");
    const output = prepareExample(
      {
        ...source,
        nodes: source.nodes.map((node) => ({
          ...node,
          author: "fixture-account",
          comments: ["must not be published"],
          externalLinks: ["https://example.com"],
        })),
      },
      annotated,
      capture,
    );
    expect(output.nodes).toEqual(graph.nodes);
    expect(output.edges).toEqual(graph.edges);
    expect(output.terminalOutput).toBe(graph.terminalOutput);
    expect(JSON.stringify(output)).not.toContain("fixture-account");
    expect(JSON.stringify(output)).not.toContain("must not be published");
    expect(JSON.stringify(output)).not.toContain("https://example.com");
  });

  test("preparation rejects unverified, cross-repository, capped or failed captures", () => {
    const { source, capture } = preparationInput();
    for (const patch of [
      { visibility: "PRIVATE" },
      { exitCode: 1 },
      { completedAt: "invalid" },
      { args: [...capture.args, "--cluster"] },
    ]) {
      expect(() =>
        prepareExample(source, graph.terminalOutput, { ...capture, ...patch }),
      ).toThrow();
    }
    expect(() =>
      prepareExample({ ...source, cappedOut: ["omitted#1"] }, graph.terminalOutput, capture),
    ).toThrow();
    for (const patch of [
      { key: "another/repository#1113" },
      { fetched: false },
      { hub: true },
      { kind: "Unknown" },
      { url: "https://example.com/issues/1113" },
    ]) {
      expect(() =>
        prepareExample(
          { ...source, nodes: [{ ...source.nodes[0], ...patch }, ...source.nodes.slice(1)] },
          graph.terminalOutput,
          capture,
        ),
      ).toThrow();
    }
    expect(() => prepareExample(source, "invented output", capture)).toThrow();
  });

  test("integrates the captured command and published package with site constants", () => {
    expect.soft(graph.command).toBe(exampleCommand);
    expect.soft(packageReleasePending).toBe(false);
    expect(repositoryIsPublic).toBe(false);
    for (const workflow of workflows) {
      expect(workflow.command.startsWith("issue-graph ")).toBe(true);
      expect(workflow.href.startsWith("/docs/")).toBe(true);
    }
  });

  test("ships a self-contained accessible terminal visual from the same capture", () => {
    const svg = readFileSync(new URL("../public/issue-graph-demo.svg", import.meta.url), "utf8");
    expect(svg).toContain("<title");
    expect(svg).toContain("<desc");
    expect(svg).toMatch(/width="1200" height="\d+"/);
    expect(svg).toContain("issue-graph / terminal");
    expect(svg).toContain(`$ ${graph.command}`);
    expect(svg).toContain(graph.capturedAt);
    expect(svg).toContain("## Orphan checklist (classified)");
    expect(svg).toContain("19 beyond-depth references omitted");
    expect(svg).toContain("not complete history");
    expect(svg).not.toContain("<script");
    expect(svg).not.toContain("<foreignObject");
    expect(svg).not.toContain("href=");
    expect(svg).not.toContain("@fixture-account");
  });
});
