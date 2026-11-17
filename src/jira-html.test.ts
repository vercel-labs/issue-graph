import { expect, test } from "vitest";
import { buildJiraGraph, JiraReadError, type JiraReader, jiraNodeKey } from "./jira.js";
import { jiraDashboardModel } from "./jira-html.js";
import { parseModel } from "./model-validation.js";

const SITE = "acme.atlassian.net";
const options = { maxDepth: 1, maxNodes: 80, hubThreshold: 12, concurrency: 2 };

function item(key: string, extra: Record<string, unknown> = {}) {
  return {
    data: [
      {
        key,
        url: `https://${SITE}/browse/${key}`,
        summary: `Summary ${key}`,
        status: { name: "To Do", statusCategory: { key: "new" } },
        issuetype: { name: "Task", hierarchyLevel: 0 },
        project: { key: key.split("-")[0] },
        issuelinks: [],
        subtasks: [],
        remoteLinks: [],
        ...extra,
      },
    ],
  };
}

function reader(items: Record<string, unknown>): JiraReader {
  return {
    label: "fixture",
    async issue(key) {
      const value = items[key];
      if (value === undefined) throw new JiraReadError("NOT_FOUND");
      return value;
    },
  };
}

const key = (id: string) => jiraNodeKey(SITE, id);

async function model() {
  const report = await buildJiraGraph(
    reader({
      "ABC-1": item("ABC-1", {
        issuelinks: [
          { id: "1", type: { name: "Blocks" }, outwardIssue: { key: "ABC-2" } },
          { id: "2", type: { name: "Duplicate" }, inwardIssue: { key: "ABC-4" } },
          { id: "3", type: { name: "Relates" }, outwardIssue: { key: "PAY-7" } },
        ],
        remoteLinks: [{ id: 9, object: { url: "https://github.com/o/r/pull/5", title: "Fix" } }],
      }),
      "ABC-2": item("ABC-2", {
        status: { name: "Done", statusCategory: { key: "done" } },
        issuelinks: [{ id: "1", type: { name: "Blocks" }, inwardIssue: { key: "ABC-1" } }],
      }),
      "PAY-7": item("PAY-7", {
        issuelinks: [{ id: "3", type: { name: "Relates" }, inwardIssue: { key: "ABC-1" } }],
      }),
    }),
    "ABC-1",
    options,
  );
  return { report, model: jiraDashboardModel(report) };
}

test("saves one model per site and seed project that the dashboard accepts", async () => {
  const { model: result } = await model();
  expect(result.id).toBe(`jira:${SITE}:project:ABC`);
  expect(result.label).toBe(`${SITE} / ABC`);
  expect(result.provider).toMatchObject({ id: "jira", name: "Jira" });
  expect(parseModel(JSON.parse(JSON.stringify(result)))).toBeTruthy();
});

test("keeps link direction, deduplicates both endpoints, and maps status categories", async () => {
  const { model: result } = await model();
  const root = result.nodes[key("ABC-1")];
  expect(root.out.map((edge) => [edge.to, edge.via])).toEqual([
    [key("ABC-2"), "blocks"],
    [key("PAY-7"), "Relates"],
  ]);
  expect(root.in.map((edge) => [edge.from, edge.via])).toEqual([[key("ABC-4"), "duplicated by"]]);
  expect(result.nodes[key("ABC-2")].in).toHaveLength(1);
  expect(result.nodes[key("ABC-2")].state).toBe("CLOSED");
  expect(root.state).toBe("OPEN");
  expect(result.nodes[key("ABC-4")]).toMatchObject({
    state: "UNKNOWN",
    flags: ["Issue unavailable"],
  });
  expect(root.attachments?.[0].evidence.kind).toBe("remote-link");
});

test("a partial run says so in the dashboard coverage", async () => {
  const { report, model: result } = await model();
  expect(report.coverageComplete).toBe(false);
  expect(result.coverage?.complete).toBe(false);
  expect(result.coverage?.warnings).toContain("1 issues unavailable");
});
