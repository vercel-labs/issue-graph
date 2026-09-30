import { describe, expect, test } from "vitest";
import {
  applyClusters,
  carriedClusters,
  dashboardModel,
  renderDashboard,
  renderHtml,
} from "./html.js";
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
    expect(html).toContain("<title>issue-graph · o/r</title>");
    expect(html).toContain('class="brand-name">issue-graph</span>');
    expect(html).toContain('id="data"');
    expect(html).toContain("o/r#2");
    expect(html).toContain('id="impact-view"');
    expect(html).toContain("Pick one to see its ripple");
    expect(html).toContain('id="rank-view"');
    expect(html).toContain("function exploreView(gi)");
    expect(html).toContain('"provider":{"id":"github"');
    expect(html).toContain('"repo":"o/r"');
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
    expect(html).toContain("Issues it resolves");
    expect(html).toContain("PRs to reconcile");
    expect(html).toContain("A projection from visible links, not proof.");
  });
});

describe("renderDashboard", () => {
  test("embeds every project and opens the first", () => {
    const a = dashboardModel(asMap([node("o/a#1")]), ["o/a#1"], "o/a");
    const b = dashboardModel(asMap([node("o/b#2")]), ["o/b#2"], "o/b");
    const html = renderDashboard([a, b]);
    const data = JSON.parse(
      html.split('<script id="data" type="application/json">')[1].split("</script>")[0],
    );
    expect(data.projects.map((p: { repo: string }) => p.repo)).toEqual(["o/a", "o/b"]);
    expect(html).toContain("<title>issue-graph · o/a</title>");
    expect(html).toContain("function setProject(");
  });

  test("refuses an empty project list", () => {
    expect(() => renderDashboard([])).toThrow(/at least one model/);
  });
});

test("a --clusters entry without members is skipped instead of crashing", () => {
  const nodes = asMap([node("o/r#1")]);
  const html = renderHtml(nodes, ["o/r#1"], "o/r", {
    clusters: [{ label: "Broken" } as never, { label: "Good", members: [{ key: "o/r#1" }] }],
  });
  expect(html).toContain("Good");
  expect(html).not.toContain('"label":"Broken"');
});

describe("applyClusters", () => {
  const model = dashboardModel(
    asMap([node("o/r#1"), node("o/r#2"), node("o/r#3")]),
    ["o/r#1"],
    "o/r",
  );

  test("groups a saved run, keeps the rest in Ungrouped, and lets the cluster verdict win", () => {
    const { model: next, unknown } = applyClusters(model, {
      clusters: [
        {
          label: "A",
          root_cause: "why",
          members: [{ key: "o/r#1", verdict: "close it" }, { key: "o/r#2" }],
        },
      ],
      cleanup: [{ key: "o/r#2", text: "retest" }],
    });
    expect(unknown).toEqual([]);
    expect(next.groups.map((g) => [g.label, g.members])).toEqual([
      ["A", ["o/r#1", "o/r#2"]],
      ["Ungrouped", ["o/r#3"]],
    ]);
    expect(next.nodes["o/r#1"].verdict).toBe("close it");
    expect(next.cleanup).toEqual([{ key: "o/r#2", text: "retest" }]);
    expect(model.nodes["o/r#1"].verdict).not.toBe("close it");
  });

  test("reports keys the run does not contain", () => {
    const { unknown } = applyClusters(model, {
      clusters: [{ label: "A", members: [{ key: "o/r#9" }] }],
    });
    expect(unknown).toEqual(["o/r#9"]);
  });
});

describe("carriedClusters", () => {
  test("keeps clusters for items still in the graph when a new run brings none", () => {
    const previous = dashboardModel(
      asMap([node("o/r#1"), node("o/r#2"), node("o/r#3")]),
      [],
      "o/r",
      {
        clusters: [
          {
            label: "Daemon",
            root_cause: "sessions",
            members: [{ key: "o/r#1" }, { key: "o/r#2" }],
          },
          { label: "Gone", members: [{ key: "o/r#3" }] },
        ],
        cleanup: [
          { key: "o/r#3", text: "close" },
          { key: "o/r#1", text: "retest" },
        ],
      },
    );
    const next = asMap([node("o/r#1"), node("o/r#4")]);
    const carried = carriedClusters(previous, next);
    const model = dashboardModel(next, [], "o/r", carried);

    expect(model.grouping).toBe("themes");
    expect(model.groups.map((group) => [group.label, group.members])).toEqual([
      ["Daemon", ["o/r#1"]],
      ["Ungrouped", ["o/r#4"]],
    ]);
    expect(model.cleanup).toEqual([{ key: "o/r#1", text: "retest" }]);
  });

  test("carries nothing from an unclustered run", () => {
    const previous = dashboardModel(asMap([node("o/r#1")]), [], "o/r");
    expect(carriedClusters(previous, asMap([node("o/r#1")]))).toBeUndefined();
    expect(carriedClusters(undefined, asMap([node("o/r#1")]))).toBeUndefined();
  });
});
