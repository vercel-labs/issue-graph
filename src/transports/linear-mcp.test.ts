import { expect, test } from "vitest";
import { buildLinearGraph, buildLinearProject } from "../linear.js";
import { linearMcpReader } from "./linear-mcp.js";
import type { McpClient } from "./mcp.js";
import { McpError } from "./mcp.js";

const ORG = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Issues as Linear's MCP get_issue returns them. */
function mcpIssue(
  n: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> & { id: string; uuid: string; projectId?: string } {
  return {
    id: `ENG-${n}`,
    uuid: uuid(n),
    title: `Issue ${n}`,
    description: null,
    url: `https://linear.app/fixture/issue/ENG-${n}/x`,
    updatedAt: "2026-10-01T00:00:00.000Z",
    archivedAt: null,
    status: "In Progress",
    statusType: "started",
    team: "Engineering",
    teamId: "33333333-3333-4333-8333-333333333333",
    attachments: [],
    relations: { blocks: [], blockedBy: [], relatedTo: [], duplicateOf: null },
    ...extra,
  };
}

function client(
  issues: Record<string, ReturnType<typeof mcpIssue>>,
  children: Record<string, string[]> = {},
) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const byLocator = (locator: string) =>
    Object.values(issues).find((issue) => issue.id === locator || issue.uuid === locator);
  const fake: McpClient = {
    async call(tool, args) {
      calls.push([tool, args]);
      if (tool === "get_workspace")
        return { id: ORG, name: "Fixture", url: "https://linear.app/fixture" };
      if (tool === "get_project")
        return { name: "Project", url: "https://linear.app/fixture/project/p" };
      if (tool === "get_issue") {
        const found = byLocator(String(args.id));
        if (!found) throw new McpError("NOT_FOUND");
        return found;
      }
      if (tool === "list_issues") {
        if (args.parentId)
          return {
            issues: (children[String(args.parentId)] ?? []).map((id) => issues[id]),
            hasNextPage: false,
          };
        return {
          issues: Object.values(issues).filter((issue) => issue.projectId === args.project),
          hasNextPage: false,
        };
      }
      throw new Error(`unexpected tool ${tool}`);
    },
  };
  return { fake, calls };
}

const options = {
  maxDepth: 1,
  maxNodes: 20,
  maxPages: 3,
  hubThreshold: 12,
  concurrency: 2,
  generatedAt: "2026-10-17T00:00:00.000Z",
};

test("MCP relations, sub-issues, and attachments become the same graph edges as GraphQL", async () => {
  const { fake } = client(
    {
      "ENG-1": mcpIssue(1, {
        relations: {
          blocks: ["ENG-2"],
          blockedBy: [{ id: "ENG-3" }],
          relatedTo: [],
          duplicateOf: null,
        },
        attachments: [{ id: "a", title: "PR", url: "https://github.com/o/r/pull/1" }],
      }),
      "ENG-2": mcpIssue(2),
      "ENG-3": mcpIssue(3),
      "ENG-4": mcpIssue(4, { parentId: "ENG-1" }),
    },
    { "ENG-1": ["ENG-4"] },
  );
  const report = await buildLinearGraph(
    linearMcpReader({ token: "t", client: fake }),
    "ENG-1",
    options,
  );
  expect(report.coverageComplete).toBe(true);
  expect(report.workspace).toEqual({ id: ORG, slug: "fixture", name: "Fixture" });
  const root = report.nodes.find((node) => node.identifier === "ENG-1");
  expect(root?.externalLinks.map((link) => link.url)).toEqual(["https://github.com/o/r/pull/1"]);
  const edges = Object.fromEntries(
    (root?.edges ?? []).map((edge) => [
      edge.to.split(":").pop(),
      `${edge.relation}:${edge.direction}`,
    ]),
  );
  expect(edges).toEqual({
    [uuid(2)]: "blocks:outgoing",
    [uuid(3)]: "blocks:incoming",
    [uuid(4)]: "parent_of:outgoing",
  });
  expect(report.nodes.map((node) => node.identifier).sort()).toEqual([
    "ENG-1",
    "ENG-2",
    "ENG-3",
    "ENG-4",
  ]);
});

test("a child seed links to its parent through parentId", async () => {
  const { fake } = client(
    { "ENG-1": mcpIssue(1), "ENG-4": mcpIssue(4, { parentId: "ENG-1" }) },
    { "ENG-1": ["ENG-4"] },
  );
  const report = await buildLinearGraph(
    linearMcpReader({ token: "t", client: fake }),
    "ENG-4",
    options,
  );
  expect(report.nodes.map((node) => node.identifier).sort()).toEqual(["ENG-1", "ENG-4"]);
});

test("project captures and open counts use list_issues, filtered to open states", async () => {
  const { fake, calls } = client({
    "ENG-1": mcpIssue(1, { projectId: PROJECT }),
    "ENG-2": mcpIssue(2, { projectId: PROJECT, statusType: "completed", status: "Done" }),
  });
  const report = await buildLinearProject(
    linearMcpReader({ token: "t", client: fake }),
    PROJECT,
    options,
  );
  expect(report.nodes).toHaveLength(2);
  expect(report.openCount).toMatchObject({ value: 1, complete: true });
  expect(report.project).toMatchObject({ id: PROJECT, name: "Project" });
  const listing = calls.find(([tool, args]) => tool === "list_issues" && args.project);
  expect(listing?.[1]).toMatchObject({ project: PROJECT, includeArchived: false, limit: 250 });
});

test("MCP failures surface as Linear read errors and the source is labeled", async () => {
  const { fake } = client({ "ENG-1": mcpIssue(1) });
  const reader = linearMcpReader({ token: "t", client: fake });
  expect(reader.label).toBe("Linear MCP (signed in)");
  await expect(buildLinearGraph(reader, "ENG-9", options)).rejects.toThrow("NOT_FOUND");
});
