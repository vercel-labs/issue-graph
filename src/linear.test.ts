import { describe, expect, test } from "vitest";
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
import { buildLinearGraph, linearNodeKey, parseLinearLocator, renderLinear } from "./linear.js";
import { LINEAR_CONNECTIONS } from "./linear-queries.js";

describe("Linear identity", () => {
  test.each([
    "ENG-1",
    "eng-1",
    "https://linear.app/fixture/issue/ENG-1/example",
    id(1),
  ])("resolves %s into an authority-scoped native identity", async (seed) => {
    const report = await buildLinearGraph(fixtureReader(), seed, options);
    expect(report.seeds).toEqual([key(1)]);
    expect(report.nodes[0].state).toEqual({ name: "In review", type: "started" });
    expect(report.coverageComplete).toBe(true);
  });
  test.each([
    "",
    "--help",
    "https://example.com/fixture/issue/ENG-1",
    "ENG-0",
  ])("rejects invalid locator %s", (seed) => expect(() => parseLinearLocator(seed)).toThrow());
  test("requires the URL workspace before any issue read", async () => {
    const reader = fixtureReader();
    let reads = 0;
    reader.issue = async () => {
      reads++;
      return { issue: issue(1) };
    };
    await expect(
      buildLinearGraph(reader, "https://linear.app/another/issue/ENG-1/x", options),
    ).rejects.toThrow("WORKSPACE_MISMATCH");
    expect(reads).toBe(0);
    expect(linearNodeKey(organization, id(1))).not.toBe(linearNodeKey(id(99), id(1)));
  });
  test("rejects a mismatched native ID or organization returned by the producer", async () => {
    const reader = fixtureReader();
    reader.issue = async () => ({ issue: issue(2) });
    await expect(buildLinearGraph(reader, id(1), options)).rejects.toThrow("IDENTITY_MISMATCH");
    const wrong = issue(1);
    wrong.team.organization.id = id(99);
    reader.issue = async () => ({ issue: wrong });
    await expect(buildLinearGraph(reader, "ENG-1", options)).rejects.toThrow("WORKSPACE_MISMATCH");
  });
  test("rejects generated lookalike hosts, schemes and credential-bearing locators", () => {
    for (const prefix of ["http://", "ftp://", "file://", "https://user@", "https://user:pass@"])
      expect(() => parseLinearLocator(`${prefix}linear.app/fixture/issue/ENG-1/x`)).toThrow();
    for (let index = 0; index < 100; index++) {
      expect(() =>
        parseLinearLocator(`https://linear.app.${index}.example/fixture/issue/ENG-1/x`),
      ).toThrow();
      expect(() =>
        parseLinearLocator(`https://${index}.linear.app/fixture/issue/ENG-1/x`),
      ).toThrow();
    }
  });
});

describe("Linear relations", () => {
  test.each([
    ["blocks", "blocks", false],
    ["duplicate", "duplicate_of", false],
    ["related", "related", true],
    ["similar", "provider_specific", true],
    ["custom", "provider_specific", false],
  ] as const)("preserves %s semantics in both connection directions", async (native, normalized, symmetric) => {
    for (const outgoing of [true, false]) {
      const root = issue(1);
      root[outgoing ? "relations" : "inverseRelations"] = page([
        outgoing ? relation(1, 2, native) : relation(2, 1, native),
      ]);
      const report = await buildLinearGraph(fixtureReader([root]), "ENG-1", {
        ...options,
        maxDepth: 0,
      });
      expect(report.nodes[0].edges).toEqual([
        {
          to: key(2),
          relation: normalized,
          direction: symmetric ? "undirected" : outgoing ? "outgoing" : "incoming",
          nativeRelation: native,
          evidence: { kind: "relation", id: outgoing ? `1-2-${native}` : `2-1-${native}` },
        },
      ]);
    }
  });
  test("retains direction, hierarchy, unknown native types and attachment provenance", async () => {
    const root = issue(1);
    root.relations = page([relation(1, 2), relation(1, 3, "duplicate"), relation(1, 4, "custom")]);
    root.inverseRelations = page([relation(5, 1), relation(6, 1, "related")]);
    root.parent = reference(7);
    root.children = page([reference(8)]);
    root.attachments = page([
      {
        id: "attachment-1",
        title: "Implementation",
        url: "https://github.com/org/repo/pull/20",
        archivedAt: null,
      },
    ]);
    const report = await buildLinearGraph(fixtureReader([root]), "ENG-1", {
      ...options,
      maxDepth: 0,
    });
    const node = report.nodes[0];
    expect(node.edges.map((e) => [e.to, e.relation, e.direction])).toEqual([
      [key(2), "blocks", "outgoing"],
      [key(3), "duplicate_of", "outgoing"],
      [key(4), "provider_specific", "outgoing"],
      [key(5), "blocks", "incoming"],
      [key(6), "related", "undirected"],
      [key(7), "parent_of", "incoming"],
      [key(8), "parent_of", "outgoing"],
    ]);
    expect(node.edges[2].nativeRelation).toBe("custom");
    expect(node.externalLinks).toEqual([
      {
        title: "Implementation",
        url: "https://github.com/org/repo/pull/20",
        evidence: { kind: "attachment", id: "attachment-1" },
      },
    ]);
    expect(report.coverage.depthBoundaries).toEqual([key(1)]);
    expect(report.scope.textReferences).toBe("not-collected");
    expect(report.coverageComplete).toBe(true);
  });
  test("refuses a relation belonging to a different issue", async () => {
    const root = issue(1);
    root.relations = page([relation(2, 3)]);
    await expect(buildLinearGraph(fixtureReader([root]), "ENG-1", options)).rejects.toThrow(
      "UNRELATED_RELATION",
    );
  });
  test("includes archived issues but excludes archived relations and attachments", async () => {
    const root = issue(1);
    const archivedAt = "2026-09-20T00:00:00Z";
    root.archivedAt = archivedAt;
    root.relations = page([relation(1, 2), { ...relation(1, 3), archivedAt }]);
    root.inverseRelations = page([relation(4, 1), { ...relation(5, 1), archivedAt }]);
    root.attachments = page([
      { id: "active", title: "", url: "https://example.com/current", archivedAt: null },
      { id: "archived", title: "Historical", url: "https://example.com/history", archivedAt },
    ]);
    const report = await buildLinearGraph(fixtureReader([root]), "ENG-1", {
      ...options,
      maxDepth: 0,
    });
    expect(report.nodes[0].archived).toBe(true);
    expect(report.nodes[0].edges.map((edge) => edge.to)).toEqual([key(2), key(4)]);
    expect(report.nodes[0].externalLinks.map((link) => [link.title, link.evidence.id])).toEqual([
      ["", "active"],
    ]);
    expect(report.coverageComplete).toBe(true);
    expect(report.scope.archived).toBe("issues-included-links-excluded");
  });
  test.each([
    undefined,
    false,
    "",
    "invalid",
  ])("rejects malformed archive state %s", async (archivedAt) => {
    const root = { ...issue(1), archivedAt };
    const reader = fixtureReader();
    reader.issue = async () => ({ issue: root });
    await expect(buildLinearGraph(reader, "ENG-1", options)).rejects.toThrow("INVALID_PAYLOAD");
  });
});

describe("Linear pagination", () => {
  test("paginates connections independently", async () => {
    const initial = issue(1);
    initial.relations = page([relation(1, 2)], "r-next");
    initial.attachments = page([], "a-next");
    const reader = fixtureReader();
    const calls: unknown[] = [];
    reader.issue = async (locator, request) => {
      calls.push(structuredClone({ locator, request }));
      if (!request.cursors.relations) return { issue: initial };
      const second = issue(1);
      second.relations = page([relation(1, 3)]);
      second.attachments = page([
        {
          id: "attachment",
          title: "Other site",
          url: "https://linear.app/another/issue/ENG-1/x",
          archivedAt: null,
        },
      ]);
      return { issue: second };
    };
    const report = await buildLinearGraph(reader, "ENG-1", { ...options, maxDepth: 0 });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({
      request: {
        include: ["relations", "attachments"],
        cursors: { relations: "r-next", attachments: "a-next" },
      },
    });
    expect(report.nodes[0].edges.map((e) => e.to)).toEqual([key(2), key(3)]);
    expect(report.nodes[0].externalLinks[0].url).toContain("/another/");
    expect(report.nodes[0].coverage.map((c) => c.pages)).toEqual([2, 1, 1, 2]);
    expect(report.coverageComplete).toBe(true);
  });
  test.each(LINEAR_CONNECTIONS)("reports a %s page cap instead of complete", async (name) => {
    const root = issue(1);
    root[name] = page([], "next");
    const report = await buildLinearGraph(fixtureReader([root]), "ENG-1", {
      ...options,
      maxPages: 1,
    });
    expect(report.coverageComplete).toBe(false);
    expect(report.nodes[0].coverage.find((c) => c.source === name)).toMatchObject({
      reason: "page-limit",
      pages: 1,
      complete: false,
    });
  });
  test.each([
    "repeated",
    "missing",
    "malformed",
    "failure",
    "changed",
  ])("preserves partial coverage for a %s continuation", async (mode) => {
    const initial = issue(1);
    initial.relations = page([relation(1, 2)], "next");
    const reader = fixtureReader();
    let requests = 0;
    reader.issue = async () => {
      requests++;
      if (requests === 1) return { issue: initial };
      if (mode === "failure") throw new Error("Fixture read failed");
      const second = issue(1);
      second.relations = page([], mode === "repeated" ? "next" : null);
      if (mode === "missing") second.relations.pageInfo = { hasNextPage: true, endCursor: null };
      if (mode === "malformed") second.relations = {} as ReturnType<typeof page>;
      if (mode === "changed") second.updatedAt = "2026-09-26T00:00:00.000Z";
      return { issue: second };
    };
    const report = await buildLinearGraph(reader, "ENG-1", { ...options, maxDepth: 0 });
    expect(requests).toBe(2);
    expect(report.coverageComplete).toBe(false);
    expect(report.nodes[0].edges.map((e) => e.to)).toEqual([key(2)]);
    expect(report.nodes[0].coverage[0].reason).toBe(
      mode === "failure"
        ? "read-failed"
        : mode === "changed"
          ? "changed-during-read"
          : "invalid-page",
    );
  });
});

describe("Linear traversal", () => {
  function graph(): ReturnType<typeof issue>[] {
    return Array.from({ length: 4 }, (_, i) => issue(i + 1)).map((node, i) => {
      node.children = page((i === 0 ? [3, 2] : i === 1 || i === 2 ? [4] : [1]).map(reference));
      return node;
    });
  }
  test("deduplicates diamonds and cycles, marks inaccessible neighbors", async () => {
    const report = await buildLinearGraph(fixtureReader(graph()), "ENG-1", {
      ...options,
      maxDepth: 4,
    });
    expect(report.nodes.map((node) => [node.identifier, node.depth])).toEqual([
      ["ENG-1", 0],
      ["ENG-2", 1],
      ["ENG-3", 1],
      ["ENG-4", 2],
    ]);
    expect(report.components).toEqual([[key(1), key(2), key(3), key(4)]]);
    const failed = await buildLinearGraph(fixtureReader([graph()[0]]), "ENG-1", options);
    expect(failed.coverage.failed).toEqual([key(2), key(3)]);
    expect(failed.coverageComplete).toBe(false);
  });
  test("has stable cap admission regardless of response completion order", async () => {
    const results: string[] = [];
    for (const fast of [2, 3]) {
      const reader = fixtureReader(graph());
      const read = reader.issue;
      reader.issue = async (locator, request) => {
        await new Promise((resolve) => setTimeout(resolve, locator === id(fast) ? 0 : 2));
        return read(locator, request);
      };
      const report = await buildLinearGraph(reader, "ENG-1", {
        ...options,
        maxNodes: 3,
        maxDepth: 4,
      });
      expect(report.coverage.cappedOut).toEqual([key(4)]);
      expect(report.coverageComplete).toBe(false);
      results.push(JSON.stringify(report));
    }
    expect(results[0]).toBe(results[1]);
  });
  test("reports hubs and escapes terminal control characters in Markdown", async () => {
    const nodes = graph();
    nodes[1].children = page([reference(4), reference(5)]);
    nodes[0].title = "Heading\n\u001b[31mred";
    const report = await buildLinearGraph(fixtureReader(nodes), "ENG-1", {
      ...options,
      maxDepth: 3,
      hubThreshold: 1,
    });
    expect(report.coverage.hubs).toEqual([key(2)]);
    expect(report.coverageComplete).toBe(false);
    expect(renderLinear(report)).not.toContain("\u001b");
  });
  test("matches an independent breadth-first oracle across deterministic generated graphs", async () => {
    for (let seed = 1; seed <= 20; seed++) {
      const count = 7;
      const adjacent = Array.from({ length: count }, (_, i) =>
        Array.from({ length: count }, (_, j) => j + 1).filter(
          (j) => j !== i + 1 && ((i + 1) * 17 + j * seed) % 5 === 0,
        ),
      );
      const nodes = adjacent.map((targets, i) => {
        const value = issue(i + 1);
        value.children = page(targets.map(reference));
        return value;
      });
      const distances = new Map([[1, 0]]);
      const queue = [1];
      for (const number of queue) {
        const depth = distances.get(number) ?? 0;
        if (depth === 3) continue;
        for (const target of adjacent[number - 1]) {
          if (!distances.has(target)) {
            distances.set(target, depth + 1);
            queue.push(target);
          }
        }
      }
      const report = await buildLinearGraph(fixtureReader(nodes), "ENG-1", {
        ...options,
        maxDepth: 3,
      });
      expect(
        new Map(report.nodes.map((node) => [Number(node.identifier.slice(4)), node.depth])),
      ).toEqual(distances);
    }
  });
});
