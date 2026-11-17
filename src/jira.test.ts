import { describe, expect, test } from "vitest";
import {
  buildJiraGraph,
  JiraReadError,
  type JiraReader,
  jiraNodeKey,
  parseJiraLocator,
  parseJiraSite,
  renderJira,
} from "./jira.js";

const SITE = "acme.atlassian.net";
const options = { maxDepth: 1, maxNodes: 80, hubThreshold: 12, concurrency: 2 };

type Item = Record<string, unknown>;

function item(key: string, extra: Item = {}): Item {
  return {
    id: String(key.length * 1000 + Number(key.split("-")[1])),
    key,
    self: `https://${SITE}/rest/api/3/issue/${key}`,
    url: `https://${SITE}/browse/${key}`,
    summary: `Summary ${key}`,
    status: { name: "To Do", statusCategory: { key: "new" } },
    issuetype: { name: "Task", hierarchyLevel: 0 },
    project: { key: key.split("-")[0], name: `Project ${key.split("-")[0]}` },
    updated: "2026-11-01T00:00:00.000+0000",
    issuelinks: [],
    subtasks: [],
    remoteLinks: [],
    ...extra,
  };
}

function envelope(data: Item, warnings?: string[]) {
  return {
    apiVersion: "v2",
    command: "jira.workitem.get",
    data: [data],
    meta: {},
    ...(warnings ? { warnings } : {}),
  };
}

function reader(items: Record<string, unknown>, calls: string[] = []): JiraReader {
  return {
    label: "fixture",
    async issue(key) {
      calls.push(key);
      const value = items[key];
      if (value === undefined) throw new JiraReadError("NOT_FOUND");
      if (value instanceof Error) throw value;
      return value;
    },
  };
}

const link = (id: string, name: string, side: "outwardIssue" | "inwardIssue", key: string) => ({
  id,
  type: { name, inward: `inward ${name}`, outward: `outward ${name}` },
  [side]: { key },
});

describe("Jira locators", () => {
  test("accepts keys and browse URLs and rejects anything else", () => {
    expect(parseJiraLocator("abc-12")).toEqual({ key: "ABC-12" });
    expect(parseJiraLocator(`https://${SITE}/browse/ABC-12`)).toEqual({
      key: "ABC-12",
      site: SITE,
    });
    for (const input of [
      "UTF",
      "-ABC-1",
      "ABC-0",
      "ABC-1 --site x",
      "ftp://acme.atlassian.net/browse/ABC-1",
      "https://user:pw@acme.atlassian.net/browse/ABC-1",
      "https://acme.atlassian.net/projects/ABC",
      "https://[::1]/browse/ABC-1",
    ])
      expect(() => parseJiraLocator(input), input).toThrow(/Jira issue/);
  });

  test("sites are prefixes, domains, cloud IDs, or URLs, never flags", () => {
    expect(parseJiraSite("Acme")).toBe("acme");
    expect(parseJiraSite("https://Acme.atlassian.net/")).toBe(SITE);
    expect(parseJiraSite("00000000-0000-4000-8000-000000000001")).toBe(
      "00000000-0000-4000-8000-000000000001",
    );
    for (const input of ["", "-x", "--output=text", "acme net", "https://acme.atlassian.net/x"])
      expect(() => parseJiraSite(input), input).toThrow(/Jira site/);
  });
});

describe("buildJiraGraph", () => {
  test("reads structured links, parents, subtasks, and remote links with direction", async () => {
    const report = await buildJiraGraph(
      reader({
        "ABC-1": envelope(
          item("ABC-1", {
            parent: { key: "ABC-10" },
            subtasks: [{ key: "ABC-11" }],
            issuelinks: [
              link("100", "Blocks", "outwardIssue", "ABC-2"),
              link("101", "Blocks", "inwardIssue", "ABC-3"),
              link("102", "Relates", "outwardIssue", "ABC-4"),
              link("103", "Duplicate", "outwardIssue", "ABC-5"),
              link("104", "Cloners", "inwardIssue", "ABC-6"),
            ],
            remoteLinks: [
              { id: 7, object: { url: "https://github.com/o/r/pull/9", title: "PR 9" } },
              { id: 8, object: { url: "javascript:alert(1)", title: "bad" } },
            ],
          }),
        ),
        ...Object.fromEntries(
          ["ABC-2", "ABC-3", "ABC-4", "ABC-5", "ABC-6", "ABC-10", "ABC-11"].map((key) => [
            key,
            envelope(item(key)),
          ]),
        ),
      }),
      "ABC-1",
      { ...options, site: SITE, generatedAt: "2026-11-16T00:00:00.000Z" },
    );
    expect(report).toMatchObject({
      schemaVersion: 1,
      source: "jira",
      site: SITE,
      readSource: "fixture",
      generatedAt: "2026-11-16T00:00:00.000Z",
      seeds: [jiraNodeKey(SITE, "ABC-1")],
      coverageComplete: true,
    });
    const root = report.nodes.find((node) => node.identifier === "ABC-1");
    expect(root).toMatchObject({
      provider: "jira",
      authority: SITE,
      projectKey: "ABC",
      issueType: "Task",
      state: { name: "To Do", type: "new" },
      url: `https://${SITE}/browse/ABC-1`,
      fetched: true,
      depth: 0,
    });
    const summary = root?.edges.map((edge) => [
      edge.to.split(":").at(-1),
      edge.relation,
      edge.direction,
      edge.nativeRelation,
    ]);
    expect(summary).toEqual(
      expect.arrayContaining([
        ["ABC-2", "blocks", "outgoing", "Blocks"],
        ["ABC-3", "blocks", "incoming", "Blocks"],
        ["ABC-4", "related", "undirected", "Relates"],
        ["ABC-5", "duplicate_of", "outgoing", "Duplicate"],
        ["ABC-6", "provider_specific", "incoming", "Cloners"],
        ["ABC-10", "parent_of", "incoming", "parent"],
        ["ABC-11", "parent_of", "outgoing", "parent"],
      ]),
    );
    expect(root?.edges).toHaveLength(7);
    expect(root?.externalLinks).toEqual([
      {
        url: "https://github.com/o/r/pull/9",
        title: "PR 9",
        evidence: { kind: "remote-link", id: "7" },
      },
    ]);
    expect(report.nodes).toHaveLength(8);
  });

  test("text mentions never become edges or reads", async () => {
    const calls: string[] = [];
    const report = await buildJiraGraph(
      reader(
        {
          "ABC-1": {
            key: "ABC-1",
            fields: {
              summary: "Root",
              status: { name: "To Do" },
              issuetype: { name: "Task", hierarchyLevel: 0 },
              project: { key: "ABC" },
              subtasks: [],
              description: "Uses UTF-8 and SHA-1, see XYZ-9 and ABC-2",
            },
          },
        },
        calls,
      ),
      "ABC-1",
      { ...options, site: SITE },
    );
    expect(calls).toEqual(["ABC-1"]);
    expect(report.coverageComplete).toBe(true);
    expect(report.nodes).toHaveLength(1);
    expect(report.nodes[0].edges).toEqual([]);
    expect(report.nodes[0].url).toBe(`https://${SITE}/browse/ABC-1`);
    expect(report.scope.textReferences).toBe("not-collected");
  });

  test("same-project links recurse; other projects are read one hop", async () => {
    const calls: string[] = [];
    const report = await buildJiraGraph(
      reader(
        {
          "ABC-1": envelope(
            item("ABC-1", {
              issuelinks: [
                link("1", "Relates", "outwardIssue", "ABC-2"),
                link("2", "Relates", "outwardIssue", "XYZ-1"),
              ],
            }),
          ),
          "ABC-2": envelope(
            item("ABC-2", { issuelinks: [link("3", "Relates", "outwardIssue", "ABC-3")] }),
          ),
          "ABC-3": envelope(item("ABC-3")),
          "XYZ-1": envelope(
            item("XYZ-1", { issuelinks: [link("4", "Relates", "outwardIssue", "XYZ-2")] }),
          ),
        },
        calls,
      ),
      "ABC-1",
      { ...options, maxDepth: 2, site: SITE },
    );
    expect(calls.sort()).toEqual(["ABC-1", "ABC-2", "ABC-3", "XYZ-1"]);
    expect(report.nodes.find((node) => node.identifier === "XYZ-1")?.depth).toBe(1);
    expect(report.coverage.depthBoundaries).toEqual([jiraNodeKey(SITE, "XYZ-1")]);
  });

  test("the node cap reads a one-hop project link before deeper same-project work", async () => {
    const calls: string[] = [];
    const report = await buildJiraGraph(
      reader(
        {
          "ABC-1": envelope(
            item("ABC-1", {
              issuelinks: [
                link("1", "Relates", "outwardIssue", "ABC-2"),
                link("2", "Relates", "outwardIssue", "XYZ-1"),
              ],
            }),
          ),
          "ABC-2": envelope(
            item("ABC-2", { issuelinks: [link("3", "Relates", "outwardIssue", "ABC-3")] }),
          ),
          "ABC-3": envelope(item("ABC-3")),
          "XYZ-1": envelope(item("XYZ-1")),
        },
        calls,
      ),
      "ABC-1",
      { ...options, maxDepth: 3, maxNodes: 3, site: SITE },
    );
    expect(calls.sort()).toEqual(["ABC-1", "ABC-2", "XYZ-1"]);
    expect(report.coverage.cappedOut).toEqual([jiraNodeKey(SITE, "ABC-3")]);
  });

  test("an epic in another project is a boundary, not partial", async () => {
    const report = await buildJiraGraph(
      reader({
        "ABC-1": envelope(
          item("ABC-1", { issuelinks: [link("1", "Relates", "outwardIssue", "XYZ-1")] }),
        ),
        "XYZ-1": envelope(item("XYZ-1", { issuetype: { name: "Epic", hierarchyLevel: 1 } })),
      }),
      "ABC-1",
      { ...options, maxDepth: 2, site: SITE },
    );
    expect(report.coverageComplete).toBe(true);
    expect(report.coverage.depthBoundaries).toEqual([jiraNodeKey(SITE, "XYZ-1")]);
  });

  test("unreadable, renamed, and foreign-site work stays visible as failures", async () => {
    const report = await buildJiraGraph(
      reader({
        "ABC-1": envelope(
          item("ABC-1", {
            issuelinks: [
              link("1", "Blocks", "outwardIssue", "ABC-2"),
              link("2", "Blocks", "outwardIssue", "ABC-3"),
              link("3", "Blocks", "outwardIssue", "ABC-4"),
              link("4", "Blocks", "outwardIssue", "ABC-5"),
            ],
          }),
        ),
        "ABC-2": new JiraReadError("NOT_FOUND"),
        "ABC-3": envelope(item("ABC-9")),
        "ABC-4": envelope(item("ABC-4", { url: "https://other.atlassian.net/browse/ABC-4" })),
        "ABC-5": { ok: false, error: { code: "TWG_COMMAND_FAILED", message: "no access" } },
      }),
      "ABC-1",
      { ...options, site: SITE },
    );
    expect(report.coverageComplete).toBe(false);
    const errors = Object.fromEntries(
      report.nodes.filter((node) => !node.fetched).map((node) => [node.identifier, node.error]),
    );
    expect(errors).toEqual({
      "ABC-2": "NOT_FOUND",
      "ABC-3": "IDENTITY_MISMATCH",
      "ABC-4": "SITE_MISMATCH",
      "ABC-5": "TWG_COMMAND_FAILED",
    });
    expect(report.coverage.failed).toHaveLength(4);
  });

  test("TWG warnings mark the node partial", async () => {
    const report = await buildJiraGraph(
      reader({
        "ABC-1": envelope(item("ABC-1", { remoteLinks: undefined }), [
          "Could not fetch Jira remote links: 403. Issue data returned without remoteLinks.",
        ]),
      }),
      "ABC-1",
      { ...options, site: SITE },
    );
    expect(report.coverageComplete).toBe(false);
    expect(report.coverage.partial).toEqual([jiraNodeKey(SITE, "ABC-1")]);
    expect(report.nodes[0].coverage).toEqual([
      { source: "twg warnings", pages: 1, complete: false, reason: "read-failed" },
    ]);
  });

  test("issues above the sub-task level are partial because their children are not listed", async () => {
    const report = await buildJiraGraph(
      reader({
        "ABC-1": envelope(item("ABC-1", { issuetype: { name: "Epic", hierarchyLevel: 1 } })),
      }),
      "ABC-1",
      { ...options, site: SITE },
    );
    expect(report.coverageComplete).toBe(false);
    expect(report.nodes[0].coverage).toEqual([
      { source: "child issues", pages: 0, complete: false },
    ]);
    expect(renderJira(report)).toContain("- Incomplete child issues: not read");
  });

  describe("an issue whose hierarchy level is unknown is not counted as complete", () => {
    const { subtasks: _, ...withoutSubtasks } = item("ABC-1");
    test.each([
      ["an issue type without hierarchyLevel", item("ABC-1", { issuetype: { name: "Epic" } })],
      ["an issue type printed as a string", item("ABC-1", { issuetype: "Epic" })],
      ["no issue type", item("ABC-1", { issuetype: undefined })],
      [
        "a non-integer hierarchyLevel",
        item("ABC-1", { issuetype: { name: "Epic", hierarchyLevel: "1" } }),
      ],
      ["a base issue without a subtasks field", withoutSubtasks],
      ["a base issue with a null subtasks field", item("ABC-1", { subtasks: null })],
    ])("%s is partial when expanded", async (_name, payload) => {
      const report = await buildJiraGraph(reader({ "ABC-1": envelope(payload) }), "ABC-1", {
        ...options,
        site: SITE,
      });
      expect(report.coverageComplete).toBe(false);
      expect(report.coverage.partial).toEqual([jiraNodeKey(SITE, "ABC-1")]);
      const output = renderJira(report);
      expect(output).toContain("Coverage: partial");
      expect(output).toContain("- Incomplete child issues: not read");
    });

    test("one at the depth limit is a depth boundary", async () => {
      const report = await buildJiraGraph(
        reader({ "ABC-1": envelope(item("ABC-1", { issuetype: { name: "Epic" } })) }),
        "ABC-1",
        { ...options, maxDepth: 0, site: SITE },
      );
      expect(report.coverage.depthBoundaries).toEqual([jiraNodeKey(SITE, "ABC-1")]);
    });

    test("a string issue type still names the type", async () => {
      const report = await buildJiraGraph(
        reader({ "ABC-1": envelope(item("ABC-1", { issuetype: "Epic" })) }),
        "ABC-1",
        { ...options, site: SITE },
      );
      expect(report.nodes[0].issueType).toBe("Epic");
    });
  });

  test.each(["Sub-task", "Subtask"])("a string issue type %s is a sub-task", async (issuetype) => {
    const report = await buildJiraGraph(
      reader({ "ABC-1": envelope(item("ABC-1", { issuetype })) }),
      "ABC-1",
      { ...options, site: SITE },
    );
    expect(report.coverageComplete).toBe(true);
    expect(report.coverage.partial).toEqual([]);
  });

  test.each([
    ["meta.partial", { partial: true }],
    ["partial coverage", { evidence: { coverage: { status: "partial" } } }],
    ["truncation", { evidence: { truncation: { truncated: true } } }],
  ])("twg %s marks the node partial", async (_name, meta) => {
    const report = await buildJiraGraph(
      reader({ "ABC-1": { ...envelope(item("ABC-1")), meta } }),
      "ABC-1",
      { ...options, site: SITE },
    );
    expect(report.coverageComplete).toBe(false);
    expect(report.coverage.partial).toEqual([jiraNodeKey(SITE, "ABC-1")]);
  });

  test.each([
    ["the sub-task flag", { name: "Sub-task", subtask: true }],
    ["hierarchyLevel -1", { name: "Sub-task", hierarchyLevel: -1 }],
  ])("a sub-task known by %s is complete without a subtasks field", async (_name, issuetype) => {
    const { subtasks: _, ...payload } = item("ABC-1", { issuetype });
    const report = await buildJiraGraph(reader({ "ABC-1": envelope(payload) }), "ABC-1", {
      ...options,
      site: SITE,
    });
    expect(report.coverageComplete).toBe(true);
    expect(report.nodes[0].coverage).toEqual([]);
  });

  test("a story under an epic at the depth limit is complete and lists the epic as a boundary", async () => {
    const report = await buildJiraGraph(
      reader({
        "ABC-1": envelope(
          item("ABC-1", {
            issuetype: { name: "Story", hierarchyLevel: 0 },
            parent: { key: "ABC-2" },
          }),
        ),
        "ABC-2": envelope(item("ABC-2", { issuetype: { name: "Epic", hierarchyLevel: 1 } })),
      }),
      "ABC-1",
      { ...options, site: SITE },
    );
    expect(report.coverageComplete).toBe(true);
    expect(report.coverage.partial).toEqual([]);
    expect(report.coverage.depthBoundaries).toEqual([jiraNodeKey(SITE, "ABC-2")]);
    expect(report.nodes.find((node) => node.identifier === "ABC-2")?.coverage).toEqual([]);
    const output = renderJira(report);
    expect(output).toContain("Coverage: complete within requested scope · 2 nodes · depth 1");
    expect(output).not.toContain("Incomplete child issues");
  });

  test("an epic seed read at depth 0 is a depth boundary, not partial", async () => {
    const report = await buildJiraGraph(
      reader({
        "ABC-1": envelope(item("ABC-1", { issuetype: { name: "Epic", hierarchyLevel: 1 } })),
      }),
      "ABC-1",
      { ...options, maxDepth: 0, site: SITE },
    );
    expect(report.coverageComplete).toBe(true);
    expect(report.coverage.partial).toEqual([]);
    expect(report.coverage.depthBoundaries).toEqual([jiraNodeKey(SITE, "ABC-1")]);
    expect(report.nodes[0].coverage).toEqual([]);
    expect(renderJira(report)).not.toContain("Incomplete child issues");
  });

  test("an epic expanded before the depth limit is partial", async () => {
    const report = await buildJiraGraph(
      reader({
        "ABC-1": envelope(item("ABC-1", { parent: { key: "ABC-2" } })),
        "ABC-2": envelope(item("ABC-2", { issuetype: { name: "Epic", hierarchyLevel: 1 } })),
      }),
      "ABC-1",
      { ...options, maxDepth: 2, site: SITE },
    );
    expect(report.coverageComplete).toBe(false);
    expect(report.coverage.partial).toEqual([jiraNodeKey(SITE, "ABC-2")]);
    expect(report.coverage.depthBoundaries).toEqual([]);
  });

  test("an API gateway self link never names the site", async () => {
    const report = await buildJiraGraph(
      reader({
        "ABC-1": envelope(
          item("ABC-1", {
            url: undefined,
            self: "https://api.atlassian.com/ex/jira/0000/rest/api/3/issue/1",
          }),
        ),
      }),
      "ABC-1",
      { ...options, site: SITE },
    );
    expect(report.site).toBe(SITE);
    expect(report.nodes[0].url).toBe(`https://${SITE}/browse/ABC-1`);
  });

  test("the node cap keeps nearer work and reports the rest", async () => {
    const report = await buildJiraGraph(
      reader({
        "ABC-1": envelope(
          item("ABC-1", {
            issuelinks: [2, 3, 4].map((n) =>
              link(String(n), "Relates", "outwardIssue", `ABC-${n}`),
            ),
          }),
        ),
        "ABC-2": envelope(item("ABC-2")),
        "ABC-3": envelope(item("ABC-3")),
        "ABC-4": envelope(item("ABC-4")),
      }),
      "ABC-1",
      { ...options, maxNodes: 2, site: SITE },
    );
    expect(report.nodes).toHaveLength(2);
    expect(report.coverage.cappedOut).toHaveLength(2);
    expect(report.coverageComplete).toBe(false);
  });

  test("an unexpanded hub makes coverage partial and is marked in Markdown", async () => {
    const calls: string[] = [];
    const report = await buildJiraGraph(
      reader(
        {
          "ABC-1": envelope(
            item("ABC-1", { issuelinks: [link("1", "Relates", "outwardIssue", "ABC-2")] }),
          ),
          "ABC-2": envelope(
            item("ABC-2", {
              issuelinks: [3, 4].map((n) => link(String(n), "Relates", "outwardIssue", `ABC-${n}`)),
            }),
          ),
        },
        calls,
      ),
      "ABC-1",
      { ...options, maxDepth: 2, hubThreshold: 1, site: SITE },
    );
    expect(calls).toEqual(["ABC-1", "ABC-2"]);
    expect(report.coverage).toMatchObject({
      failed: [],
      partial: [],
      cappedOut: [],
      hubs: [jiraNodeKey(SITE, "ABC-2")],
      depthBoundaries: [],
    });
    expect(report.coverageComplete).toBe(false);
    expect(renderJira(report)).toContain("Status: To Do · Task · hub not expanded");
  });

  test("a subtasks field that is not a list makes the issue unavailable", async () => {
    const report = await buildJiraGraph(
      reader({
        "ABC-1": envelope(item("ABC-1", { parent: { key: "ABC-2" } })),
        "ABC-2": envelope(item("ABC-2", { subtasks: "ABC-1" })),
      }),
      "ABC-1",
      { ...options, site: SITE },
    );
    expect(report.nodes.find((node) => node.identifier === "ABC-2")).toMatchObject({
      fetched: false,
      error: "INVALID_PAYLOAD",
    });
    expect(report.coverageComplete).toBe(false);
  });

  test("a failed seed read fails the run with the TWG reason", async () => {
    await expect(
      buildJiraGraph(
        reader({ "ABC-1": new JiraReadError("TWG_NOT_FOUND", "twg is not installed") }),
        "ABC-1",
        { ...options, site: SITE },
      ),
    ).rejects.toThrow(/twg is not installed/);
    await expect(
      buildJiraGraph(reader({ "ABC-1": envelope(item("ABC-1")) }), "ABC-1", {
        ...options,
        site: "other.atlassian.net",
      }),
    ).rejects.toThrow(/SITE_MISMATCH/);
  });

  test("the browse URL names the site and must agree with --site", async () => {
    const report = await buildJiraGraph(
      reader({ "ABC-1": envelope(item("ABC-1")) }),
      `https://${SITE}/browse/ABC-1`,
      options,
    );
    expect(report.site).toBe(SITE);
    await expect(
      buildJiraGraph(reader({}), `https://${SITE}/browse/ABC-1`, {
        ...options,
        site: "other.atlassian.net",
      }),
    ).rejects.toThrow(/disagree/);
  });

  test("a site prefix or cloud ID with a browse URL is checked against the response", async () => {
    for (const site of ["acme", "00000000-0000-4000-8000-000000000001"]) {
      const report = await buildJiraGraph(
        reader({ "ABC-1": envelope(item("ABC-1")) }),
        `https://${SITE}/browse/ABC-1`,
        { ...options, site },
      );
      expect(report.site, site).toBe(SITE);
    }
    const foreign = item("ABC-1", {
      url: "https://other.atlassian.net/browse/ABC-1",
      self: "https://other.atlassian.net/rest/api/3/issue/1",
    });
    await expect(
      buildJiraGraph(reader({ "ABC-1": envelope(foreign) }), `https://${SITE}/browse/ABC-1`, {
        ...options,
        site: "acme",
      }),
    ).rejects.toThrow(/SITE_MISMATCH/);
    await expect(
      buildJiraGraph(reader({}), `https://${SITE}/browse/ABC-1`, { ...options, site: "other" }),
    ).rejects.toThrow(/disagree/);
    const unnamed = item("ABC-1", {
      url: undefined,
      self: "https://api.atlassian.com/ex/jira/0000/rest/api/3/issue/1",
    });
    await expect(
      buildJiraGraph(reader({ "ABC-1": envelope(unnamed) }), `https://${SITE}/browse/ABC-1`, {
        ...options,
        site: "00000000-0000-4000-8000-000000000001",
      }),
    ).rejects.toThrow(/SITE_UNKNOWN/);
    const prefixed = await buildJiraGraph(
      reader({ "ABC-1": envelope(unnamed) }),
      `https://${SITE}/browse/ABC-1`,
      { ...options, site: "acme" },
    );
    expect(prefixed.site).toBe(SITE);
  });

  test("a site prefix without a browse URL must name the site twg reports", async () => {
    const foreign = item("ABC-1", { url: "https://other.atlassian.net/browse/ABC-1" });
    await expect(
      buildJiraGraph(reader({ "ABC-1": envelope(foreign) }), "ABC-1", { ...options, site: "acme" }),
    ).rejects.toThrow(/SITE_MISMATCH/);
  });

  test("a linked issue on another site is unavailable when the seed names no host", async () => {
    const report = await buildJiraGraph(
      reader({
        "ABC-1": envelope(
          item("ABC-1", {
            url: undefined,
            self: "https://api.atlassian.com/ex/jira/0000/rest/api/3/issue/1",
            issuelinks: [link("1", "Relates", "outwardIssue", "ABC-2")],
          }),
        ),
        "ABC-2": envelope(item("ABC-2", { url: "https://other.atlassian.net/browse/ABC-2" })),
      }),
      "ABC-1",
      { ...options, site: "acme" },
    );
    expect(report.nodes.find((node) => node.identifier === "ABC-2")).toMatchObject({
      fetched: false,
      error: "SITE_MISMATCH",
    });
    expect(report.coverageComplete).toBe(false);
  });
});

describe("twg payloads", () => {
  // `twg jira workitem get KEY --output json` (1.4.x) for one key: fields flattened into the item,
  // `url` built from the site base URL, `remoteLinks` merged in, and a gateway `self`.
  const twgGet = {
    apiVersion: "v2",
    command: "jira.workitem.get",
    request: { issueIdOrKey: "ABC-1", fields: ["summary", "status"], remoteLinks: true },
    data: [
      {
        expand: "renderedFields,names,schema",
        id: "10001",
        self: "https://api.atlassian.com/ex/jira/00000000-0000-4000-8000-000000000001/rest/api/3/issue/10001",
        key: "ABC-1",
        summary: "Root",
        status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
        issuetype: { name: "Story", hierarchyLevel: 0 },
        project: { key: "ABC" },
        subtasks: [],
        issuelinks: [link("200", "Blocks", "outwardIssue", "ABC-2")],
        updated: "2026-11-01T00:00:00.000+0000",
        url: `https://${SITE}/browse/ABC-1`,
        remoteLinks: [{ id: 5, object: { url: "https://github.com/o/r/pull/5", title: "PR 5" } }],
      },
    ],
    meta: {
      resourceClass: "entity",
      sourceMode: "native",
      resourceType: "jira.workitem",
      backend: "agg",
      acquisition: { requested: 1, returned: 1, succeeded: 1, failed: 0, omitted: 0, truncated: 0 },
      evidence: {
        provenance: { source: "teamwork-graph" },
        coverage: { status: "complete", covered: ["ABC-1"] },
        truncation: { truncated: false },
      },
    },
  };

  test("reads twg get output and takes the site from its url", async () => {
    const report = await buildJiraGraph(
      reader({ "ABC-1": twgGet, "ABC-2": envelope(item("ABC-2")) }),
      "ABC-1",
      { ...options, site: "acme" },
    );
    expect(report.site).toBe(SITE);
    expect(report.coverageComplete).toBe(true);
    const root = report.nodes.find((node) => node.identifier === "ABC-1");
    expect(root).toMatchObject({
      key: jiraNodeKey(SITE, "ABC-1"),
      nativeId: "10001",
      title: "Root",
      state: { name: "In Progress", type: "indeterminate" },
      url: `https://${SITE}/browse/ABC-1`,
    });
    expect(root?.edges.map((edge) => [edge.to, edge.nativeRelation])).toEqual([
      [jiraNodeKey(SITE, "ABC-2"), "Blocks"],
    ]);
    expect(root?.externalLinks.map((entry) => entry.url)).toEqual([
      "https://github.com/o/r/pull/5",
    ]);
  });

  test("reads a { data: { issue } } envelope with fields nested and siblings under data", async () => {
    const report = await buildJiraGraph(
      reader({
        "ABC-1": {
          data: {
            issue: {
              id: "10001",
              key: "ABC-1",
              self: `https://${SITE}/rest/api/3/issue/10001`,
              fields: {
                summary: "Root",
                status: { name: "To Do" },
                project: { key: "ABC" },
                issuetype: { name: "Task", hierarchyLevel: 0 },
                issuelinks: [],
                subtasks: [],
              },
            },
            remoteLinks: [{ id: 1, object: { url: "https://github.com/o/r/pull/1" } }],
            warnings: ["Could not fetch Jira comments: 403."],
          },
        },
      }),
      "ABC-1",
      options,
    );
    expect(report.site).toBe(SITE);
    expect(report.nodes[0].url).toBe(`https://${SITE}/browse/ABC-1`);
    expect(report.nodes[0].externalLinks.map((entry) => entry.url)).toEqual([
      "https://github.com/o/r/pull/1",
    ]);
    expect(report.coverage.partial).toEqual([jiraNodeKey(SITE, "ABC-1")]);
  });

  test("a gateway self without a url leaves the site to --site", async () => {
    const { url: _, ...withoutUrl } = twgGet.data[0];
    await expect(
      buildJiraGraph(reader({ "ABC-1": { ...twgGet, data: [withoutUrl] } }), "ABC-1", options),
    ).rejects.toThrow(/SITE_UNKNOWN/);
  });

  test("an error under data keeps its twg code", async () => {
    await expect(
      buildJiraGraph(
        reader({
          "ABC-1": {
            apiVersion: "v2",
            command: "jira.workitem.get",
            data: { ok: false, error: { code: "AUTH_INVALID", message: "Authentication failed." } },
          },
        }),
        "ABC-1",
        { ...options, site: SITE },
      ),
    ).rejects.toThrow(/AUTH_INVALID/);
  });
});

describe("renderJira", () => {
  test("escapes Jira text and states coverage", async () => {
    const report = await buildJiraGraph(
      reader({
        "ABC-1": envelope(
          item("ABC-1", {
            summary: "Fix [link](javascript:x) <b>*now*</b>\u0007 ###",
            issuelinks: [link("1", "Blocks", "inwardIssue", "ABC-2")],
          }),
        ),
        "ABC-2": new JiraReadError("NOT_FOUND"),
      }),
      "ABC-1",
      { ...options, site: SITE },
    );
    const output = renderJira(report);
    expect(output).toContain(`# Jira graph · ${SITE}`);
    expect(output).toContain("Coverage: partial · 2 nodes · depth 1");
    expect(output).toContain(
      "## ABC-1 · Fix \\[link\\](javascript:x) \\<b\\>\\*now\\*\\</b\\>  \\#\\#\\#",
    );
    expect(output).toContain("- ← Blocks: ABC-2");
    expect(output).toContain("Read failed: NOT_FOUND");
    expect(output).toContain("Text mentions are not collected.");
  });
});
