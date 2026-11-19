import { describe, expect, test } from "vitest";
import {
  BASE,
  type Calls,
  databaseId,
  fakeYouTrack,
  type IssueFixture,
} from "../tests/youtrack-fixtures.js";
import {
  buildYouTrackGraph,
  parseYouTrackBase,
  parseYouTrackLocator,
  renderYouTrack,
  YouTrackReadError,
  youTrackAuthority,
  youTrackNodeKey,
} from "./youtrack.js";

const AUTHORITY = "acme.youtrack.cloud";
const options = { maxDepth: 1, maxNodes: 80, hubThreshold: 12, concurrency: 2 };
const key = (id: string) => youTrackNodeKey(AUTHORITY, id);

async function build(
  issues: Record<string, IssueFixture>,
  seed = "ABC-1",
  extra: Partial<typeof options> & { maxPages?: number } = {},
  fail?: (path: string) => Error | undefined,
  calls?: Calls,
) {
  return buildYouTrackGraph(fakeYouTrack(issues, { fail, calls }), seed, { ...options, ...extra });
}

describe("locators and base URLs", () => {
  test("accepts issue IDs and issue URLs that name the base", () => {
    expect(parseYouTrackLocator("ABC-12")).toEqual({ id: "ABC-12" });
    expect(parseYouTrackLocator("3DS-1")).toEqual({ id: "3DS-1" });
    expect(parseYouTrackLocator("https://acme.youtrack.cloud/issue/ABC-12")).toEqual({
      id: "ABC-12",
      baseUrl: BASE,
    });
    expect(
      parseYouTrackLocator("https://host.example:8443/youtrack/issue/ABC-12/some-title?x=1#focus"),
    ).toEqual({ id: "ABC-12", baseUrl: "https://host.example:8443/youtrack" });
    for (const bad of [
      "UTF",
      "ABC-0",
      "-1",
      "_A-1",
      "https://acme.youtrack.cloud/issues/ABC-1",
      "ftp://h/issue/A-1",
      "https://u:p@h/issue/A-1",
      "https://h/issue/ABC-1/a/b",
    ])
      expect(() => parseYouTrackLocator(bad), bad).toThrow(/YouTrack issue ID/);
  });

  test("validates base URLs and derives the authority from host and path", () => {
    expect(parseYouTrackBase("https://Acme.youtrack.cloud/")).toBe(BASE);
    expect(parseYouTrackBase("http://localhost:8080/youtrack/")).toBe(
      "http://localhost:8080/youtrack",
    );
    expect(youTrackAuthority("http://localhost:8080/youtrack")).toBe("localhost:8080/youtrack");
    for (const loopback of [
      "http://127.0.0.1:1",
      "http://127.4.5.6",
      "http://[::1]:9",
      "http://LOCALHOST",
    ])
      expect(() => parseYouTrackBase(loopback), loopback).not.toThrow();
    for (const clear of [
      "http://acme.youtrack.cloud",
      "http://10.0.0.5",
      "http://127.0.0.1.example.com",
      "http://localhost.example.com",
    ])
      expect(() => parseYouTrackBase(clear), clear).toThrow(/https/);
    expect(() => parseYouTrackLocator("http://acme.youtrack.cloud/issue/ABC-1")).toThrow(
      /YouTrack issue ID/,
    );
    for (const bad of [
      "acme.youtrack.cloud",
      "ftp://x",
      "https://u:p@x",
      "https://x/?a=1",
      "https://x/#a",
      "https://x?",
    ])
      expect(() => parseYouTrackBase(bad), bad).toThrow(/Invalid YouTrack URL/);
  });
});

describe("buildYouTrackGraph", () => {
  test("maps Depend, Duplicate, Subtask, Relates, and other link types with direction", async () => {
    const report = await build({
      "ABC-1": {
        links: [
          { type: "Depend", direction: "OUTWARD", targets: ["ABC-2"] },
          { type: "Depend", direction: "INWARD", targets: ["ABC-3"] },
          { type: "Duplicate", direction: "OUTWARD", targets: ["ABC-4"] },
          { type: "Duplicate", direction: "INWARD", targets: ["ABC-5"] },
          { type: "Subtask", direction: "OUTWARD", targets: ["ABC-6"] },
          { type: "Subtask", direction: "INWARD", targets: ["ABC-7"] },
          { type: "Relates", direction: "BOTH", targets: ["PAY-8"] },
          { type: "Depend 2", direction: "OUTWARD", targets: ["ABC-9"] },
        ],
      },
      "ABC-2": {},
      "ABC-3": {},
      "ABC-4": {},
      "ABC-5": {},
      "ABC-6": {},
      "ABC-7": {},
      "PAY-8": {},
      "ABC-9": {},
    });
    const edges = report.nodes
      .find((node) => node.identifier === "ABC-1")
      ?.edges.map((edge) => [
        edge.to.slice(prefixLength()),
        edge.relation,
        edge.direction,
        edge.nativeRelation,
      ]);
    expect(edges).toEqual(
      expect.arrayContaining([
        ["ABC-2", "blocks", "outgoing", "Depend"],
        ["ABC-3", "blocks", "incoming", "Depend"],
        ["ABC-4", "duplicate_of", "incoming", "Duplicate"],
        ["ABC-5", "duplicate_of", "outgoing", "Duplicate"],
        ["ABC-6", "parent_of", "outgoing", "Subtask"],
        ["ABC-7", "parent_of", "incoming", "Subtask"],
        ["PAY-8", "related", "undirected", "Relates"],
        ["ABC-9", "provider_specific", "outgoing", "Depend 2"],
      ]),
    );
    expect(edges).toHaveLength(8);
    expect(
      report.nodes
        .find((node) => node.identifier === "ABC-1")
        ?.edges.find((edge) => edge.nativeRelation === "Subtask")?.evidence.kind,
    ).toBe("hierarchy");
  });

  test("both endpoints describe one relation with the same evidence", async () => {
    const report = await build({
      "ABC-1": { links: [{ type: "Depend", direction: "OUTWARD", targets: ["ABC-2"] }] },
      "ABC-2": { links: [{ type: "Depend", direction: "INWARD", targets: ["ABC-1"] }] },
    });
    const [a, b] = report.nodes.map((node) => node.edges[0]);
    expect([a.direction, b.direction]).toEqual(["outgoing", "incoming"]);
    expect(a.evidence).toEqual(b.evidence);
    expect(report.coverageComplete).toBe(true);
    expect(report.coverage.depthBoundaries).toEqual([]);
  });

  test("keys nodes by authority, reads state and resolution, and exposes the project", async () => {
    const report = await build({
      "ABC-1": { links: [{ type: "Relates", direction: "BOTH", targets: ["ABC-2"] }] },
      "ABC-2": { resolved: 1_700_000_100_000, state: "Verified" },
    });
    expect(report.authority).toBe(AUTHORITY);
    expect(report.seeds).toEqual([key("ABC-1")]);
    const [root, other] = report.nodes;
    expect(root).toMatchObject({
      key: key("ABC-1"),
      provider: "youtrack",
      authority: AUTHORITY,
      nativeId: databaseId("ABC-1"),
      projectKey: "ABC",
      url: `${BASE}/issue/ABC-1`,
      state: { name: "Open", type: "open" },
      fetched: true,
    });
    expect(root.updatedAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(other.state).toEqual({ name: "Verified", type: "done" });
  });

  test("reports linked pull requests as remote links, netting removals", async () => {
    const report = await build({
      "ABC-1": {
        pulls: [
          { timestamp: 2, added: [["https://github.com/o/r/pull/2", "Second", "c2"]] },
          { timestamp: 1, added: [["https://github.com/o/r/pull/1", "First", "c1"]] },
          { timestamp: 3, removed: [["https://github.com/o/r/pull/1", "First", "c1"]] },
        ],
      },
    });
    expect(report.nodes[0].externalLinks).toEqual([
      {
        url: "https://github.com/o/r/pull/2",
        title: "Second",
        evidence: { kind: "remote-link", id: "https://github.com/o/r/pull/2" },
      },
    ]);
    expect(renderYouTrack(report)).toContain(
      "- Remote link: Second · https://github.com/o/r/pull/2",
    );
  });

  test("pull request titles carry the state and a PR stays while another change adds it", async () => {
    const report = await build({
      "ABC-1": {
        pulls: [
          { timestamp: 1, state: "OPEN", added: [["https://github.com/o/r/pull/1", "One", "c1"]] },
          {
            timestamp: 2,
            state: "MERGED",
            added: [["https://github.com/o/r/pull/1", "One", "c2"]],
          },
          { timestamp: 3, removed: [["https://github.com/o/r/pull/1", "One", "c1"]] },
          { timestamp: 4, state: "OPEN", added: [["https://github.com/o/r/pull/2", "Two", "c3"]] },
          { timestamp: 5, removed: [["https://github.com/o/r/pull/2", "Two", "unknown"]] },
        ],
      },
    });
    expect(report.nodes[0].externalLinks.map((link) => [link.url, link.title])).toEqual([
      ["https://github.com/o/r/pull/1", "One (merged)"],
      ["https://github.com/o/r/pull/2", "Two (open)"],
    ]);
  });

  test("commits are reported as remote links and netted like pull requests", async () => {
    const calls: Calls = { paths: [], queries: [] };
    const report = await build(
      {
        "ABC-1": {
          commits: [
            {
              timestamp: 1,
              added: [["https://github.com/o/r/commit/aaaaaaaaaa", "aaaaaaaaaa1111", "x1"]],
            },
            {
              timestamp: 2,
              added: [["https://github.com/o/r/commit/bbbbbbbbbb", "bbbbbbbbbb2222", "x2"]],
            },
            {
              timestamp: 3,
              removed: [["https://github.com/o/r/commit/bbbbbbbbbb", "bbbbbbbbbb2222", "x2"]],
            },
          ],
        },
      },
      "ABC-1",
      { maxDepth: 0 },
      undefined,
      calls,
    );
    expect(report.nodes[0].externalLinks).toEqual([
      {
        url: "https://github.com/o/r/commit/aaaaaaaaaa",
        title: "Commit aaaaaaa",
        evidence: { kind: "remote-link", id: "https://github.com/o/r/commit/aaaaaaaaaa" },
      },
    ]);
    expect(
      calls.queries.flatMap((query) => (query.categories ? [query.categories] : [])).sort(),
    ).toEqual(["PullRequestChangeCategory", "VcsChangeCategory"]);
    expect(report.nodes[0].coverage.map((part) => part.source)).toContain("commits");
  });

  test("removing one change keeps the state of the surviving change", async () => {
    const report = await build({
      "ABC-1": {
        pulls: [
          { timestamp: 1, state: "OPEN", added: [["https://github.com/o/r/pull/1", "One", "c1"]] },
          {
            timestamp: 2,
            state: "MERGED",
            added: [["https://github.com/o/r/pull/1", "One", "c2"]],
          },
          { timestamp: 3, removed: [["https://github.com/o/r/pull/1", "One", "c2"]] },
        ],
      },
    });
    expect(report.nodes[0].externalLinks.map((link) => link.title)).toEqual(["One (open)"]);
    expect(report.nodes[0].coverage.find((part) => part.source === "pull requests")?.complete).toBe(
      true,
    );
  });

  test("a removal naming no known change keeps live entries and marks the list partial", async () => {
    const report = await build({
      "ABC-1": {
        pulls: [
          { timestamp: 1, state: "OPEN", added: [["https://github.com/o/r/pull/1", "One", "c1"]] },
          { timestamp: 2, removed: [["https://github.com/o/r/pull/1", "One", "unknown"]] },
        ],
      },
    });
    expect(report.nodes[0].externalLinks.map((link) => link.title)).toEqual(["One (open)"]);
    expect(report.nodes[0].coverage.find((part) => part.source === "pull requests")).toMatchObject({
      complete: false,
      reason: "invalid-page",
    });
    expect(report.coverageComplete).toBe(false);
  });

  test("null activity entries are skipped and mark the list partial", async () => {
    const reader = fakeYouTrack({
      "ABC-1": {
        pulls: [
          { timestamp: 1, state: "OPEN", added: [["https://github.com/o/r/pull/1", "One", "c1"]] },
        ],
      },
    });
    const get = reader.get.bind(reader);
    const report = await buildYouTrackGraph(
      {
        ...reader,
        async get(path, query) {
          const value = (await get(path, query)) as Record<string, unknown>;
          if (query?.categories !== "PullRequestChangeCategory") return value;
          const [first] = value.activities as Array<Record<string, unknown[]>>;
          return {
            ...value,
            activities: [{ ...first, added: [null, ...first.added], removed: [42] }],
          };
        },
      },
      "ABC-1",
      options,
    );
    expect(report.nodes[0].externalLinks.map((link) => link.title)).toEqual(["One (open)"]);
    expect(report.nodes[0].coverage.find((part) => part.source === "pull requests")).toMatchObject({
      complete: false,
      reason: "invalid-page",
    });
  });

  test("a link target list that shifts between pages keeps unique entries and is partial", async () => {
    const targets = Array.from({ length: 102 }, (_, index) => `ABC-${index + 2}`);
    const reader = fakeYouTrack({
      "ABC-1": { links: [{ type: "Relates", direction: "BOTH", targets }] },
    });
    const get = reader.get.bind(reader);
    const report = await buildYouTrackGraph(
      {
        ...reader,
        async get(path, query) {
          const value = await get(path, query);
          // The second page re-lists the last entry of the first.
          return path.endsWith("/issues") && query?.$skip === "100"
            ? [
                ((await get(path, { ...query, $skip: "99" })) as unknown[])[0],
                ...(value as unknown[]),
              ]
            : value;
        },
      },
      "ABC-1",
      { ...options, maxDepth: 0 },
    );
    expect(report.nodes[0].edges).toHaveLength(102);
    expect(report.nodes[0].coverage).toContainEqual({
      source: "linked issues",
      pages: 2,
      complete: false,
      reason: "changed-during-read",
    });
    expect(report.coverageComplete).toBe(false);
  });

  test("links into other projects are read one hop and not expanded", async () => {
    const report = await build(
      {
        "ABC-1": { links: [{ type: "Relates", direction: "BOTH", targets: ["PAY-7"] }] },
        "PAY-7": { links: [{ type: "Relates", direction: "BOTH", targets: ["PAY-8", "ABC-1"] }] },
        "PAY-8": {},
      },
      "ABC-1",
      { maxDepth: 3 },
    );
    expect(report.nodes.map((node) => node.identifier)).toEqual(["ABC-1", "PAY-7"]);
    expect(report.coverage.depthBoundaries).toEqual([key("PAY-7")]);
    expect(report.coverageComplete).toBe(true);
  });

  test("project IDs that start with a digit are seeds and link targets", async () => {
    const report = await build(
      {
        "3DS-1": { links: [{ type: "Depend", direction: "OUTWARD", targets: ["3DS-2"] }] },
        "3DS-2": {},
      },
      "3DS-1",
    );
    expect(report.nodes.map((node) => node.identifier)).toEqual(["3DS-1", "3DS-2"]);
    expect(report.coverageComplete).toBe(true);
  });

  test("same-project links recurse to the requested depth", async () => {
    const issues = {
      "ABC-1": { links: [{ type: "Depend", direction: "OUTWARD", targets: ["ABC-2"] }] },
      "ABC-2": { links: [{ type: "Depend", direction: "OUTWARD", targets: ["ABC-3"] }] },
      "ABC-3": {},
    } satisfies Record<string, IssueFixture>;
    const shallow = await build(issues, "ABC-1", { maxDepth: 1 });
    expect(shallow.nodes.map((node) => node.identifier)).toEqual(["ABC-1", "ABC-2"]);
    expect(shallow.coverage.depthBoundaries).toEqual([key("ABC-2")]);
    expect(shallow.coverageComplete).toBe(true);
    const deep = await build(issues, "ABC-1", { maxDepth: 2 });
    expect(deep.nodes.map((node) => node.identifier)).toEqual(["ABC-1", "ABC-2", "ABC-3"]);
    expect(deep.coverage.depthBoundaries).toEqual([]);
  });

  test("unreadable and moved issues stay as unavailable nodes with a code", async () => {
    const report = await build(
      {
        "ABC-1": {
          links: [{ type: "Relates", direction: "BOTH", targets: ["ABC-2", "ABC-3"] }],
        },
        "ABC-2": {},
        "ABC-3": {},
      },
      "ABC-1",
      {},
      (path) =>
        path === `issues/${databaseId("ABC-2")}` || path === "issues/ABC-2"
          ? new YouTrackReadError("FORBIDDEN")
          : undefined,
    );
    const failed = report.nodes.find((node) => node.identifier === "ABC-2");
    expect(failed).toMatchObject({ fetched: false, error: "FORBIDDEN" });
    expect(report.coverage.failed).toEqual([key("ABC-2")]);
    expect(report.coverageComplete).toBe(false);
  });

  test("an issue whose ID differs from the requested one is an identity mismatch", async () => {
    const reader = fakeYouTrack({
      "ABC-1": { links: [{ type: "Relates", direction: "BOTH", targets: ["ABC-2"] }] },
      "ABC-2": {},
    });
    const get = reader.get.bind(reader);
    const report = await buildYouTrackGraph(
      {
        ...reader,
        async get(path, query) {
          const value = (await get(path, query)) as Record<string, unknown>;
          return path === "issues/ABC-2" ? { ...value, idReadable: "NEW-2" } : value;
        },
      },
      "ABC-1",
      options,
    );
    expect(report.nodes[1]).toMatchObject({ fetched: false, error: "IDENTITY_MISMATCH" });
  });

  test("a failed link list marks the issue partial instead of dropping the read", async () => {
    const report = await build(
      {
        "ABC-1": { links: [{ type: "Depend", direction: "OUTWARD", targets: ["ABC-2"] }] },
        "ABC-2": {},
      },
      "ABC-1",
      {},
      (path) => (path.endsWith("/links") ? new YouTrackReadError("UPSTREAM") : undefined),
    );
    expect(report.nodes).toHaveLength(1);
    expect(report.nodes[0].coverage).toContainEqual({
      source: "issue links",
      pages: 0,
      complete: false,
      reason: "read-failed",
    });
    expect(report.coverage.partial).toEqual([key("ABC-1")]);
    expect(report.coverageComplete).toBe(false);
  });

  test("a failed pull request read marks the issue partial but keeps its links", async () => {
    const report = await build(
      {
        "ABC-1": { links: [{ type: "Depend", direction: "OUTWARD", targets: ["ABC-2"] }] },
        "ABC-2": {},
      },
      "ABC-1",
      {},
      (path) => (path.endsWith("/activitiesPage") ? new YouTrackReadError("FORBIDDEN") : undefined),
    );
    expect(report.nodes[0].edges).toHaveLength(1);
    expect(report.coverage.partial).toEqual([key("ABC-1"), key("ABC-2")]);
    expect(report.nodes[0].coverage.find((part) => part.source === "pull requests")).toMatchObject({
      source: "pull requests",
      reason: "read-failed",
    });
  });

  test("lists that reach the page cap are partial and use $top and $skip", async () => {
    const targets = Array.from({ length: 205 }, (_, index) => `ABC-${index + 2}`);
    const calls: Calls = { paths: [], queries: [] };
    const report = await build(
      { "ABC-1": { links: [{ type: "Relates", direction: "BOTH", targets }] } },
      "ABC-1",
      { maxDepth: 0, maxPages: 2 },
      undefined,
      calls,
    );
    const linked = calls.paths.flatMap((path, index) =>
      path.endsWith("/issues") ? [calls.queries[index]] : [],
    );
    expect(linked.map((query) => [query.$top, query.$skip])).toEqual([
      ["100", "0"],
      ["100", "100"],
    ]);
    expect(report.nodes[0].edges).toHaveLength(200);
    expect(report.nodes[0].coverage).toContainEqual({
      source: "linked issues",
      pages: 2,
      complete: false,
      reason: "page-limit",
    });
    expect(report.coverageComplete).toBe(false);
  });

  test("a hub is read but not expanded and makes the run partial", async () => {
    const targets = Array.from({ length: 3 }, (_, index) => `ABC-${index + 3}`);
    const report = await build(
      {
        "ABC-1": { links: [{ type: "Relates", direction: "BOTH", targets: ["ABC-2"] }] },
        "ABC-2": { links: [{ type: "Depend", direction: "OUTWARD", targets }] },
        ...Object.fromEntries(targets.map((id) => [id, {}])),
      },
      "ABC-1",
      { maxDepth: 3, hubThreshold: 2 },
    );
    expect(report.coverage.hubs).toEqual([key("ABC-2")]);
    expect(report.coverageComplete).toBe(false);
    expect(report.nodes.map((node) => node.identifier)).toEqual(["ABC-1", "ABC-2"]);
  });

  test("the node cap leaves known nodes out and makes the run partial", async () => {
    const report = await build(
      {
        "ABC-1": { links: [{ type: "Relates", direction: "BOTH", targets: ["ABC-2", "ABC-3"] }] },
        "ABC-2": {},
        "ABC-3": {},
      },
      "ABC-1",
      { maxNodes: 2 },
    );
    expect(report.coverage.cappedOut).toHaveLength(1);
    expect(report.coverageComplete).toBe(false);
  });

  test("a seed URL must match the reader's base exactly, scheme and path included", async () => {
    const reader = fakeYouTrack({ "ABC-1": {} }, { baseUrl: "http://127.0.0.1:9/youtrack" });
    for (const seed of [
      "https://127.0.0.1:9/youtrack/issue/ABC-1",
      "http://127.0.0.1:9/issue/ABC-1",
    ])
      await expect(buildYouTrackGraph(reader, seed, options), seed).rejects.toThrow(/disagree/);
    const ok = await buildYouTrackGraph(reader, "http://127.0.0.1:9/youtrack/issue/ABC-1", options);
    expect(ok.baseUrl).toBe("http://127.0.0.1:9/youtrack");
  });

  test("rejects a seed URL for another base and invalid limits before reading", async () => {
    const reader = fakeYouTrack({ "ABC-1": {} });
    await expect(
      buildYouTrackGraph(reader, "https://other.youtrack.cloud/issue/ABC-1", options),
    ).rejects.toThrow(/disagree/);
    await expect(buildYouTrackGraph(reader, "ABC-1", { ...options, maxDepth: 9 })).rejects.toThrow(
      RangeError,
    );
    await expect(buildYouTrackGraph(reader, "ABC-1", { ...options, maxPages: 0 })).rejects.toThrow(
      RangeError,
    );
  });

  test("an unreadable seed throws its error code", async () => {
    await expect(build({}, "ABC-1")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("a link with an unknown direction marks the issue partial", async () => {
    const reader = fakeYouTrack({
      "ABC-1": { links: [{ type: "Depend", direction: "OUTWARD", targets: ["ABC-2"] }] },
      "ABC-2": {},
    });
    const get = reader.get.bind(reader);
    const report = await buildYouTrackGraph(
      {
        ...reader,
        async get(path, query) {
          const value = await get(path, query);
          return path.endsWith("/links")
            ? (value as Array<Record<string, unknown>>).map((link) => ({
                ...link,
                direction: "SIDEWAYS",
              }))
            : value;
        },
      },
      "ABC-1",
      { ...options, maxDepth: 0 },
    );
    expect(report.nodes[0].edges).toEqual([]);
    expect(report.coverage.partial).toEqual([key("ABC-1")]);
  });

  test("Markdown escapes titles and prints edges by identifier", async () => {
    const report = await build({
      "ABC-1": {
        summary: "# Fix *this*",
        links: [{ type: "Depend", direction: "OUTWARD", targets: ["ABC-2"] }],
      },
      "ABC-2": {},
    });
    const markdown = renderYouTrack(report);
    expect(markdown).toContain("# YouTrack graph · acme.youtrack.cloud");
    expect(markdown).toContain("## ABC-1 · \\# Fix \\*this\\*");
    expect(markdown).toContain("- → Depend: ABC-2");
  });
});

function prefixLength() {
  return `youtrack:${AUTHORITY}:`.length;
}
