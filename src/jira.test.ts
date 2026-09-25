import { describe, expect, test } from "vitest";
import {
  buildJiraReport,
  fetchJiraNode,
  JiraPayloadError,
  jiraDepthForEdge,
  jiraIssueKey,
  jiraNodeKey,
  normalizeJiraKey,
  normalizeJiraPayload,
  renderJiraReport,
} from "./jira.js";

const fixture = {
  apiVersion: "v2",
  command: "jira.workitem.get",
  data: {
    items: [
      {
        input: "PROJ-1",
        issue: {
          id: "10001",
          key: "PROJ-1",
          self: "https://demo.atlassian.net/rest/api/3/issue/10001",
          fields: {
            summary: "Root issue",
            status: { name: "In Progress" },
            issuetype: { name: "Story" },
            updated: "2026-09-26T01:02:03.000Z",
            assignee: { displayName: "Example User" },
            description: {
              type: "doc",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "PROJ-3 and TEAM-4" }] },
              ],
            },
            issuelinks: [
              {
                type: { name: "Blocks", outward: "blocks", inward: "is blocked by" },
                outwardIssue: {
                  key: "PROJ-2",
                  self: "https://demo.atlassian.net/rest/api/3/issue/2",
                },
              },
            ],
            comment: { comments: [{ body: "Follow up in PROJ-5" }] },
          },
        },
      },
    ],
    remoteLinks: [
      { object: { url: "https://demo.atlassian.net/browse/PROJ-6" } },
      { object: { url: "https://github.com/vercel-labs/issue-graph/pull/7" } },
    ],
  },
};

describe("Jira identity", () => {
  test("normalizes issue keys without accepting arbitrary input", () => {
    expect(normalizeJiraKey("proj_2-17")).toBe("PROJ_2-17");
    expect(normalizeJiraKey("not a key")).toBeNull();
    expect(jiraNodeKey("proj-1")).toBe("jira:PROJ-1");
    expect(jiraIssueKey("jira:PROJ-1")).toBe("PROJ-1");
    expect(jiraIssueKey("github:o/r#1")).toBeNull();
  });
});

describe("normalizeJiraPayload", () => {
  test("extracts Jira fields, links, ADF text references, comments, and remote links", () => {
    const node = normalizeJiraPayload(fixture, "PROJ-1", 0);
    expect(node).toMatchObject({
      key: "jira:PROJ-1",
      issueKey: "PROJ-1",
      title: "Root issue",
      status: "In Progress",
      issueType: "Story",
      assignee: "Example User",
      depth: 0,
      fetched: true,
      url: "https://demo.atlassian.net/browse/PROJ-1",
    });
    expect(node.edges).toEqual([
      {
        to: "jira:PROJ-2",
        via: "issue-link",
        relation: "blocks",
        url: "https://demo.atlassian.net/rest/api/3/issue/2",
      },
      { to: "jira:PROJ-3", via: "text" },
      { to: "jira:TEAM-4", via: "text" },
      { to: "jira:PROJ-5", via: "text" },
      {
        to: "jira:PROJ-6",
        via: "remote-link",
        url: "https://demo.atlassian.net/browse/PROJ-6",
      },
      {
        to: "github:vercel-labs/issue-graph#7",
        via: "remote-link",
        url: "https://github.com/vercel-labs/issue-graph/pull/7",
      },
    ]);
    expect(node.externalLinks).toHaveLength(2);
  });

  test("selects the requested issue from a batch envelope", () => {
    const payload = {
      data: [{ key: "OTHER-1", fields: { summary: "wrong" } }, fixture.data.items[0]],
    };
    expect(normalizeJiraPayload(payload, "PROJ-1", 2).title).toBe("Root issue");
  });

  test("reports a stable TWG error when no issue is present", () => {
    expect(() =>
      normalizeJiraPayload(
        {
          ok: false,
          error: { message: "Issue does not exist or you do not have permission to see it." },
        },
        "PROJ-404",
        0,
      ),
    ).toThrow("Issue does not exist or you do not have permission");
    expect(() => normalizeJiraPayload({}, "not-a-key", 0)).toThrow(JiraPayloadError);
  });
});

describe("Jira crawl integration", () => {
  test("keeps inaccessible nodes as explicit incomplete evidence", async () => {
    const node = await fetchJiraNode(
      { getIssue: async () => Promise.reject(new Error("access denied\nsecret detail")) },
      "jira:PROJ-9",
      1,
    );
    expect(node).toMatchObject({
      issueKey: "PROJ-9",
      depth: 1,
      fetched: false,
      fetchError: "access denied secret detail",
    });
  });

  test("recurses within the seed project and bounds cross-project references", () => {
    const depth = jiraDepthForEdge("PROJ-1");
    expect(depth({ edge: { to: "jira:PROJ-2" }, sourceDepth: 0, maxDepth: 3 })).toBe(1);
    expect(depth({ edge: { to: "jira:TEAM-2" }, sourceDepth: 0, maxDepth: 3 })).toBe(3);
    expect(depth({ edge: { to: "github:o/r#2" }, sourceDepth: 0, maxDepth: 3 })).toBeNull();
  });

  test("builds versioned JSON and safe Markdown with coverage", () => {
    const root = normalizeJiraPayload(fixture, "PROJ-1", 0);
    root.title = "Root\n## injected";
    const failed = {
      ...root,
      key: "jira:PROJ-2",
      issueKey: "PROJ-2",
      depth: 1,
      fetched: false,
      fetchError: "denied",
      edges: [],
    };
    const result = {
      nodes: new Map([
        [root.key, root],
        [failed.key, failed],
      ]),
      cappedOut: new Set(["jira:PROJ-7"]),
    };
    const report = buildJiraReport(
      "PROJ-1",
      "demo",
      { maxDepth: 2, maxNodes: 80, hubThreshold: 12, concurrency: 4 },
      result,
      "2026-09-26T00:00:00.000Z",
    );
    expect(report.schemaVersion).toBe(1);
    expect(report.coverageComplete).toBe(false);
    expect(report.coverage).toEqual({
      fetched: 1,
      failed: ["PROJ-2"],
      cappedOut: ["jira:PROJ-7"],
    });
    const markdown = renderJiraReport(report);
    expect(markdown).toContain("Root ## injected");
    expect(markdown).toContain("Coverage: incomplete");
    expect(markdown).toContain("FAILED: denied");
  });
});
