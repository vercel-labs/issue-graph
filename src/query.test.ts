import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readConfig, resolveWeights, setWeights, validateConfig } from "./config.js";
import { createGraphMetrics, dashboardQuery } from "./dashboard-query.js";
import { type ClientNode, dashboardModel, type Model, renderDashboard } from "./html.js";
import { publishLocal } from "./local-store.js";
import { prepareDashboard, writeNextDashboard } from "./next-dashboard.js";
import { runQueryCli } from "./query-cli.js";
import { parseModel, readCapture, readQuery, saveCapture, saveQuery } from "./query-store.js";
import { scoring } from "./scoring.js";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    renameSync: vi.fn(actual.renameSync),
    linkSync: vi.fn(actual.linkSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    fsyncSync: vi.fn(actual.fsyncSync),
    unlinkSync: vi.fn(actual.unlinkSync),
  };
});

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(join(tmpdir(), "issue-graph-query-"));
  vi.stubEnv("ISSUE_GRAPH_HOME", home);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

const key = (id: number): ClientNode["key"] => `owner/repo#${id}`;
function item(id: number, comments: number, patch: Partial<ClientNode> = {}): ClientNode {
  return {
    key: key(id),
    repo: "owner/repo",
    num: id,
    kind: "Issue",
    state: "OPEN",
    title: `Browser item ${id}`,
    url: `https://example.com/${id}`,
    depth: 0,
    seed: true,
    flags: [],
    mentionedBy: [],
    external: [],
    in: [],
    out: [],
    overlaps: [],
    heat: { comments, participants: 2, reactions: 1, daysOpen: 30, inboundRefs: 0 },
    ...patch,
  };
}
function model(): Model {
  const base = dashboardModel(new Map(), [], "owner/repo");
  const ns = [
    item(1, 10, { in: [{ from: key(2), via: "closes" }] }),
    item(2, 5, { kind: "PullRequest", out: [{ to: key(1), via: "closes" }] }),
    item(3, 2),
    item(4, 20, { state: "CLOSED", heat: undefined }),
  ];
  return {
    ...base,
    provider: { ...base.provider },
    nodes: Object.fromEntries(ns.map((n) => [n.key, n])),
    groups: [
      { label: "Browser", subtitle: "", members: [key(1), key(2)] },
      { label: "Other", subtitle: "", members: [key(3), key(4)] },
    ],
  };
}

test("Next dashboard URL restores every view, context, filters and weights", () => {
  const m = model();
  for (const view of ["explore", "rank", "swarm", "impact"] as const) {
    const query = dashboardQuery.normalize(m, {
      view,
      filters: { state: "open", kind: "Issue", clusters: [0], query: "Browser" },
      weights: { comments: 0, age: 8 },
      group: "kind",
      metric: "links",
      ...(view === "explore" ? { cluster: 0 } : {}),
      ...(view === "impact" ? { select: key(1) } : {}),
    });
    const url = dashboardQuery.url("file:///private/capture/view.html", m, query);
    expect(dashboardQuery.fromUrl(m, url)).toEqual(query);
  }
  const query = dashboardQuery.normalize(m, { view: "explore", select: key(1) });
  expect(dashboardQuery.fromUrl(m, dashboardQuery.url("https://localhost/", m, query))).toEqual(
    query,
  );
});

test.each([
  "rank:1,2",
  "rank:1,2,3,4,5,6",
  "rank:1,2,3,4,",
  "rank:1,2,3,4,-1",
  "swarm:typo:heat",
  "explore:999",
])("invalid browser state fails explicitly: %s", (hash) => {
  expect(() => dashboardQuery.fromUrl(model(), `https://localhost/#${hash}`)).toThrow();
});

test("Next dashboard embeds data safely and publishes every referenced local asset", () => {
  const m = model();
  m.nodes[key(1)].title = '</script><img src=x onerror="alert(1)">';
  const out = join(home, "export", "view.html");
  writeNextDashboard(out, [m]);
  const html = fs.readFileSync(out, "utf8");
  const data = html.match(
    /<script id="issue-graph-data" type="application\/json">(.+?)<\/script>/,
  )?.[1];
  expect(data).toBeDefined();
  expect(html).not.toContain(m.nodes[key(1)].title);
  expect(() => JSON.parse(data as string)).not.toThrow();
  expect(JSON.parse(data as string).projects[0].nodes[key(1)].title).toBe(m.nodes[key(1)].title);
  const references = [...html.matchAll(/(?:src|href)="\.\/(_next\/[^"]+)"/g)].map((m) => m[1]);
  expect(references.length).toBeGreaterThan(3);
  for (const name of references) expect(fs.existsSync(join(home, "export", name))).toBe(true);
  expect(html).toContain("self.__next_f");
  expect(prepareDashboard([m]).html).toBe(html);
});

test("history refuses altered Next assets and retries a failed asset publication", async () => {
  const m = model(),
    capture = saveCapture(m),
    query = dashboardQuery.normalize(m);
  const actual = await vi.importActual<typeof fs>("node:fs");
  vi.mocked(fs.linkSync).mockImplementationOnce(() => {
    throw new Error("asset publish refused");
  });
  expect(() => saveQuery(m, capture, query)).toThrow("asset publish refused");
  vi.mocked(fs.linkSync).mockImplementation(actual.linkSync);
  const saved = saveQuery(m, capture, query);
  expect(readQuery(saved.id).query).toEqual(query);
  const dir = join(home, "history", saved.id),
    receipt = JSON.parse(fs.readFileSync(join(dir, "query.json"), "utf8"));
  fs.writeFileSync(join(dir, Object.keys(receipt.assets)[0]), "tampered");
  expect(() => readQuery(saved.id)).toThrow("asset has changed");
});

test("weights resolve per provider and scope, preserving siblings and zeros", () => {
  expect(resolveWeights(readConfig())).toEqual(scoring.defaults);
  setWeights({ comments: 4, age: 0 });
  setWeights({ comments: 5 }, "github");
  setWeights({ reactions: 8 }, "github", "owner/repo");
  setWeights({ comments: 1 }, "linear", "owner/repo");
  const c = readConfig();
  expect(resolveWeights(c, "github", "owner/repo", { participants: 0 })).toEqual({
    comments: 5,
    participants: 0,
    reactions: 8,
    inboundRefs: 2,
    age: 0,
  });
  expect(resolveWeights(c, "github", "other/repo").reactions).toBe(2);
  expect(resolveWeights(c, "linear", "owner/repo").comments).toBe(1);
  expect(resolveWeights(c, "jira", "owner/repo").comments).toBe(4);
});

test.each([
  { schemaVersion: 2 },
  { schemaVersion: 1, typo: {} },
  { schemaVersion: 1, defaults: { weights: { comments: -1 } } },
  { schemaVersion: 1, defaults: { weights: { comments: 11 } } },
  { schemaVersion: 1, defaults: { weights: { comments: null } } },
  { schemaVersion: 1, defaults: { weights: { comments: Number.NaN } } },
  { schemaVersion: 1, providers: { github: { scopes: [] } } },
  JSON.parse('{"schemaVersion":1,"providers":{"__proto__":{"defaults":{}}}}'),
])("config refuses invalid schema or fields: %j", (c) => {
  expect(() => validateConfig(c)).toThrow();
});

test("corrupt config and concurrent writer fail without overwriting data", () => {
  const file = join(home, "config.json");
  fs.writeFileSync(file, "not json");
  expect(() => setWeights({ comments: 4 })).toThrow("Cannot read config");
  expect(fs.readFileSync(file, "utf8")).toBe("not json");
  expect(fs.existsSync(`${file}.lock`)).toBe(false);
  fs.unlinkSync(file);
  fs.writeFileSync(`${file}.lock`, "");
  expect(() => setWeights({ comments: 4 })).toThrow("locked");
  expect(fs.existsSync(file)).toBe(false);
  fs.unlinkSync(`${file}.lock`);
  setWeights({ comments: 4 });
  expect(readConfig().defaults?.weights?.comments).toBe(4);
});

test("atomic publication failure preserves config, removes temporary state and permits immediate retry", () => {
  setWeights({ comments: 2 });
  const before = fs.readFileSync(join(home, "config.json"), "utf8");
  const fail = vi.mocked(fs.renameSync).mockImplementationOnce(() => {
    throw new Error("forced rename failure");
  });
  expect(() => setWeights({ comments: 8 })).toThrow("forced rename");
  expect(fs.readFileSync(join(home, "config.json"), "utf8")).toBe(before);
  expect(fs.readdirSync(home)).toEqual(["config.json"]);
  fail.mockClear();
  setWeights({ comments: 8 });
  expect(readConfig().defaults?.weights?.comments).toBe(8);
});

test("immutable writes reject collisions and symlinks and clean temp files on failure", () => {
  const file = join(home, "saved.json");
  publishLocal(file, "original");
  expect(() => publishLocal(file, "original")).not.toThrow();
  expect(() => publishLocal(file, "changed")).toThrow();
  expect(fs.readFileSync(file, "utf8")).toBe("original");
  const link = join(home, "link.json");
  fs.symlinkSync(file, link);
  expect(() => publishLocal(link, "original")).toThrow();
  expect(fs.readdirSync(home).sort()).toEqual(["link.json", "saved.json"]);
});

test.each([
  "writeFileSync",
  "fsyncSync",
  "linkSync",
] as const)("capture %s failure cleans unpublished files and allows retry", (operation) => {
  vi.mocked(
    { writeFileSync: fs.writeFileSync, fsyncSync: fs.fsyncSync, linkSync: fs.linkSync }[operation],
  ).mockImplementationOnce(() => {
    throw new Error(`forced ${operation}`);
  });
  expect(() => saveCapture(model())).toThrow(`forced ${operation}`);
  expect(fs.readdirSync(join(home, "captures"))).toEqual([]);
  const id = saveCapture(model());
  expect(readCapture(id).repo).toBe("owner/repo");
  expect(fs.readdirSync(join(home, "captures"))).toEqual([`${id}.json`]);
});

test("query failure after HTML publication can retry without duplicate or partial receipts", async () => {
  const m = model(),
    id = saveCapture(m),
    query = dashboardQuery.normalize(m);
  const real = await vi.importActual<typeof fs>("node:fs");
  vi.mocked(fs.linkSync).mockImplementation((from, to) => {
    if (String(to).endsWith("query.json")) throw new Error("receipt refused");
    return real.linkSync(from, to);
  });
  expect(() => saveQuery(m, id, query)).toThrow("receipt refused");
  const dirs = fs.readdirSync(join(home, "history"));
  expect(dirs).toHaveLength(1);
  expect(fs.readdirSync(join(home, "history", dirs[0]))).toEqual([
    "_next",
    "font-LICENSE.txt",
    "view.html",
  ]);
  vi.mocked(fs.linkSync).mockImplementation(real.linkSync);
  const saved = saveQuery(m, id, query);
  expect(saved.id).toBe(dirs[0]);
  expect(readQuery(saved.id).captureId).toBe(id);
});

test("cleanup failure after config commit reports a retryable lock without reverting committed defaults", async () => {
  setWeights({ age: 2 });
  vi.mocked(fs.unlinkSync).mockImplementationOnce(() => {
    throw new Error("lock cleanup refused");
  });
  expect(() => setWeights({ age: 3 })).toThrow("lock cleanup refused");
  expect(readConfig().defaults?.weights?.age).toBe(3);
  expect(() => setWeights({ age: 3 })).toThrow("locked");
  fs.unlinkSync(join(home, "config.json.lock"));
  setWeights({ age: 3 });
  expect(readConfig().defaults?.weights?.age).toBe(3);
});

test("saved view and exact replay survive changed defaults and later captures", () => {
  const m = model(),
    query = dashboardQuery.normalize(m, {
      weights: { comments: 4 },
      filters: { heatMode: "min", heatMin: 30 },
      view: "swarm",
      metric: "heat",
      group: "kind",
    });
  const id = saveCapture(m),
    saved = saveQuery(m, id, query);
  const file = fileURLToPath(new URL(saved.viewUrl));
  const html = fs.readFileSync(file, "utf8");
  setWeights({ comments: 0 });
  const later = model();
  later.nodes[key(1)].heat = {
    comments: 999,
    participants: 2,
    reactions: 1,
    daysOpen: 30,
    inboundRefs: 0,
  };
  expect(saveCapture(later)).not.toBe(id);
  expect(readQuery(saved.id).query.weights.comments).toBe(4);
  expect(readCapture(id).nodes[key(1)].heat?.comments).toBe(10);
  expect(fs.readFileSync(file, "utf8")).toBe(html);
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  expect(saved.viewUrl).toContain("#swarm:kind:heat");
  expect(new URL(saved.viewUrl).searchParams.get("weights")).toBe("4,2,2,2,1");
});

test("missing/corrupt captures and changed history fail instead of using latest", () => {
  expect(() => readCapture("a".repeat(64))).toThrow();
  expect(() => readCapture("../config")).toThrow();
  const m = model(),
    id = saveCapture(m);
  const saved = saveQuery(m, id, dashboardQuery.normalize(m));
  fs.appendFileSync(fileURLToPath(new URL(saved.viewUrl)), "changed");
  expect(() => readQuery(saved.id)).toThrow("saved view has changed");
  fs.writeFileSync(join(home, "captures", `${id}.json`), "{}");
  expect(() => readCapture(id)).toThrow("corrupt capture");
});

test("provider capabilities reject explicit unsupported filters while allowing empty results", () => {
  const m = model();
  m.id = "linear:workspace:project:id";
  m.provider = {
    ...m.provider,
    id: "linear",
    filters: [],
    metrics: ["links", "depth"],
    views: ["explore", "swarm"],
  };
  expect(dashboardQuery.identity(m)).toBe("linear:workspace:project:id");
  expect(dashboardQuery.scope(m)).toBe("workspace:project:id");
  for (const input of [
    { filters: { review: "pending" } },
    { filters: { heatMode: "min", heatMin: 10 } },
    { view: "rank" },
    { metric: "heat" },
    { filters: { clusters: [99] } },
    { weights: { age: Number.POSITIVE_INFINITY } },
    { select: "unknown" },
    { filters: { kind: "typo" } },
  ])
    expect(() =>
      dashboardQuery.normalize(m, input as Parameters<typeof dashboardQuery.normalize>[1]),
    ).toThrow();
  const q = dashboardQuery.normalize(m, { filters: { query: "absent" } });
  expect(dashboardQuery.evaluate(m, q).matches.size).toBe(0);
  expect(q.view).toBe("explore");
});

test("generated weight combinations agree with an independent scoring formula", () => {
  const m = model();
  for (const comments of [0, 0.5, 3, 10])
    for (const age of [0, 1, 10])
      for (const min of [0, 27, 47, 500]) {
        const weights = { ...scoring.defaults, comments, age };
        const q = dashboardQuery.normalize(m, {
          weights,
          filters: { heatMode: "min", heatMin: min },
        });
        const expected = [
          [key(1), 10 * comments + 6 + age],
          [key(2), 5 * comments + 6 + age],
          [key(3), 2 * comments + 6 + age],
        ]
          .filter(([, score]) => Number(score) >= min)
          .sort((a, b) => Number(b[1]) - Number(a[1]) || String(a[0]).localeCompare(String(b[0])));
        expect(dashboardQuery.evaluate(m, q).ranking.map((r) => [r.n.key, r.score])).toEqual(
          expected,
        );
      }
});

test("legacy exporter and CLI retain the same scores, order, filters and graph metrics", () => {
  const m = model();
  const weights = { ...scoring.defaults, comments: 4 };
  const q = dashboardQuery.normalize(m, {
    weights,
    filters: { state: "open", heatMode: "min", heatMin: 27 },
  });
  const html = renderDashboard([m], { weights: { "github:owner/repo": weights } });
  const data = html.match(/<script id="data" type="application\/json">(.+)<\/script>/)?.[1];
  const script = html.slice(html.lastIndexOf("<script>") + 8, html.lastIndexOf("</script>"));
  const result = runInNewContext(
    script.replace(
      'app.className = "";',
      `F=${JSON.stringify(q.filters)};computeFilters();
      return {weights:RK,rows:rankRows().map(r=>[r.n.key,r.score]),impact:impactRows().map(r=>[r.k,r.score]),neighbors:[...neighbors('owner/repo#1')]};`,
    ),
    {
      document: { getElementById: (id: string) => (id === "data" ? { textContent: data } : {}) },
      location: { href: dashboardQuery.url("https://example.test/view", m, q), search: "" },
      URL,
      URLSearchParams,
      AbortController,
      window: { addEventListener() {} },
      localStorage: { getItem: () => null },
    },
  );
  expect(result.weights).toEqual([4, 2, 2, 2, 1]);
  expect(result.rows).toEqual([
    [key(1), 47],
    [key(2), 27],
  ]);
  expect(result.rows).toEqual(dashboardQuery.evaluate(m, q).ranking.map((r) => [r.n.key, r.score]));
  expect(result.impact).toEqual([
    [key(2), 1],
    [key(1), 1],
  ]);
  expect(result.neighbors).toEqual([key(2)]);
  expect(
    createGraphMetrics(m)
      .impactRows(new Set([key(1), key(2)]))
      .map((r) => [r.k, r.score]),
  ).toEqual(result.impact);
});

test("view navigation updates router history once per transition", () => {
  const html = renderDashboard([model()]);
  const script = html.slice(html.lastIndexOf("<script>") + 8, html.lastIndexOf("</script>"));
  let url = new URL("https://example.test/view#explore");
  const pushed: string[] = [];
  const result = runInNewContext(
    script.replace(
      'app.className = "";',
      `setHash('rank:3,2,2,2,1');
       setHash('rank:3,2,2,2,1');
       setHash('swarm:cluster:links');
       return lastHash;`,
    ),
    {
      document: {
        getElementById: (id: string) =>
          id === "data" ? { textContent: JSON.stringify({ projects: [model()] }) } : {},
      },
      location: {
        get href() {
          return url.href;
        },
        get search() {
          return url.search;
        },
        get hash() {
          return url.hash;
        },
        set hash(hash: string) {
          url.hash = hash;
        },
      },
      history: {
        pushState: (_state: unknown, _title: string, next: string) => {
          pushed.push(next);
          url = new URL(next, url);
        },
      },
      URL,
      URLSearchParams,
      AbortController,
      localStorage: { getItem: () => null },
    },
  );
  expect(pushed).toEqual(["#rank:3,2,2,2,1", "#swarm:cluster:links"]);
  expect(result).toBe("swarm:cluster:links");
  expect(url.hash).toBe("#swarm:cluster:links");
});

test("CLI emits JSON, opens the exact URL only when asked and replays without reading new config", async () => {
  const input = join(home, "model.json");
  fs.writeFileSync(input, JSON.stringify(model()));
  let stdout = "";
  vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    stdout += s;
    return true;
  });
  const open = vi.fn();
  await runQueryCli(
    ["query", "--input", input, "--weights", "comments=4", "--heat-min", "27", "--json"],
    open,
  );
  const result = JSON.parse(stdout);
  expect(result.counts.visible).toBe(2);
  expect(result.items.map((n: ClientNode) => n.key)).toEqual([key(1), key(2)]);
  expect(open).not.toHaveBeenCalled();
  fs.writeFileSync(join(home, "config.json"), "invalid config");
  stdout = "";
  await runQueryCli(["query", "--history", result.historyId, "--open", "--json"], open);
  expect(JSON.parse(stdout).query).toEqual(result.query);
  expect(open).toHaveBeenCalledWith(result.viewUrl);
  expect(fs.readFileSync(join(home, "config.json"), "utf8")).toBe("invalid config");
});

test("CLI refuses unsupported flags and filters before creating a capture", async () => {
  const input = join(home, "model.json");
  fs.writeFileSync(input, JSON.stringify(model()));
  for (const flags of [
    ["--view", "typo"],
    ["--cluster", "-1"],
    ["--heat-min", "-1"],
    ["--heat-top", "90"],
    ["--filters", '{"typo":true}'],
    ["--weights", "age="],
    ["--open", "--no-open"],
    ["--provider", "github"],
  ])
    await expect(runQueryCli(["query", "--input", input, ...flags], vi.fn())).rejects.toThrow();
  expect(fs.existsSync(join(home, "captures"))).toBe(false);
});

test("CLI selections retain context and reject unreachable Impact selections", async () => {
  const input = join(home, "model.json");
  fs.writeFileSync(input, JSON.stringify(model()));
  let stdout = "";
  vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    stdout += s;
    return true;
  });
  await runQueryCli(
    [
      "query",
      "--input",
      input,
      "--view",
      "explore",
      "--select",
      key(1),
      "--kind",
      "PullRequest",
      "--json",
    ],
    vi.fn(),
  );
  expect(JSON.parse(stdout).selection).toMatchObject({ matches: false, neighbors: [key(2)] });
  await expect(
    runQueryCli(["query", "--input", input, "--view", "impact", "--select", key(4)], vi.fn()),
  ).rejects.toThrow("outside the Impact");
});

describe("import validation", () => {
  test.each([
    '<svg onload="alert(1)"></svg>',
    "<svg><script>alert(1)</script></svg>",
    "<svg><foreignObject></foreignObject></svg>",
    '<svg><path style="background:url(x)"/></svg>',
  ])("refuses active logo markup", (logo) => {
    const m = model();
    m.provider.logo = logo;
    expect(() => parseModel(m)).toThrow("static SVG");
  });
  test("refuses unsafe links, invalid signals and broken relationships", () => {
    const m = model();
    m.nodes[key(1)].url = "javascript:alert(1)";
    expect(() => parseModel(m)).toThrow("HTTP");
    m.nodes[key(1)].url = "";
    m.nodes[key(1)].heat = { ...scoring.defaults, daysOpen: Number.NaN };
    expect(() => parseModel(m)).toThrow("heat");
    m.nodes[key(1)].heat = undefined;
    m.nodes[key(1)].out = [{ to: "toString" as ClientNode["key"], via: "text" }];
    expect(() => parseModel(m)).toThrow("relationships");
  });
});
