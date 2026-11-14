import { runInNewContext } from "node:vm";
import { describe, expect, test } from "vitest";
import { clusterPayload, clusterPrompt } from "./cluster.js";
import { createDashboardFilterEngine } from "./dashboard-filters.js";
import { createGraphMetrics } from "./dashboard-query.js";
import { dashboardModel, renderDashboard } from "./html.js";
import { humanPresentation } from "./human-output.js";
import { render } from "./render.js";
import type { Edge, GraphNode, NodeKey } from "./types.js";

const issue = (n: number, edges: Edge[], extra: Partial<GraphNode> = {}): GraphNode => ({
  key: `o/r#${n}`,
  owner: "o",
  repo: "r",
  number: n,
  kind: "Issue",
  title: `Issue ${n}`,
  state: "OPEN",
  url: `https://github.com/o/r/issues/${n}`,
  depth: n === 10 ? 0 : 1,
  edges,
  externalLinks: [],
  fetched: true,
  ...extra,
});

/** Epic #10 lists #11 and #12; #12 reports #10 back; #13 names a parent outside the graph. */
const epic = (): Map<NodeKey, GraphNode> =>
  new Map(
    [
      issue(10, [
        { to: "o/r#11", via: "parent-of" },
        { to: "o/r#12", via: "parent-of" },
      ]),
      issue(11, [], { state: "CLOSED" }),
      issue(12, [{ to: "o/r#10", via: "child-of" }]),
      issue(13, [{ to: "o/r#99", via: "child-of" }], { subIssuesUnreadable: 2 }),
      issue(14, [], { subIssuesPastLimit: 30 }),
    ].map((n) => [n.key, n]),
  );

describe("reports", () => {
  test("markdown names the link from each end", () => {
    const out = render(epic(), ["o/r#10"], false);
    expect(out).toContain("    - parent of → o/r#11 🟣 CLOSED");
    expect(out).toContain("    - child of → o/r#10 🟢 OPEN");
    expect(out).toContain("    - child of → o/r#99 _(beyond depth)_");
    expect(out).not.toMatch(/parent-of|child-of/);
    expect(out).toMatch(
      /\*\*o\/r#13\*\*[^\n]*\n(?: {4}- [^\n]*\n)* {4}- sub-issues: 2 returned no data \(no access or removed\)\n/,
    );
    expect(out).toMatch(
      /\*\*o\/r#14\*\*[^\n]*\n {4}- sub-issues: 30 more not read \(first 50 per node\)\n/,
    );
    expect(out).not.toContain("per-node limit");
  });

  test("the terminal view keeps each link under its own item", () => {
    const rows = humanPresentation(render(epic(), ["o/r#10"], false), "graph");
    const details = (reference: string) => {
      const row = rows.find((r) => r.kind === "item" && r.reference === reference);
      return row?.kind === "item" ? row.details : undefined;
    };
    expect(details("#10")).toEqual(expect.arrayContaining(["parent of → #12 OPEN"]));
    expect(details("#12")).toEqual(expect.arrayContaining(["child of → #10 OPEN"]));
    expect(details("#14")).toEqual(["sub-issues: 30 more not read (first 50 per node)"]);
  });

  test("the clustering prompt carries the edges and says what they mean", () => {
    const payload = clusterPayload(epic(), ["o/r#10"]);
    expect(payload.find((p) => p.key === "o/r#12")?.edges).toEqual(["child-of o/r#10"]);
    expect(clusterPrompt("o/r", payload)).toContain(
      "parent-of and child-of are the two ends of a sub-issue link",
    );
  });
});

describe("dashboard", () => {
  test("the model keeps one parent-to-child entry per pair, whichever end reported it", () => {
    const { nodes } = dashboardModel(epic(), ["o/r#10"], "o/r");
    expect(nodes["o/r#10"].out).toEqual([
      { to: "o/r#11", via: "parent of", undirected: false },
      { to: "o/r#12", via: "parent of", undirected: false },
    ]);
    expect(nodes["o/r#10"].in).toEqual([]);
    expect(nodes["o/r#12"].out).toEqual([]);
    expect(nodes["o/r#12"].in).toEqual([{ from: "o/r#10", via: "child of" }]);
    expect(nodes["o/r#13"].out).toEqual([{ to: "o/r#99", via: "child of", undirected: false }]);
    expect(nodes["o/r#10"].heat?.inboundRefs).toBe(0);
  });

  test("a mention between linked issues keeps its own entry and its inbound reference", () => {
    const nodes = new Map(
      [
        issue(10, [
          { to: "o/r#11", via: "text", by: "ana" },
          { to: "o/r#11", via: "parent-of" },
        ]),
        issue(11, [{ to: "o/r#10", via: "child-of" }]),
      ].map((n) => [n.key, n]),
    );
    const model = dashboardModel(nodes, ["o/r#10"], "o/r").nodes;
    expect(model["o/r#10"].out).toEqual([
      { to: "o/r#11", via: "text", by: "ana", at: undefined },
      { to: "o/r#11", via: "parent of", undirected: false },
    ]);
    expect(model["o/r#11"].in).toEqual([
      { from: "o/r#10", via: "text", by: "ana" },
      { from: "o/r#10", via: "child of" },
    ]);
    expect(model["o/r#11"].heat?.inboundRefs).toBe(1);
  });

  test("a sub-issue link is not a solution for the filter engine", () => {
    const model = dashboardModel(epic(), ["o/r#10"], "o/r");
    const result = createDashboardFilterEngine().evaluate(model, { solution: "with" }, () => 0);
    expect([...result.matches]).toEqual([]);
  });

  test("open sub-issues count as connections for links, blast and impact", () => {
    const model = dashboardModel(epic(), ["o/r#10"], "o/r");
    const graph = createGraphMetrics(model);
    expect([...graph.neighbors("o/r#10")]).toEqual(["o/r#11", "o/r#12"]);
    expect([...graph.neighbors("o/r#12")]).toEqual(["o/r#10"]);
    expect([...graph.blastRadius("o/r#10").followups]).toEqual(["o/r#12"]);
    expect([...graph.blastRadius("o/r#12").followups]).toEqual(["o/r#10"]);
    expect(graph.blastRadius("o/r#10").prs.size).toBe(0);
    expect(graph.impactRows(new Set(Object.keys(model.nodes))).map((r) => [r.k, r.score])).toEqual([
      ["o/r#10", 1],
      ["o/r#12", 1],
    ]);
    expect(model.nodes["o/r#10"].heat?.inboundRefs).toBe(0);
  });

  test("the shipped view labels both ends and draws a single arrow", () => {
    const model = dashboardModel(epic(), ["o/r#10"], "o/r");
    const html = renderDashboard([model]);
    const script = html.slice(html.lastIndexOf("<script>") + 8, html.lastIndexOf("</script>"));
    const inspect = (k: string) =>
      `(()=>{let pane='';renderMain=(h)=>{pane=h};inspector(${JSON.stringify(k)});return pane})()`;
    const everything = JSON.stringify({ state: "all", kind: "all", heatMode: "all" });
    const probe = `
      F=${everything};computeFilters();
      app.querySelectorAll=()=>[];
      return {
        epicPane:${inspect("o/r#10")},
        childPane:${inspect("o/r#12")},
        childEgo:egoSvg(N["o/r#12"]),
        links:layoutCluster(["o/r#10","o/r#11","o/r#12"],400,300).links,
        prs:[...blastRadius("o/r#10").prs],
      };`;
    const view = runInNewContext(script.replace('app.className = "";', probe), {
      document: {
        getElementById: (id: string) =>
          id === "data" ? { textContent: JSON.stringify({ projects: [model] }) } : {},
      },
      location: { href: "https://example.invalid/", search: "" },
      window: { addEventListener() {} },
      localStorage: { getItem: () => null },
      URL,
      URLSearchParams,
      AbortController,
    });
    expect(view.epicPane).toContain('<span class="via via-parent-of">parent of</span>');
    expect(view.childPane).toContain('<span class="via via-child-of">child of</span>');
    expect(view.childPane.match(/via-child-of/g)).toHaveLength(1);
    expect(view.childEgo).toContain("child of #10");
    expect(view.links).toEqual([
      ["o/r#10", "o/r#11", "parent of", true],
      ["o/r#10", "o/r#12", "parent of", true],
    ]);
    expect(view.prs).toEqual([]);
  });
});
