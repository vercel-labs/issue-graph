import { writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fillMentionedBy } from "./classify.js";
import { runCli } from "./cli.js";
import { crawl } from "./crawl.js";
import { type FetchNode, NODE_QUERY, parseNodeResponse, type RawNodeItem } from "./github.js";
import { buildPlanReport } from "./plan.js";
import { prioritize } from "./priority.js";
import { buildReconcileReport } from "./reconcile.js";
import { shellTransport } from "./transports/shell.js";
import type { Edge, GraphNode, NodeKey } from "./types.js";

vi.mock("./transports/shell.js", () => ({ shellTransport: vi.fn() }));
vi.mock("node:fs/promises", () => ({ mkdir: vi.fn(), writeFile: vi.fn() }));
vi.mock("./snapshot.js", async (original) => ({
  ...(await original<typeof import("./snapshot.js")>()),
  listSnapshots: vi.fn(() => []),
  writeSnapshot: vi.fn(),
}));

const issueRef = (n: number, repo = "o/r") => {
  const [login, name] = repo.split("/");
  return { number: n, repository: { owner: { login }, name } };
};

const issue = (n: number, extra: Partial<RawNodeItem> = {}): RawNodeItem => ({
  __typename: "Issue",
  title: `Issue ${n}`,
  state: "OPEN",
  url: `https://github.com/o/r/issues/${n}`,
  body: "",
  comments: { totalCount: 0, nodes: [] },
  timelineItems: { nodes: [] },
  ...extra,
});

describe("NODE_QUERY", () => {
  const [issuePart, prPart] = NODE_QUERY.split("... on PullRequest");
  const flat = (text: string) => text.replace(/\s+/g, "");

  test("asks an issue for its parent and its first 50 sub-issues", () => {
    expect(flat(issuePart)).toContain("parent{numberrepository{owner{login}name}}");
    expect(flat(issuePart)).toContain("subIssues(first:50){totalCountnodes{numberrepository");
  });

  test("leaves the hierarchy fields off pull requests", () => {
    expect(prPart).not.toMatch(/\bparent\b|subIssues/);
  });
});

describe("parsing hierarchy fields", () => {
  const parse = (n: number, item: Partial<RawNodeItem>) =>
    parseNodeResponse(issue(n, item), "o", "r", n, 0);

  test("an epic gets one parent-of edge per readable sub-issue", () => {
    const epic = parse(10, {
      subIssues: {
        nodes: [issueRef(11), null, issueRef(12), issueRef(11), issueRef(10), issueRef(3, "a/b")],
      },
    });
    expect(epic.edges).toEqual([
      { to: "o/r#11", via: "parent-of" },
      { to: "o/r#12", via: "parent-of" },
      { to: "a/b#3", via: "parent-of" },
    ]);
  });

  test("a sub-issue link sits beside a mention and a cross-reference of the same parent", () => {
    const child = parse(11, {
      body: "Tracked in #10, see also #30",
      author: { login: "maria" },
      parent: issueRef(10),
      timelineItems: {
        nodes: [
          { actor: { login: "jo" }, createdAt: "2026-02-03T00:00:00Z", source: issueRef(10) },
        ],
      },
    });
    expect(child.edges).toEqual([
      { to: "o/r#10", via: "cross-ref", by: "jo", at: "2026-02-03T00:00:00Z" },
      { to: "o/r#30", via: "text", by: "maria" },
      { to: "o/r#10", via: "child-of" },
    ]);
  });

  describe("an incomplete sub-issue page", () => {
    const page = (totalCount: number, nodes: Array<ReturnType<typeof issueRef> | null>) =>
      parse(10, { subIssues: { totalCount, nodes } });
    const fifty = Array.from({ length: 50 }, (_, i) => issueRef(100 + i));

    test("counts what lies past the 50-item page as past the limit", () => {
      const epic = page(62, fifty);
      expect(epic.subIssuesPastLimit).toBe(12);
      expect(epic.subIssuesUnreadable).toBeUndefined();
      expect(epic.edges).toHaveLength(50);
    });

    test("counts null entries on a complete page as unreadable, not as past the limit", () => {
      const epic = page(3, [issueRef(11), null, null]);
      expect(epic.subIssuesPastLimit).toBeUndefined();
      expect(epic.subIssuesUnreadable).toBe(2);
    });

    test("keeps both counts when a full page also holds null entries", () => {
      const epic = page(55, [...fifty.slice(0, 49), null]);
      expect(epic.subIssuesPastLimit).toBe(5);
      expect(epic.subIssuesUnreadable).toBe(1);
    });

    test("records neither count for a complete, readable page", () => {
      const epic = page(2, [issueRef(11), issueRef(12)]);
      expect(epic.subIssuesPastLimit).toBeUndefined();
      expect(epic.subIssuesUnreadable).toBeUndefined();
    });
  });

  test("an issue with neither field and a null parent stays unlinked", () => {
    expect(parse(5, {}).edges).toEqual([]);
    expect(parse(6, { parent: null, subIssues: { nodes: [] } }).edges).toEqual([]);
  });
});

function fixtureFetch(items: Record<NodeKey, Partial<RawNodeItem>>, failing: NodeKey[] = []) {
  const fetched: NodeKey[] = [];
  const fetch: FetchNode = async (owner, repo, number, depth) => {
    const key = `${owner}/${repo}#${number}`;
    fetched.push(key);
    if (failing.includes(key)) {
      return {
        key,
        owner,
        repo,
        number,
        depth,
        kind: "Unknown",
        title: "",
        state: "FETCH_ERROR",
        url: "",
        edges: [],
        externalLinks: [],
        fetched: false,
      };
    }
    return parseNodeResponse(issue(number, items[key]), owner, repo, number, depth);
  };
  return { fetch, fetched };
}

const crawlFrom = (key: NodeKey, fetch: FetchNode, hubThreshold = 12) => {
  const [repoPart, n] = key.split("#");
  const [owner, repo] = repoPart.split("/");
  return crawl(
    [{ owner, repo, number: Number(n) }],
    { maxDepth: 2, maxNodes: 50, hubThreshold, primaryRepo: { owner: "o", repo: "r" } },
    fetch,
  );
};

describe("crawling sub-issue links", () => {
  const tree = {
    "o/r#10": { subIssues: { nodes: [issueRef(11), issueRef(12)] } },
    "o/r#11": { parent: issueRef(10) },
    "o/r#12": { parent: issueRef(10) },
  };

  test("an epic seed reaches every sub-issue with no text reference", async () => {
    const { nodes } = await crawlFrom("o/r#10", fixtureFetch(tree).fetch);
    expect([...nodes.keys()].sort()).toEqual(["o/r#10", "o/r#11", "o/r#12"]);
    expect(nodes.get("o/r#11")?.edges).toEqual([{ to: "o/r#10", via: "child-of" }]);
  });

  test("a sub-issue seed reaches its parent and its siblings", async () => {
    const { nodes } = await crawlFrom("o/r#12", fixtureFetch(tree).fetch);
    expect([...nodes.keys()].sort()).toEqual(["o/r#10", "o/r#11", "o/r#12"]);
    expect(nodes.get("o/r#11")?.depth).toBe(2);
  });

  test("an unreadable sub-issue keeps the link its parent reported", async () => {
    const { nodes } = await crawlFrom("o/r#10", fixtureFetch(tree, ["o/r#12"]).fetch);
    expect(nodes.get("o/r#12")?.fetched).toBe(false);
    expect(nodes.get("o/r#10")?.edges).toContainEqual({ to: "o/r#12", via: "parent-of" });
  });

  test("a non-seed epic with more sub-issues than the hub threshold is fetched, not expanded", async () => {
    const big = [30, 31, 32, 33].map((n) => issueRef(n));
    const { fetch, fetched } = fixtureFetch({
      "o/r#1": { body: "blocked on #20" },
      "o/r#20": { subIssues: { nodes: big } },
    });
    const { nodes } = await crawlFrom("o/r#1", fetch, 3);
    expect(nodes.get("o/r#20")?.hub).toBe(true);
    expect(fetched).toEqual(["o/r#1", "o/r#20"]);
  });

  describe("an epic that also lists its sub-issues in a task list", () => {
    const kids = [11, 12, 13, 14, 15, 16, 17];
    const items = {
      "o/r#1": { body: "blocked on #10" },
      "o/r#10": {
        body: kids.map((n) => `- [ ] #${n}`).join("\n"),
        subIssues: { nodes: kids.map((n) => issueRef(n)) },
      },
    };

    test("counts each sub-issue once toward the hub threshold", async () => {
      const { fetch, fetched } = fixtureFetch(items);
      const { nodes } = await crawlFrom("o/r#1", fetch, 7);
      const epic = nodes.get("o/r#10");
      expect(epic?.edges).toHaveLength(14);
      expect(epic?.hub).toBeUndefined();
      expect(fetched).toEqual(["o/r#1", "o/r#10", ...kids.map((n) => `o/r#${n}`)]);
    });

    test("is a hub once its distinct linked items exceed the threshold", async () => {
      const { fetch, fetched } = fixtureFetch(items);
      const { nodes } = await crawlFrom("o/r#1", fetch, 6);
      expect(nodes.get("o/r#10")?.hub).toBe(true);
      expect(fetched).toEqual(["o/r#1", "o/r#10"]);
    });
  });

  test("a sub-issue in another repository is fetched one hop and not expanded", async () => {
    const { fetch, fetched } = fixtureFetch({
      "o/r#10": { subIssues: { nodes: [issueRef(7, "a/b")] } },
      "a/b#7": { parent: issueRef(10), subIssues: { nodes: [issueRef(8, "a/b")] } },
    });
    const { nodes } = await crawlFrom("o/r#10", fetch);
    expect(nodes.get("a/b#7")?.depth).toBe(2);
    expect(fetched).not.toContain("a/b#8");
  });
});

describe("plan", () => {
  const now = new Date("2026-01-01");
  const node = (n: number, edges: Edge[], extra: Partial<GraphNode> = {}): GraphNode => ({
    key: `o/r#${n}`,
    owner: "o",
    repo: "r",
    number: n,
    kind: "Issue",
    title: `Issue ${n}`,
    state: "OPEN",
    url: "",
    depth: 0,
    edges,
    externalLinks: [],
    fetched: true,
    ...extra,
  });
  const plan = (values: GraphNode[], cappedOut: NodeKey[]) => {
    const nodes = new Map(values.map((n) => [n.key, n]));
    const reconcile = buildReconcileReport(nodes, {
      repo: "o/r",
      seeds: values.filter((n) => n.state === "OPEN").map((n) => n.key),
      seedLimit: 80,
      nodeCap: 80,
      cappedOut,
      generatedAt: now.toISOString(),
    });
    const report = buildPlanReport(reconcile, nodes, prioritize(nodes, now));
    return (key: NodeKey) =>
      [...report.queue, ...report.investigation, ...report.blocked].find((i) => i.key === key);
  };
  const failed = node(13, [], { state: "FETCH_ERROR", fetched: false });

  test("a sub-issue past the node cap or unfetched does not block either end of the link", () => {
    const item = plan(
      [
        node(10, [{ to: "o/r#11", via: "parent-of" }]),
        node(12, [{ to: "o/r#13", via: "child-of" }]),
        failed,
      ],
      ["o/r#11"],
    );
    for (const key of ["o/r#10", "o/r#12"]) {
      expect(item(key)?.status).toBe("needs-investigation");
      expect(item(key)?.blockedBy).toEqual([]);
      expect(item(key)?.reasons.map((r) => r.code)).not.toContain("unresolved-reference");
    }
  });

  test("a mention beside the link still blocks on the unresolved item", () => {
    const item = plan(
      [
        node(12, [
          { to: "o/r#13", via: "text" },
          { to: "o/r#13", via: "child-of" },
        ]),
        failed,
      ],
      [],
    );
    expect(item("o/r#12")?.status).toBe("blocked");
    expect(item("o/r#12")?.blockedBy).toEqual(["o/r#13"]);
    expect(item("o/r#12")?.reasons.find((r) => r.code === "unresolved-reference")?.related).toEqual(
      ["o/r#13"],
    );
  });
});

describe("rank", () => {
  test("sub-issue links add no inbound references at either end", () => {
    const node = (key: NodeKey, edges: Edge[]): GraphNode => ({
      key,
      owner: "o",
      repo: "r",
      number: Number(key.split("#")[1]),
      kind: "Issue",
      title: key,
      state: "OPEN",
      url: "",
      depth: 0,
      edges,
      externalLinks: [],
      fetched: true,
    });
    const nodes = new Map(
      [
        node("o/r#10", [{ to: "o/r#11", via: "parent-of" }]),
        node("o/r#11", [{ to: "o/r#10", via: "child-of" }]),
        node("o/r#12", [{ to: "o/r#10", via: "text" }]),
      ].map((n) => [n.key, n]),
    );
    const refs = Object.fromEntries(
      prioritize(nodes, new Date("2026-01-01")).map((r) => [r.key, r.inboundRefs]),
    );
    expect(refs).toEqual({ "o/r#10": 1, "o/r#11": 0, "o/r#12": 0 });
  });

  describe("an epic and a sub-issue that also mention each other", () => {
    const linked = () => {
      const epic = parseNodeResponse(
        issue(10, {
          body: "- [ ] #11",
          author: { login: "ana" },
          subIssues: { totalCount: 1, nodes: [issueRef(11)] },
        }),
        "o",
        "r",
        10,
        0,
      );
      const child = parseNodeResponse(
        issue(11, { body: "Part of #10", author: { login: "maria" }, parent: issueRef(10) }),
        "o",
        "r",
        11,
        1,
      );
      return new Map([epic, child].map((n) => [n.key, n]));
    };

    test("keep the inbound reference each mention adds", () => {
      const refs = prioritize(linked(), new Date("2026-01-01")).map((r) => [r.key, r.inboundRefs]);
      expect(refs).toEqual([
        ["o/r#10", 1],
        ["o/r#11", 1],
      ]);
    });

    test("keep the author of each mention in mentionedBy", () => {
      const nodes = linked();
      fillMentionedBy(nodes);
      expect(nodes.get("o/r#10")?.mentionedBy).toEqual(["maria"]);
      expect(nodes.get("o/r#11")?.mentionedBy).toEqual(["ana"]);
    });
  });
});

describe("graph command", () => {
  const items: Record<number, Partial<RawNodeItem> | undefined> = {
    10: { subIssues: { totalCount: 70, nodes: [11, 12, 13].map((n) => issueRef(n)) } },
    11: { parent: issueRef(10) },
    13: {
      body: "Part of #10, starting with #40",
      parent: issueRef(10),
      subIssues: { totalCount: 5, nodes: [...[40, 41, 42, 43].map((n) => issueRef(n)), null] },
    },
  };
  let stdout: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    stdout = [];
    vi.spyOn(console, "log").mockImplementation((line) => {
      stdout.push(String(line));
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.mocked(shellTransport).mockReturnValue({
      search: async () => [],
      graphql: async (_query, variables = {}) => {
        const n = Number(variables.n);
        const item = items[n];
        if (!item) return { errors: [{ message: "Could not resolve to an issue" }] };
        return { data: { repository: { issueOrPullRequest: issue(n, item) } } };
      },
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("prints both ends of each link and counts each linked item once in the hub list", async () => {
    await runCli([
      "graph",
      "o/r#10",
      "--format",
      "markdown",
      "--no-save",
      "--hub-threshold",
      "3",
      "-o",
      "/tmp/unwritten/graph.json",
    ]);
    const report = stdout.join("\n");
    expect(report).toContain("Nodes: 4");
    expect(report).toMatch(/\*\*o\/r#10\*\*[^\n]*\n {4}- parent of → o\/r#11 🟢 OPEN/);
    expect(report).toContain("    - parent of → o/r#12 ⚪ FETCH_ERROR");
    expect(report).toMatch(/\*\*o\/r#11\*\*[^\n]*\n {4}- child of → o\/r#10 🟢 OPEN/);
    expect(report).toContain("- o/r#13 (5 refs)");
    expect(report).toContain("    - sub-issues: 67 more not read (first 50 per node)");
    expect(report).toContain("    - sub-issues: 1 returned no data (no access or removed)");
    expect(report.match(/sub-issues: /g)).toHaveLength(2);
    expect(report).toContain("## Beyond depth limit (4 refs not crawled)");
    const saved = JSON.parse(String(vi.mocked(writeFile).mock.calls[0][1])) as {
      nodes: GraphNode[];
    };
    const saved10 = saved.nodes.find((n) => n.key === "o/r#10");
    expect([saved10?.subIssuesPastLimit, saved10?.subIssuesUnreadable]).toEqual([67, undefined]);
    expect(saved.nodes.find((n) => n.key === "o/r#11")?.edges).toEqual([
      { to: "o/r#10", via: "child-of" },
    ]);
  });
});
