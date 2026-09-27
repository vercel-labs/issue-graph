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
} from "../tests/linear-fixtures.js";
import { buildLinearGraph, countLinearProjectOpen } from "./linear.js";
import { linearDashboardModel } from "./linear-html.js";

const project = { id: id(900), name: "Project A", url: "https://linear.app/fixture/project/a" };
const team = { id: id(901), name: "Engineering", key: "ENG", organization: { id: organization } };
const countNode = (n: number, type = "started") => ({
  id: id(n),
  archivedAt: null,
  state: { type },
  project: { id: project.id },
  team,
});
const countPage = (nodes: unknown[], cursor: string | null = null) => ({
  project: { id: project.id, issues: page(nodes, cursor) },
});
const countedReader = (...pages: unknown[]) => ({
  ...fixtureReader(),
  projectOpenIssues: vi.fn(async () => {
    const value = pages.shift();
    if (value instanceof Error) throw value;
    return value;
  }),
});

test("counts the whole project across pages, even with a one-node graph cap", async () => {
  const root = { ...issue(1), project, team, children: page([reference(2)]) };
  const reader = {
    ...fixtureReader([root]),
    projectOpenIssues: vi
      .fn()
      .mockResolvedValueOnce(
        countPage(
          Array.from({ length: 250 }, (_, i) => countNode(i + 1)),
          "next",
        ),
      )
      .mockResolvedValueOnce(countPage([countNode(251), countNode(252)])),
  };
  const report = await buildLinearGraph(reader, "ENG-1", { ...options, maxNodes: 1 });
  expect(report.nodes).toHaveLength(1);
  expect(report.openCount).toMatchObject({ value: 252, issues: 252, complete: true });
  expect(reader.projectOpenIssues.mock.calls).toEqual([
    [project.id, undefined],
    [project.id, "next"],
  ]);
  expect(linearDashboardModel(report).openCount).toEqual(report.openCount);
});

test("distinguishes an empty project from an unavailable count", async () => {
  expect(
    await countLinearProjectOpen(countedReader(countPage([])), project.id, organization),
  ).toMatchObject({ value: 0, complete: true });
  expect(
    await countLinearProjectOpen(countedReader(new Error("unavailable")), project.id, organization),
  ).toBeUndefined();
  expect(await countLinearProjectOpen(fixtureReader(), project.id, organization)).toBeUndefined();
});

test.each([
  "triage",
  "backlog",
  "unstarted",
  "started",
])("counts native open state %s", async (type) => {
  expect(
    await countLinearProjectOpen(
      countedReader(countPage([countNode(1, type)])),
      project.id,
      organization,
    ),
  ).toMatchObject({ value: 1, complete: true });
});

test.each([
  { state: { type: "completed" } },
  { state: { type: "canceled" } },
  { state: { type: "duplicate" } },
  { state: { type: "unknown" } },
  { archivedAt: "2026-09-01T00:00:00Z" },
  { project: { id: id(902) } },
  { team: { organization: { id: id(903) } } },
  { id: "invalid" },
])("does not claim an exact total for an out-of-scope or invalid record: %j", async (change) => {
  const reader = countedReader(countPage([{ ...countNode(1), ...change }]));
  expect(await countLinearProjectOpen(reader, project.id, organization)).toBeUndefined();
});

test.each(["cap", "failure", "cursor", "overlap"])("reports a lower bound on %s", async (mode) => {
  const reader = countedReader(
    countPage([countNode(1)], "next"),
    mode === "failure"
      ? new Error("read failed")
      : countPage([countNode(mode === "overlap" ? 1 : 2)], mode === "cursor" ? "next" : null),
  );
  const count = await countLinearProjectOpen(
    reader,
    project.id,
    organization,
    mode === "cap" ? 1 : 3,
  );
  expect(count).toMatchObject({ complete: false, value: mode === "cursor" ? 2 : 1 });
  expect(reader.projectOpenIssues.mock.calls.length).toBeLessThanOrEqual(2);
});

test("separates same-named projects, filters captured issues, and keeps boundary links", async () => {
  const otherProject = { ...project, id: id(902) };
  const root = { ...issue(1), project, team, children: page([reference(2)]) };
  const other = { ...issue(2), project: otherProject, team, parent: reference(1) };
  const report = await buildLinearGraph(fixtureReader([root, other]), "ENG-1", options);
  const model = linearDashboardModel(report);
  expect(model.id).toBe(`linear:${organization}:project:${project.id}`);
  expect(model.label).toBe("Fixture / Project A");
  expect(model.url).toBe(project.url);
  expect(Object.keys(model.nodes)).toEqual([key(1)]);
  expect(model.groups.flatMap((group) => group.members)).toEqual([key(1)]);
  expect(model.seeds).toEqual([key(1)]);
  expect(model.nodes[key(1)].out).toHaveLength(1);
  expect(model.nodes[key(1)].out[0]).toMatchObject({ to: key(2), via: "parent of" });
  expect(model.coverage?.complete).toBe(true);
  const second = linearDashboardModel({ ...report, project: otherProject, seeds: [key(2)] });
  expect(second.id).not.toBe(model.id);
  expect(Object.keys(second.nodes)).toEqual([key(2)]);
});

test("scopes unassigned issues by team and treats duplicates as closed", async () => {
  const root = { ...issue(1), project: null, team, children: page([reference(2)]) };
  root.state = { name: "Duplicate", type: "duplicate" };
  const other = { ...issue(2), project: null, team: { ...team, id: id(902) } };
  const model = linearDashboardModel(
    await buildLinearGraph(fixtureReader([root, other]), "ENG-1", options),
  );
  expect(model.id).toBe(`linear:${organization}:team:${team.id}:no-project`);
  expect(model.label).toBe("Fixture / Engineering / No project");
  expect(Object.keys(model.nodes)).toEqual([key(1)]);
  expect(model.nodes[key(1)].state).toBe("CLOSED");
  expect(model.openCount).toBeUndefined();
});
