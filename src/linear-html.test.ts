import { expect, test } from "vitest";
import {
  fixtureReader,
  issue,
  key,
  options,
  page,
  reference,
  relation,
} from "../tests/linear-fixtures.js";
import { dashboardModel, renderDashboard } from "./html.js";
import { buildLinearGraph } from "./linear.js";
import { linearDashboardModel } from "./linear-html.js";

test("keeps blocker direction and deduplicates relationships read from both endpoints", async () => {
  const root = issue(1);
  root.relations = page([relation(1, 2), relation(1, 3, "related")]);
  root.children = page([reference(4)]);
  const blocked = issue(2);
  blocked.inverseRelations = page([relation(1, 2)]);
  const related = issue(3);
  related.inverseRelations = page([relation(1, 3, "related")]);
  const child = issue(4);
  child.parent = reference(1);
  const model = linearDashboardModel(
    await buildLinearGraph(fixtureReader([root, blocked, related, child]), "ENG-1", options),
  );
  expect(model.nodes[key(1)].out.map((edge) => [edge.to, edge.via])).toEqual([
    [key(2), "blocks"],
    [key(3), "related"],
    [key(4), "parent of"],
  ]);
  expect(model.nodes[key(2)].in).toEqual([
    { from: key(1), via: "blocked by", evidence: { kind: "relation", id: "1-2-blocks" } },
  ]);
  expect(model.nodes[key(2)].out).toEqual([]);
  expect(model.nodes[key(3)].out).toEqual([
    {
      to: key(1),
      via: "related",
      undirected: true,
      evidence: { kind: "relation", id: "1-3-related" },
    },
  ]);
  expect(model.nodes[key(3)].in).toEqual([]);
  expect(model.nodes[key(4)].in).toEqual([
    { from: key(1), via: "child of", evidence: { kind: "hierarchy", id: child.id } },
  ]);
});

test.each([
  "incoming",
  "outgoing",
] as const)("keeps a boundary relationship visible when its %s endpoint is outside the capture", async (direction) => {
  const root = issue(1);
  if (direction === "incoming") root.inverseRelations = page([relation(2, 1)]);
  else root.relations = page([relation(1, 2)]);
  const model = linearDashboardModel(
    await buildLinearGraph(fixtureReader([root]), "ENG-1", { ...options, maxDepth: 0 }),
  );
  expect(Object.keys(model.nodes)).toEqual([key(1)]);
  if (direction === "incoming")
    expect(model.nodes[key(1)].in).toEqual([
      { from: key(2), via: "blocked by", evidence: { kind: "relation", id: "2-1-blocks" } },
    ]);
  else expect(model.nodes[key(1)].out[0]).toMatchObject({ to: key(2), via: "blocks" });
  expect(model.coverage?.messages).toContain("1 issues at the depth boundary");
});

test("labels the duplicate and canonical issue without reversing them", async () => {
  const duplicate = issue(1);
  const canonical = issue(2);
  duplicate.relations = page([relation(1, 2, "duplicate")]);
  canonical.inverseRelations = page([relation(1, 2, "duplicate")]);
  const model = linearDashboardModel(
    await buildLinearGraph(fixtureReader([duplicate, canonical]), "ENG-1", options),
  );
  expect(model.nodes[key(1)].out).toEqual([
    {
      to: key(2),
      via: "duplicate of",
      undirected: false,
      evidence: { kind: "relation", id: "1-2-duplicate" },
    },
  ]);
  expect(model.nodes[key(2)].in).toEqual([
    { from: key(1), via: "has duplicate", evidence: { kind: "relation", id: "1-2-duplicate" } },
  ]);
});

test("retains native status, archive, attachment provenance and partial read evidence", async () => {
  const root = issue(1);
  root.state = { name: "Needs design review", type: "started" };
  root.children = page([reference(2), reference(3)]);
  root.attachments = page(
    [
      {
        id: "attachment",
        title: "Implementation",
        url: "https://github.com/o/r/pull/20",
        archivedAt: null,
      },
    ],
    "more",
  );
  const archived = issue(2);
  archived.archivedAt = "2026-09-25T00:00:00Z";
  const model = linearDashboardModel(
    await buildLinearGraph(fixtureReader([root, archived]), "ENG-1", { ...options, maxPages: 1 }),
  );
  expect(model.id).toBe("linear:11111111-1111-4111-8111-111111111111:unscoped");
  expect(model.provider.views).toEqual(["explore", "swarm"]);
  expect(model.provider.metrics).toEqual(["links", "depth"]);
  expect(model.nodes[key(1)]).toMatchObject({
    identifier: "ENG-1",
    stateLabel: "Needs design review",
    stateType: "started",
  });
  expect(model.nodes[key(1)].attachments?.[0]).toMatchObject({
    title: "Implementation",
    evidence: { kind: "attachment", id: "attachment" },
  });
  expect(
    model.nodes[key(1)].read?.coverage.find((part) => part.source === "attachments"),
  ).toMatchObject({ complete: false, reason: "page-limit" });
  expect(model.nodes[key(2)].archived).toBe(true);
  expect(model.nodes[key(3)]).toMatchObject({
    state: "UNKNOWN",
    url: "",
    read: { fetched: false },
  });
  expect(model.stats).toEqual({ nodes: 3, openIssues: 1, archived: 1 });
  expect(model.coverage).toMatchObject({
    complete: false,
    maxDepth: 1,
    generatedAt: options.generatedAt,
  });
});

test("renders mixed providers without altering their saved models or hiding Linear coverage", async () => {
  const linear = linearDashboardModel(await buildLinearGraph(fixtureReader(), "ENG-1", options));
  const github = dashboardModel(new Map(), [], "fixture");
  const models = [linear, github];
  const before = structuredClone(models);
  const html = renderDashboard(models);
  const embedded = JSON.parse(
    html.split('<script id="data" type="application/json">')[1].split("</script>")[0],
  );
  expect(embedded.projects).toEqual(JSON.parse(JSON.stringify(before)));
  expect(models).toEqual(before);
  expect(linear.id).not.toBe(github.id ?? github.repo);
  expect(html).toContain("function setProject(repo)");
});

test("successful empty connections and scope exclusions do not produce warnings", async () => {
  const report = await buildLinearGraph(fixtureReader(), "ENG-1", options);
  report.scope.notes = ["An optional source was not requested."];
  const model = linearDashboardModel(report);
  expect(model.coverage).toMatchObject({ complete: true, warnings: [] });
  expect(model.nodes[key(1)].flags).toEqual([]);
  expect(model.coverage?.messages).toContain("An optional source was not requested.");
});

test("filtering a fetched neighboring project preserves the boundary without degrading a successful read", async () => {
  const project = {
    id: "00000000-0000-4000-8000-000000000100",
    name: "Project",
    url: "https://linear.app/fixture/project/project",
  };
  const root = { ...issue(1), project };
  root.relations = page([relation(1, 2)]);
  const neighbor = {
    ...issue(2),
    project: { ...project, id: "00000000-0000-4000-8000-000000000200" },
  };
  const model = linearDashboardModel(
    await buildLinearGraph(fixtureReader([root, neighbor]), "ENG-1", options),
  );
  expect(Object.keys(model.nodes)).toEqual([key(1)]);
  expect(model.nodes[key(1)].out[0].to).toBe(key(2));
  expect(model.coverage).toMatchObject({ complete: true, warnings: [] });
  expect(model.coverage?.messages).toContain(
    "1 issues outside this project are omitted from this view.",
  );
});
