import { describe, expect, test } from "bun:test";
import { renderHtml } from "./html.js";
import type { GraphNode, NodeKey, PullRequestMeta } from "./types.js";

const meta = (files: string[]): PullRequestMeta => ({
  isDraft: false,
  reviewDecision: "REVIEW_REQUIRED",
  mergeable: "UNKNOWN",
  createdAt: "2026-04-01T00:00:00Z",
  mergedAt: "",
  updatedAt: "2026-04-24T00:00:00Z",
  additions: 9,
  deletions: 5,
  changedFiles: files.length,
  files,
});

function node(key: NodeKey, over: Partial<GraphNode> = {}): GraphNode {
  const [ownerRepo, num] = key.split("#");
  const [owner, repo] = ownerRepo.split("/");
  return {
    key,
    owner,
    repo,
    number: Number(num),
    kind: "Issue",
    title: `title ${key}`,
    state: "OPEN",
    url: `https://github.com/${owner}/${repo}/issues/${num}`,
    depth: 1,
    edges: [],
    externalLinks: [],
    fetched: true,
    ...over,
  };
}

const asMap = (ns: GraphNode[]) => new Map(ns.map((n) => [n.key, n]));

describe("renderHtml", () => {
  test("emits a self-contained document with the embedded model", () => {
    const nodes = asMap([
      node("o/r#1", { depth: 0 }),
      node("o/r#2", {
        kind: "PullRequest",
        edges: [{ to: "o/r#1", via: "closes" }],
        pr: meta(["src/a.ts"]),
      }),
    ]);
    const html = renderHtml(nodes, ["o/r#1"], "o/r");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('id="data"');
    expect(html).toContain("o/r#2");
    expect(html).toContain('id="impact-view"');
    expect(html).toContain("Click a node to simulate its blast radius");
    // no raw </script> break-out from data
    expect(html.split('<script id="data"')[1].split("</script>")[0]).not.toContain("</script");
  });

  test("embeds agent clusters as groups and applies member verdicts", () => {
    const nodes = asMap([node("o/r#1"), node("o/r#2", { kind: "PullRequest" })]);
    const html = renderHtml(nodes, ["o/r#1"], "o/r", [
      {
        label: "My Cluster",
        root_cause: "shared bug",
        members: [{ key: "o/r#2", verdict: "merge it" }],
      },
    ]);
    expect(html).toContain("My Cluster");
    expect(html).toContain("merge it");
  });

  test("escapes angle brackets in the embedded JSON", () => {
    const nodes = asMap([node("o/r#1", { title: "a <script>alert(1)</script> b" })]);
    const html = renderHtml(nodes, ["o/r#1"], "o/r");
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("\\u003cscript>alert(1)");
  });

  test("includes graph-derived impact projection behavior", () => {
    const nodes = asMap([
      node("o/r#1", { depth: 0 }),
      node("o/r#2", {
        kind: "PullRequest",
        flags: ["claims to close o/r#1 but no closing link"],
        edges: [{ to: "o/r#1", via: "cross-ref" }],
        pr: meta(["src/a.ts"]),
      }),
    ]);
    const html = renderHtml(nodes, ["o/r#1"], "o/r");
    expect(html).toContain("function blastRadius(k)");
    expect(html).toContain("function neighbors(k)");
    expect(html).toContain("issues resolved");
    expect(html).toContain("PRs to reconcile");
    expect(html).toContain("projection, not proof");
  });
});
