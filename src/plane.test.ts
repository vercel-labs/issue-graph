import { describe, expect, test } from "vitest";
import {
  engine,
  fixtureReader,
  id,
  item,
  key,
  ops,
  options,
  pid,
} from "../tests/plane-fixtures.js";
import {
  buildPlaneGraph,
  buildPlaneProject,
  parsePlaneLocator,
  planeNodeKey,
  renderPlane,
} from "./plane.js";
import { planeDashboardModel } from "./plane-html.js";

describe("Plane locators", () => {
  test.each([
    ["ENG-12", { identifier: "ENG-12" }],
    ["eng-12", { identifier: "ENG-12" }],
    [id(3), { id: id(3) }],
    ["https://app.plane.so/Fixture/browse/ENG-12/", { identifier: "ENG-12", workspace: "fixture" }],
    [
      `https://app.plane.so/fixture/projects/${pid(1)}/issues/${id(3)}/`,
      { id: id(3), projectId: pid(1), workspace: "fixture" },
    ],
    [
      `https://app.plane.so/fixture/projects/${pid(1)}/work-items/${id(3)}`,
      { id: id(3), projectId: pid(1), workspace: "fixture" },
    ],
  ])("parses %s", (input, expected) => expect(parsePlaneLocator(input)).toEqual(expected));

  test.each([
    "",
    "ENG-0",
    "12",
    "https://app.plane.so.evil.test/fixture/browse/ENG-1/",
    "http://app.plane.so/fixture/browse/ENG-1/",
    "https://user:pass@app.plane.so/fixture/browse/ENG-1/",
    "https://app.plane.so/fixture/browse/ENG-1/extra",
  ])("rejects %s", (input) => expect(() => parsePlaneLocator(input)).toThrow());

  test("accepts a self-hosted web origin", () => {
    expect(
      parsePlaneLocator(
        "https://plane.example.com/team/browse/OPS-4/",
        "https://plane.example.com",
      ),
    ).toEqual({ identifier: "OPS-4", workspace: "team" });
  });
});

describe("Plane neighborhood", () => {
  const relations = {
    [id(1)]: {
      blocking: [id(2)],
      blocked_by: [id(3)],
      duplicate: [id(4)],
      start_after: [id(5)],
      "implemented by": [id(6)],
      custom_kind: [id(7)],
    },
  };

  test("maps every relation type from the reading side and resolves seeds from the index", async () => {
    const reader = fixtureReader({
      items: [1, 2, 3, 4, 5, 6, 7].map((n) => item(n)),
      relations,
      links: { [id(1)]: [{ id: id(900), title: "", url: "https://github.com/o/r/pull/9" }] },
    });
    const report = await buildPlaneGraph(reader, "ENG-1", { ...options, maxDepth: 0 });
    expect(reader.calls).not.toContain("identifier ENG-1");
    const edges = report.nodes[0].edges.map((edge) => [
      edge.to,
      edge.relation,
      edge.direction,
      edge.nativeRelation,
    ]);
    expect(edges).toEqual(
      expect.arrayContaining([
        [key(2), "blocks", "outgoing", "blocks"],
        [key(3), "blocks", "incoming", "blocks"],
        [key(4), "duplicate_of", "undirected", "duplicate"],
        [key(5), "provider_specific", "incoming", "start_before"],
        [key(6), "provider_specific", "incoming", "implements"],
        [key(7), "provider_specific", "outgoing", "custom_kind"],
      ]),
    );
    expect(report.nodes[0].externalLinks).toEqual([
      {
        url: "https://github.com/o/r/pull/9",
        title: "https://github.com/o/r/pull/9",
        evidence: { kind: "attachment", id: id(900) },
      },
    ]);
    expect(report.nodes[0].description).toBe("Body & detail 1");
    expect(report.references[key(2)]).toMatchObject({ identifier: "ENG-2", title: "Item 2" });
    expect(renderPlane(report)).toContain("→ blocks: ENG-2");
  });

  test("both sides of a relation produce the same evidence", async () => {
    const reader = fixtureReader({
      items: [item(1), item(2)],
      relations: { [id(1)]: { blocking: [id(2)] }, [id(2)]: { blocked_by: [id(1)] } },
    });
    const report = await buildPlaneGraph(reader, "ENG-1", options);
    const [one, two] = [key(1), key(2)].map((k) => report.nodes.find((node) => node.key === k));
    expect(one?.edges[0].evidence).toEqual(two?.edges[0].evidence);
    const model = planeDashboardModel(report);
    expect(model.nodes[key(1)].out).toHaveLength(1);
    expect(model.nodes[key(2)].in).toEqual([
      expect.objectContaining({ from: key(1), via: "blocked by" }),
    ]);
  });

  test("builds hierarchy from the workspace index without per-item child reads", async () => {
    const reader = fixtureReader({
      items: [item(1), item(2, { parent_id: id(1) }), item(3, { parent_id: id(1) })],
    });
    const report = await buildPlaneGraph(reader, "ENG-2", options);
    expect(reader.calls.some((call) => call.startsWith("children"))).toBe(false);
    const parent = report.nodes.find((node) => node.key === key(1));
    expect(parent?.edges.filter((edge) => edge.relation === "parent_of")).toHaveLength(2);
    expect(report.coverageComplete).toBe(true);
  });

  test("normalizes Plane's cancelled state group", async () => {
    const reader = fixtureReader({
      items: [item(1, { state: { id: pid(91), name: "Cancelled", group: "cancelled" } })],
    });
    const report = await buildPlaneGraph(reader, "ENG-1", options);
    expect(report.nodes[0].state).toEqual({ name: "Cancelled", type: "canceled" });
    expect(planeDashboardModel(report).nodes[key(1)].state).toBe("CLOSED");
  });

  test("checks the URL workspace before reading anything", async () => {
    const reader = fixtureReader({ items: [item(1)] });
    await expect(
      buildPlaneGraph(reader, "https://app.plane.so/another/browse/ENG-1/", options),
    ).rejects.toThrow("WORKSPACE_MISMATCH");
    expect(reader.calls).toEqual([]);
  });

  test("falls back to per-item reads when the index is incomplete", async () => {
    const reader = fixtureReader({
      items: [item(1), item(2), item(3, { project: ops }), item(4, { parent_id: id(1) })],
      relations: { [id(1)]: { relates_to: [id(3)] } },
      pageSize: 1,
    });
    const report = await buildPlaneGraph(reader, "ENG-1", { ...options, maxPages: 1 });
    expect(report.index).toMatchObject({ complete: false, reason: "page-limit" });
    // The related item lives in another project: the hinted project is tried first.
    expect(reader.calls).toContain(`item ${engine.id} ${id(3)}`);
    expect(reader.calls).toContain(`item ${ops.id} ${id(3)}`);
    expect(reader.calls).toContain(`children ${id(1)}`);
    expect(report.nodes.find((node) => node.key === key(3))?.identifier).toBe("OPS-3");
    expect(report.nodes.find((node) => node.key === key(4))?.fetched).toBe(true);
  });

  test("marks a node partial when its relations cannot be read", async () => {
    const reader = fixtureReader({ items: [item(1)] });
    reader.relations = async () => {
      throw new Error("boom");
    };
    const report = await buildPlaneGraph(reader, "ENG-1", options);
    expect(report.coverage.partial).toEqual([key(1)]);
    expect(report.coverageComplete).toBe(false);
    expect(renderPlane(report)).toContain("Incomplete relations: read-failed");
  });

  test("keys are scoped to the workspace", () => {
    expect(planeNodeKey("Fixture", id(1))).toBe(key(1));
    expect(planeNodeKey("other", id(1))).not.toBe(key(1));
  });
});

describe("Plane project capture", () => {
  test("captures one project by identifier, skips archived items, and counts open work", async () => {
    const reader = fixtureReader({
      items: [
        item(1),
        item(2, { state: { id: pid(92), name: "Done", group: "completed" } }),
        item(3, { archived_at: "2026-10-01T00:00:00Z" }),
        item(4, { project: ops }),
      ],
      relations: { [id(1)]: { blocking: [id(4)] } },
    });
    const report = await buildPlaneProject(reader, "eng", options);
    expect(report.nodes.map((node) => node.key).sort()).toEqual([key(1), key(2)]);
    expect(report.openCount).toMatchObject({ value: 1, complete: true });
    expect(report.project?.name).toBe("Engine");
    expect(report.coverageComplete).toBe(true);
    const model = planeDashboardModel(report);
    expect(Object.keys(model.nodes)).toHaveLength(2);
    expect(model.id).toBe(`plane:fixture:project:${engine.id}`);
    expect(model.provider.id).toBe("plane");
  });

  test("reports node-capped items", async () => {
    const reader = fixtureReader({ items: [1, 2, 3].map((n) => item(n)) });
    const report = await buildPlaneProject(reader, engine.id, { ...options, maxNodes: 2 });
    expect(report.nodes).toHaveLength(2);
    expect(report.coverage.cappedOut).toEqual([key(3)]);
    expect(report.coverageComplete).toBe(false);
  });

  test("rejects an unknown project", async () => {
    await expect(buildPlaneProject(fixtureReader({ items: [] }), "NOPE", options)).rejects.toThrow(
      "PROJECT_NOT_FOUND",
    );
  });
});
