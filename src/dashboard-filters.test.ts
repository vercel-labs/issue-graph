import { runInNewContext } from "node:vm";
import { describe, expect, test } from "vitest";
import { createDashboardFilterEngine } from "./dashboard-filters.js";
import { type ClientNode, dashboardModel, type Model, renderDashboard } from "./html.js";
import type { NodeKey } from "./types.js";

const engine = createDashboardFilterEngine();
const key = (id: number): NodeKey => `test/project#${id}`;
const score = (n: ClientNode) => n.heat?.comments ?? 0;
function item(id: number, value: number, patch: Partial<ClientNode> = {}): ClientNode {
  return {
    repo: "test/project",
    key: key(id),
    num: id,
    kind: "Issue",
    state: "OPEN",
    title: `Item ${id}`,
    url: "",
    depth: 0,
    seed: true,
    flags: [],
    mentionedBy: [],
    external: [],
    out: [],
    in: [],
    overlaps: [],
    heat: { comments: value, participants: 0, reactions: 0, inboundRefs: 0, daysOpen: 0 },
    ...patch,
  };
}
function model(nodes: ClientNode[] = [item(1, 100), item(2, 80), item(3, 80), item(4, 20)]): Model {
  return {
    ...dashboardModel(new Map(), [], "test/project"),
    nodes: Object.fromEntries(nodes.map((n) => [n.key, n])),
    groups: [
      { label: "Browser", subtitle: "", members: [key(1), key(2)] },
      { label: "Runtime", subtitle: "", members: [key(2), key(3), key(4)] },
    ],
  };
}
const keys = (m: Model, filters: unknown) => [...engine.evaluate(m, filters, score).matches];
const pr = (id: number, patch: Partial<ClientNode> = {}): ClientNode =>
  item(id, 10, {
    kind: "PullRequest",
    pr: {
      draft: false,
      review: "none",
      mergeable: "MERGEABLE",
      updated: "",
      adds: 1,
      dels: 0,
      files: 1,
    },
    ...patch,
  });

test("clusters union with each other and intersect state, type, search and minimum heat", () => {
  const m = model([
    item(1, 100),
    item(2, 80, { title: "Runtime crash", author: "Ada" }),
    item(3, 80, { state: "CLOSED" }),
    pr(4),
  ]);
  expect(keys(m, { clusters: [0, 1] })).toEqual([key(1), key(2), key(3), key(4)]);
  expect(
    keys(m, {
      state: "open",
      kind: "Issue",
      clusters: [1],
      query: " ADA ",
      heatMode: "min",
      heatMin: 80,
    }),
  ).toEqual([key(2)]);
  expect(keys(m, { clusters: [0], heatMode: "min", heatMin: 81 })).toEqual([key(1)]);
  expect(keys(m, { query: "missing" })).toEqual([]);
  expect(keys(model([]), { state: "open" })).toEqual([]);
});

test("percentile includes boundary ties and ignores cluster, query and solution filters", () => {
  const m = model([
    item(1, 100),
    item(2, 80),
    item(3, 80),
    item(4, 20),
    item(5, 10),
    item(6, 5),
    item(7, 2),
    item(8, 0),
    item(9, 999, { repo: "other/project" }),
    item(10, 999, { state: "CLOSED" }),
  ]);
  const result = engine.evaluate(m, { heatMode: "top25" }, score);
  expect(result.threshold).toBe(80);
  expect(result.baselineCount).toBe(8);
  expect([...result.matches]).toEqual([key(1), key(2), key(3), key(9)]);
  const narrowed = engine.evaluate(
    m,
    { heatMode: "top25", clusters: [1], query: "Item 3", solution: "without" },
    score,
  );
  expect(narrowed.threshold).toBe(80);
  expect([...narrowed.matches]).toEqual([key(3)]);
  expect(engine.evaluate(m, { heatMode: "top10" }, score).threshold).toBe(100);
});

test("percentiles are scoped to type and recompute with score weights", () => {
  const m = model([item(1, 100), item(2, 20), pr(3), pr(4)]);
  expect(engine.evaluate(m, { kind: "PullRequest", heatMode: "top25" }, score).threshold).toBe(10);
  expect(
    engine.evaluate(m, { kind: "Issue", heatMode: "top25" }, (n) => score(n) * 2).threshold,
  ).toBe(200);
});

test("missing heat, unavailable, archived and closed items never become zero-heat candidates", () => {
  const m = model([
    item(1, 0),
    item(2, 0, { heat: undefined }),
    item(3, 200, { archived: true }),
    item(4, 200, { state: "FETCH_ERROR" }),
    item(5, 200, { state: "CLOSED" }),
  ]);
  expect(keys(m, { heatMode: "min", heatMin: 0 })).toEqual([key(1)]);
  expect(keys(m, { state: "archived" })).toEqual([key(3)]);
  expect(keys(m, { state: "unavailable" })).toEqual([key(4)]);
  expect(keys(m, { state: "closed" })).toEqual([key(5)]);
  expect(
    engine.evaluate(model([item(1, 10, { state: "CLOSED" })]), { heatMode: "top25" }, score).matches
      .size,
  ).toBe(0);
});

test("solution evidence survives hiding the PR, ignores mentions and closed unmerged PRs", () => {
  const m = model([
    item(1, 100),
    item(2, 90),
    item(3, 80),
    item(4, 70),
    pr(5, { out: [{ to: key(1), via: "closes" }] }),
    pr(6, { out: [{ to: key(2), via: "mentions" }] }),
    pr(7, { state: "CLOSED", out: [{ to: key(3), via: "closes" }] }),
    pr(8, { state: "MERGED", out: [{ to: key(4), via: "closes" }] }),
  ]);
  expect(keys(m, { kind: "Issue", solution: "with" })).toEqual([key(1), key(4)]);
  expect(keys(m, { kind: "Issue", solution: "without" })).toEqual([key(2), key(3)]);
  expect(keys(m, { query: "Item 1", solution: "with", clusters: [0] })).toEqual([key(1)]);
  const inbound = model([item(1, 100, { in: [{ from: key(2), via: "closes" }] }), pr(2)]);
  expect(keys(inbound, { solution: "with" })).toEqual([key(1)]);
});

describe("review facets preserve independent PR states", () => {
  const base = {
    draft: false,
    review: "none",
    mergeable: "MERGEABLE",
    updated: "",
    adds: 1,
    dels: 0,
    files: 1,
  };
  const m = model([
    pr(1),
    pr(2, { pr: { ...base, review: "REVIEW_REQUIRED" } }),
    pr(3, { pr: { ...base, draft: true } }),
    pr(4, { pr: { ...base, review: "APPROVED" } }),
    pr(5, { pr: { ...base, review: "CHANGES_REQUESTED" } }),
    pr(6, { pr: { ...base, mergeable: "CONFLICTING", review: "UNKNOWN" } }),
    pr(7, { state: "CLOSED" }),
    item(8, 100),
  ]);
  test.each([
    ["pending", [1, 2]],
    ["approved", [4]],
    ["changes", [5]],
    ["draft", [3]],
    ["conflicts", [6]],
  ])("%s", (review, ids) => {
    expect(keys(m, { review })).toEqual((ids as number[]).map(key));
  });
});

test("provider capabilities remove unavailable facets without filtering out real work", () => {
  const m = model([item(1, 0, { heat: undefined })]);
  m.provider = { ...m.provider, id: "custom", filters: [], metrics: ["links", "depth"] };
  const result = engine.evaluate(
    m,
    { heatMode: "min", heatMin: 500, solution: "with", review: "pending" },
    score,
  );
  expect(result.filters).toMatchObject({ heatMode: "all", solution: "all", review: "all" });
  expect([...result.matches]).toEqual([key(1)]);
  expect(result.capabilities.heat).toBe(false);
});

test("malformed filter state is bounded, normalized and cannot mutate the capture", () => {
  const m = model();
  const original = JSON.stringify(m);
  expect(
    engine.normalize(
      {
        clusters: [-1, 0, 0, 1.5, 999, "1"],
        heatMin: Number.NaN,
        state: "invented",
        query: "x".repeat(900),
      },
      m,
    ),
  ).toMatchObject({ clusters: [0], heatMin: 0, state: "all", query: "x".repeat(512) });
  for (const input of [
    null,
    "wrong",
    [],
    { heatMode: "top10", clusters: [1] },
    { solution: "without" },
  ])
    engine.evaluate(m, input, score);
  expect(JSON.stringify(m)).toBe(original);
  expect(engine.normalize({ heatMode: "all", heatMin: 100 }, m)).toEqual(engine.defaults());
});

test("the exact factory embedded in standalone HTML runs without module dependencies", () => {
  const browserEngine = runInNewContext(`(${createDashboardFilterEngine.toString()})()`);
  expect([
    ...browserEngine.evaluate(model(), { heatMode: "min", heatMin: 81 }, score).matches,
  ]).toEqual([key(1)]);
});

test("the shipped view functions share filters while retaining complete relationship context", () => {
  const m = model([
    item(1, 100, { in: [{ from: key(5), via: "closes" }] }),
    item(2, 80),
    item(3, 100, { state: "CLOSED" }),
    item(4, 20),
    pr(5, { out: [{ to: key(1), via: "closes" }] }),
  ]);
  const html = renderDashboard([m]);
  const script = html.slice(html.lastIndexOf("<script>") + 8, html.lastIndexOf("</script>"));
  const result = runInNewContext(
    script.replace(
      'app.className = "";',
      `
    F={state:'open',kind:'Issue',heatMode:'min',heatMin:270};computeFilters();SW.by='all';
    return ({
      rank:rankRows().map(r=>r.n.key),
      swarm:swGroups().flatMap(g=>g.members),
      explore:clusterStats(DATA.groups[0]).ms,
      impact:impactRows().map(r=>r.k),
      linkedPRs:[...blastRadius('${key(1)}').prs],
      captured:Object.keys(N).length
    });`,
    ),
    {
      document: {
        getElementById: (id: string) =>
          id === "data" ? { textContent: JSON.stringify({ projects: [m] }) } : {},
      },
      location: { href: "https://example.invalid/view.html", search: "" },
      URL,
      URLSearchParams,
      AbortController,
      window: { addEventListener() {} },
      localStorage: { getItem: () => null },
    },
  );
  expect(result).toEqual({
    rank: [key(1)],
    swarm: [key(1)],
    explore: [key(1)],
    impact: [key(1)],
    linkedPRs: [key(5)],
    captured: 5,
  });
});

test("the shipped view labels sub-issue links from each end and keeps them out of solutions", () => {
  const m = model([
    item(1, 100, { in: [{ from: key(2), via: "sub-issue" }] }),
    item(2, 80, { out: [{ to: key(1), via: "sub-issue" }] }),
  ]);
  const html = renderDashboard([m]);
  const script = html.slice(html.lastIndexOf("<script>") + 8, html.lastIndexOf("</script>"));
  const result = runInNewContext(
    script.replace(
      'app.className = "";',
      `
    F={state:'all',kind:'all',heatMode:'all'};computeFilters();
    return ({
      parent:egoSvg(N['${key(1)}']),
      child:egoSvg(N['${key(2)}']),
      linkedPRs:[...blastRadius('${key(1)}').prs],
    });`,
    ),
    {
      document: {
        getElementById: (id: string) =>
          id === "data" ? { textContent: JSON.stringify({ projects: [m] }) } : {},
      },
      location: { href: "https://example.invalid/view.html", search: "" },
      URL,
      URLSearchParams,
      AbortController,
      window: { addEventListener() {} },
      localStorage: { getItem: () => null },
    },
  );
  expect(result.parent).toContain("parent of #2");
  expect(result.child).toContain("sub-issue of #1");
  expect(result.linkedPRs).toEqual([]);
  const filters = createDashboardFilterEngine().evaluate(m, { solution: "with" }, score);
  expect([...filters.matches]).toEqual([]);
});

test("combinations agree with an independent intersection of captured item sets", () => {
  const m = model([item(1, 100), item(2, 80), item(3, 80, { state: "CLOSED" }), pr(4)]);
  const all = [1, 2, 3, 4];
  const states = [
    ["all", all],
    ["open", [1, 2, 4]],
    ["closed", [3]],
  ] as const;
  const kinds = [
    ["all", all],
    ["Issue", [1, 2, 3]],
    ["PullRequest", [4]],
  ] as const;
  const clusters = [
    [[], all],
    [[0], [1, 2]],
    [[1], [2, 3, 4]],
    [[0, 1], all],
  ] as const;
  const heat = [
    ["all", all],
    ["min", [1, 2]],
  ] as const;
  for (const [state, a] of states)
    for (const [kind, b] of kinds)
      for (const [selected, c] of clusters)
        for (const [heatMode, d] of heat) {
          const expected = all
            .filter((id) => [a, b, c, d].every((ids) => (ids as readonly number[]).includes(id)))
            .map(key);
          expect(keys(m, { state, kind, clusters: selected, heatMode, heatMin: 80 })).toEqual(
            expected,
          );
        }
});
