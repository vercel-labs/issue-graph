import { expect, test, vi } from "vitest";
import {
  fixtureReader,
  id,
  issue,
  key,
  options,
  organization,
  page,
  reference,
  relation,
} from "../tests/linear-fixtures.js";
import { buildLinearProject, renderLinear } from "./linear.js";
import { runLinear } from "./linear-cli.js";
import { linearDashboardModel } from "./linear-html.js";
import { LinearReadError } from "./linear-queries.js";

const project = { id: id(100), name: "Project", url: "https://linear.app/fixture/project/project" };
const projectIssue = (n: number) => ({ ...issue(n), project });

function readerFor(issues = [projectIssue(1)]) {
  return {
    ...fixtureReader(issues),
    projectIssues: vi.fn(async (_id: string, after?: string) => ({
      project: {
        ...project,
        issues: page(
          after ? issues.slice(1) : issues.slice(0, 1),
          after || issues.length < 2 ? null : "next",
        ),
      },
    })),
    projectOpenIssues: vi.fn(async () => ({ project: { id: project.id, issues: page(issues) } })),
  };
}

test("project capture reads disconnected issues, all connections and counts independently of graph limits", async () => {
  const first = projectIssue(1);
  first.children = page([reference(3)]);
  first.relations = page([relation(1, 3, "related")], "relations-next");
  const second = projectIssue(2);
  const reader = readerFor([first, second]);
  const original = reader.issue;
  reader.issue = vi.fn(async (locator, pagination) => {
    const result = (await original(locator, pagination)) as { issue: typeof first };
    if (pagination.cursors.relations) result.issue.relations = page([relation(1, 4, "blocks")]);
    return result;
  });
  const report = await buildLinearProject(reader, project.id, {
    ...options,
    maxDepth: 0,
    hubThreshold: 1,
  });
  expect(report.nodes.map((node) => node.identifier)).toEqual(["ENG-1", "ENG-2"]);
  expect(report.nodes[0].edges.map((edge) => edge.to)).toEqual([key(3), key(3), key(4)]);
  expect(report.nodes[0].coverage.find((part) => part.source === "relations")).toMatchObject({
    pages: 2,
    complete: true,
  });
  expect(reader.issue).toHaveBeenCalledTimes(3);
  expect(reader.projectIssues.mock.calls).toEqual([
    [project.id, undefined],
    [project.id, "next"],
  ]);
  expect(report).toMatchObject({
    coverageComplete: true,
    openCount: { value: 2, complete: true },
    inventory: { pages: 2, complete: true },
    coverage: { hubs: [], depthBoundaries: [] },
  });
  expect(report.components).toEqual([[key(1)], [key(2)]]);
  expect(linearDashboardModel(report).coverage).toMatchObject({ complete: true, warnings: [] });
  expect(renderLinear(report)).toContain("project capture");
});

test("an empty project is a complete empty capture", async () => {
  const report = await buildLinearProject(readerFor([]), project.id, options);
  expect(report).toMatchObject({
    project,
    nodes: [],
    components: [],
    coverageComplete: true,
    openCount: { value: 0, complete: true },
  });
  expect(linearDashboardModel(report).stats.nodes).toBe(0);
});

test.each([
  "node",
  "page",
] as const)("a %s limit remains visible and cannot reduce the independent selector count", async (limit) => {
  const reader = readerFor([projectIssue(1), projectIssue(2)]);
  const report = await buildLinearProject(reader, project.id, {
    ...options,
    ...(limit === "node" ? { maxNodes: 1 } : { maxPages: 1 }),
  });
  expect(report).toMatchObject({
    nodes: [{ identifier: "ENG-1" }],
    inventory: { complete: false, reason: `${limit}-limit` },
    coverageComplete: false,
    openCount: { value: 2, complete: true },
  });
  const model = linearDashboardModel(report);
  expect(model.coverage?.warnings).toContain(`Project issue list incomplete: ${limit}-limit`);
  expect(model.nodes[key(1)].flags).toEqual([]);
});

test("a final page larger than the node cap records known omitted issues", async () => {
  const reader = readerFor([projectIssue(1), projectIssue(2)]);
  reader.projectIssues.mockImplementation(async () => ({
    project: { ...project, issues: page([projectIssue(1), projectIssue(2)]) },
  }));
  const report = await buildLinearProject(reader, project.id, { ...options, maxNodes: 1 });
  expect(report.inventory?.complete).toBe(true);
  expect(report.coverageComplete).toBe(false);
  expect(report.coverage.cappedOut).toEqual([key(2)]);
});

test.each([
  "failure",
  "malformed",
  "cursor",
  "overlap",
] as const)("project pagination preserves partial results for %s", async (mode) => {
  const reader = readerFor([projectIssue(1), projectIssue(2)]);
  reader.projectIssues.mockImplementation(async (_id, after) => {
    if (!after) return { project: { ...project, issues: page([projectIssue(1)], "next") } };
    if (mode === "failure") throw new LinearReadError("TIMEOUT");
    if (mode === "malformed")
      return { project: { ...project, issues: { nodes: [], pageInfo: {} } } } as never;
    return {
      project: { ...project, issues: page([projectIssue(1)], mode === "cursor" ? "next" : null) },
    };
  });
  const report = await buildLinearProject(reader, project.id, options);
  expect(report.nodes.map((node) => node.identifier)).toEqual(["ENG-1"]);
  expect(report.coverageComplete).toBe(false);
  expect(report.inventory?.reason).toBe(
    mode === "failure"
      ? "read-failed"
      : mode === "overlap"
        ? "changed-during-read"
        : "invalid-page",
  );
});

test.each([
  "workspace",
  "project",
] as const)("rejects a foreign %s in the inventory", async (mode) => {
  const reader = readerFor();
  const foreign = projectIssue(2);
  if (mode === "project") foreign.project = { ...project, id: id(200) };
  else foreign.team.organization.id = id(200);
  reader.projectIssues.mockImplementation(async () => ({
    project: { ...project, issues: page([foreign]) },
  }));
  await expect(buildLinearProject(reader, project.id, options)).rejects.toThrow(
    "WORKSPACE_MISMATCH",
  );
});

test.each([
  "unavailable",
  "moved",
  "archived",
  "changed",
  "connections",
] as const)("a %s issue stays visible with an honest warning", async (mode) => {
  const reader = readerFor();
  reader.issue = async () => {
    if (mode === "unavailable") throw new Error("offline");
    const found = projectIssue(1);
    if (mode === "moved") found.project = { ...project, id: id(200) };
    if (mode === "archived") found.archivedAt = "2026-09-27T00:00:00Z";
    if (mode === "changed") found.updatedAt = "2026-09-27T00:00:00Z";
    if (mode === "connections") found.attachments = page([], "next");
    return { issue: found };
  };
  const report = await buildLinearProject(reader, project.id, { ...options, maxPages: 1 });
  expect(report.nodes).toHaveLength(1);
  expect(report.coverageComplete).toBe(false);
  const model = linearDashboardModel(report);
  expect(model.nodes[key(1)].flags.length).toBeGreaterThan(0);
  expect(model.coverage?.complete).toBe(false);
});

test("CLI project mode reaches the collector and saves the populated project", async () => {
  const dashboard = vi.fn(async () => {});
  let stdout = "";
  expect(
    await runLinear(
      ["--project", project.id, "--json", "--html", "project.html"],
      () => readerFor(),
      {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        dashboard,
      },
    ),
  ).toBe(0);
  expect(JSON.parse(stdout)).toMatchObject({
    project,
    nodes: [{ identifier: "ENG-1" }],
    scope: { issues: "project" },
  });
  expect(dashboard).toHaveBeenCalledOnce();
});

test("bounded concurrent detail reads preserve deterministic issue order", async () => {
  const issues = Array.from({ length: 12 }, (_, index) => projectIssue(index + 1));
  const reader = readerFor(issues);
  let active = 0;
  let peak = 0;
  reader.issue = async (locator) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
    return { issue: issues.find((node) => node.id === locator) };
  };
  const report = await buildLinearProject(reader, project.id, { ...options, concurrency: 3 });
  expect(peak).toBe(3);
  expect(report.nodes.map((node) => node.nativeId)).toEqual(issues.map((node) => node.id));
  expect(report.nodes.every((node) => node.authority === organization)).toBe(true);
});
