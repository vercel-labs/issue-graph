import { describe, expect, test } from "vitest";
import { kindTag, prSummary, render, stateIcon, viaTag } from "./render.js";
import type { GraphNode, NodeKey, PullRequestMeta } from "./types.js";

const meta = (over: Partial<PullRequestMeta> = {}): PullRequestMeta => ({
  isDraft: false,
  reviewDecision: "REVIEW_REQUIRED",
  mergeable: "UNKNOWN",
  createdAt: "2026-04-01T00:00:00Z",
  mergedAt: "",
  updatedAt: "2026-04-24T00:00:00Z",
  additions: 9,
  deletions: 5,
  changedFiles: 1,
  files: ["src/cli-utils.ts"],
  ...over,
});

function node(key: NodeKey, over: Partial<GraphNode> = {}): GraphNode {
  return {
    key,
    owner: "o",
    repo: "r",
    number: Number(key.split("#")[1]),
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

describe("display helpers", () => {
  test("stateIcon covers the three states and unknown", () => {
    expect(stateIcon("MERGED")).toContain("MERGED");
    expect(stateIcon("WEIRD")).toContain("WEIRD");
  });
  test("kindTag and viaTag map to short labels", () => {
    expect(kindTag("PullRequest")).toBe("PR");
    expect(viaTag("cross-ref")).toBe("cross-ref");
    expect(viaTag("text")).toBe("mentions");
    expect(viaTag("sub-issue")).toBe("sub-issue of");
  });
});

describe("render", () => {
  test("single-seed graph shows nodes and orphan checklist", () => {
    const nodes = new Map([
      [
        "o/r#1",
        node("o/r#1", {
          depth: 0,
          state: "MERGED",
          kind: "PullRequest",
          edges: [{ to: "o/r#2", via: "closes" }],
        }),
      ],
      ["o/r#2", node("o/r#2", { verdict: "OPEN issue — related, untracked" })],
    ]);
    const md = render(nodes, ["o/r#1"], false);
    expect(md).toContain("# Reference graph: o/r#1");
    expect(md).toContain("## Nodes");
    expect(md).toContain("## Orphan checklist");
    expect(md).toContain("o/r#2");
  });

  test("multi-seed graph shows connected components", () => {
    const nodes = new Map([
      ["o/r#1", node("o/r#1", { depth: 0 })],
      ["o/r#9", node("o/r#9", { depth: 0 })],
    ]);
    const md = render(nodes, ["o/r#1", "o/r#9"], true);
    expect(md).toContain("Connected components: 2");
    expect(md).toContain("backlog slice");
  });

  test("flags a beyond-depth edge target", () => {
    const nodes = new Map([
      ["o/r#1", node("o/r#1", { depth: 0, edges: [{ to: "o/r#99", via: "text" }] })],
    ]);
    expect(render(nodes, ["o/r#1"], false)).toContain("beyond depth");
  });

  test("lists sub-issues that were not crawled as beyond depth", () => {
    const nodes = new Map([
      ["o/r#1", node("o/r#1", { depth: 0, hub: true, subIssues: ["o/r#2", "o/r#3"] })],
      ["o/r#2", node("o/r#2", { edges: [{ to: "o/r#1", via: "sub-issue" }] })],
    ]);
    const out = render(nodes, ["o/r#1"], false);
    expect(out).toContain("sub-issue of → o/r#1");
    expect(out).toContain("Beyond depth limit (1 refs not crawled)");
    expect(out).toContain("- o/r#3");
  });

  test("shows PR triage summary and derived flags", () => {
    const nodes = new Map([
      [
        "o/r#1",
        node("o/r#1", {
          depth: 0,
          kind: "PullRequest",
          pr: meta({ isDraft: true }),
          flags: ["competes with o/r#2 to close o/r#9"],
        }),
      ],
    ]);
    const md = render(nodes, ["o/r#1"], false);
    expect(md).toContain("review: REVIEW_REQUIRED");
    expect(md).toContain("DRAFT");
    expect(md).toContain("updated 2026-04-24");
    expect(md).toContain("⚠ competes with o/r#2");
  });

  test("prioritizes possibly superseded PRs in the orphan checklist", () => {
    const nodes = new Map([
      ["o/r#1", node("o/r#1", { depth: 0, state: "MERGED", kind: "PullRequest" })],
      [
        "o/r#2",
        node("o/r#2", {
          kind: "PullRequest",
          verdict:
            "POSSIBLY SUPERSEDED by merged o/r#1 via closed issue o/r#3 — verify scope, then close with credit",
        }),
      ],
    ]);
    const md = render(nodes, ["o/r#1"], false);
    expect(md).toContain("- [ ] ⚠️  o/r#2 PR");
  });

  test("renders the overlap section for PRs sharing files", () => {
    const nodes = new Map([
      ["o/r#1", node("o/r#1", { depth: 1, kind: "PullRequest", pr: meta() })],
      ["o/r#2", node("o/r#2", { depth: 1, kind: "PullRequest", pr: meta() })],
    ]);
    const md = render(nodes, ["o/r#seed"], false);
    expect(md).toContain("Possible duplicate / overlapping PRs");
    expect(md).toContain("src/cli-utils.ts");
  });
});

describe("prSummary", () => {
  test("summarizes review, size, and staleness", () => {
    const s = prSummary({ pr: meta({ mergeable: "CONFLICTING" }) } as GraphNode);
    expect(s).toContain("review: REVIEW_REQUIRED");
    expect(s).toContain("+9/-5 across 1f");
    expect(s).toContain("CONFLICTING");
  });
  test("empty for a non-PR node", () => {
    expect(prSummary({} as GraphNode)).toBe("");
  });
});
