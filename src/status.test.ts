import { describe, expect, test } from "bun:test";
import {
  buildStatusReport,
  collectStatus,
  normalizeStatusScope,
  STATUS_METRICS,
  type StatusCoverage,
  type StatusPullRequest,
} from "./status.js";
import type { GhTransport } from "./transport.js";

const time = "2026-09-09T13:00:00.000Z";
const options = {
  repos: ["o/r", "o/empty"],
  authors: ["ctate", "Railly"],
  startedAt: time,
  generatedAt: time,
};
const complete = (repo = "o/r"): StatusCoverage => ({
  repo,
  complete: true,
  pages: 1,
  scanned: 0,
  errors: [],
});
const pr = (number: number, changes: Partial<StatusPullRequest> = {}): StatusPullRequest => ({
  id: `o/r#${number}`,
  repo: "o/r",
  number,
  title: `PR ${number}`,
  url: `https://github.com/o/r/pull/${number}`,
  author: "ctate",
  headSha: "a".repeat(40),
  updatedAt: time,
  isDraft: false,
  reviewState: "required",
  mergeability: "MERGEABLE",
  assignees: [],
  requestedReviewers: [],
  ...changes,
});
const people = (nodes: unknown[] = [], more = false, cursor: string | null = null) => ({
  nodes,
  pageInfo: { hasNextPage: more, endCursor: cursor },
});
const rawPr = (number: number, extra: Record<string, unknown> = {}) => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/o/r/pull/${number}`,
  author: { login: "ctate" },
  headRefOid: "a".repeat(40),
  updatedAt: time,
  isDraft: false,
  reviewDecision: "REVIEW_REQUIRED",
  mergeable: "MERGEABLE",
  assignees: people(),
  reviewRequests: people(),
  ...extra,
});
const page = (
  nodes: unknown[],
  totalCount = nodes.length,
  more = false,
  cursor: string | null = null,
) => ({
  data: {
    repository: {
      pullRequests: { nodes, totalCount, pageInfo: { hasNextPage: more, endCursor: cursor } },
    },
  },
});
function transport(graphql: GhTransport["graphql"]): GhTransport {
  return {
    graphql,
    search: async () => {
      throw new Error("status must not use GitHub search");
    },
  };
}

describe("status aggregation", () => {
  test("case-insensitive scope deduplication is stable and validates command-safe identities", () => {
    expect(normalizeStatusScope(["o/r", "O/R", "o/r"], ["railly", "Railly", "ctate"])).toEqual({
      repos: ["O/R"],
      authors: ["ctate", "Railly"],
    });
    for (const repo of ["", "o/r/x", "o/evil;touch", "--repo"])
      expect(() => normalizeStatusScope([repo], ["ctate"])).toThrow();
    for (const author of ["", "@ctate", "x y", "x;cmd"])
      expect(() => normalizeStatusScope(["o/r"], [author])).toThrow();
  });

  test("counts review buckets independently from draft, conflict, and assignee flags", () => {
    const input = [
      pr(1),
      pr(2, { reviewState: "approved", isDraft: true, mergeability: "CONFLICTING" }),
      pr(3, { author: "railly", reviewState: "changes-requested", assignees: ["ctate"] }),
      pr(4, { reviewState: "not-required" }),
      pr(5, { reviewState: "unknown" }),
    ];
    const report = buildStatusReport(input, [complete(), complete("o/empty")], options);
    expect(report.rows).toHaveLength(4);
    expect(report.projects[0].counts.open.count).toBe(0);
    expect(report.totals.open.count).toBe(5);
    for (const key of [
      "reviewRequired",
      "approved",
      "changesRequested",
      "notRequired",
      "reviewUnknown",
    ] as const)
      expect(report.totals[key].count).toBe(1);
    expect(report.totals.drafts.prIds).toEqual(["o/r#2"]);
    expect(report.totals.conflicts.prIds).toEqual(["o/r#2"]);
    expect(report.totals.unassigned.count).toBe(4);
    expect(report.projects[1].authors.map((item) => item.count.count)).toEqual([4, 1]);
  });

  test("unknown metadata never becomes zero or no assignee", () => {
    const report = buildStatusReport(
      [pr(1, { mergeability: "UNKNOWN", isDraft: null, assignees: null })],
      [complete()],
      { ...options, repos: ["o/r"] },
    );
    for (const field of ["conflicts", "drafts", "unassigned"] as const) {
      expect(report.totals[field].count).toBeNull();
      expect(report.totals[field].unknownIds).toEqual(["o/r#1"]);
    }
    expect(report.totals.mergeUnknown.count).toBe(1);
    expect(report.totals.open.count).toBe(1);
  });

  test("failed repositories invalidate their totals, not complete siblings", () => {
    const report = buildStatusReport([pr(1)], [complete()], options);
    expect(report.coverageComplete).toBe(false);
    expect(report.projects[0].counts.open.count).toBeNull();
    expect(report.projects[1].counts.open.count).toBe(1);
    for (const field of STATUS_METRICS) expect(report.totals[field].count).toBeNull();
    expect(report.totals.open.prIds).toEqual(["o/r#1"]);
    expect(report.coverage[0].errors[0].code).toBe("MISSING_REPOSITORY");
  });

  test("same capture produces identical report regardless of input order, with duplicate PRs counted once", () => {
    const input = [pr(2), pr(1), pr(1), pr(4, { author: "outsider" }), pr(9, { repo: "other/r" })];
    const coverage = [complete(), complete("o/empty")];
    const a = buildStatusReport(input, coverage, options);
    const b = buildStatusReport([...input].reverse(), [...coverage].reverse(), {
      ...options,
      repos: [...options.repos].reverse(),
      authors: [...options.authors].reverse(),
    });
    expect(a).toEqual(b);
    expect(a.totals.open.prIds).toEqual(["o/r#1", "o/r#2"]);
    expect(a.pullRequests.map((item) => item.headSha)).toEqual(["a".repeat(40), "a".repeat(40)]);
  });

  test("property and people ordering do not create false drift", () => {
    const first = pr(1, { assignees: ["z", "a"], requestedReviewers: ["z", "a"] });
    const reordered = Object.fromEntries(
      Object.entries({ ...first, assignees: ["a", "z"], requestedReviewers: ["a", "z"] }).reverse(),
    ) as unknown as StatusPullRequest;
    const report = buildStatusReport([first, reordered], [complete()], {
      ...options,
      repos: ["o/r"],
    });
    expect(report.coverageComplete).toBe(true);
    expect(report.totals.open.count).toBe(1);
    expect(report).toEqual(
      buildStatusReport([reordered, first], [complete()], { ...options, repos: ["o/r"] }),
    );
  });

  test("conflicting observations of one PR invalidate the capture instead of choosing a truth silently", () => {
    const report = buildStatusReport([pr(1), pr(1, { headSha: "b".repeat(40) })], [complete()], {
      ...options,
      repos: ["o/r"],
    });
    expect(report.coverageComplete).toBe(false);
    expect(report.coverage[0].errors[0].code).toBe("INVENTORY_CHANGED");
    expect(report.totals.open.count).toBeNull();
  });
});

describe("status inventory", () => {
  test("retains canonical GitHub URLs rather than reconstructing renamed repositories", async () => {
    const url = "https://github.example.com/o/renamed/pull/1";
    const report = await collectStatus(
      transport(async () => page([rawPr(1, { url })])),
      { repos: ["o/old-name"], authors: ["ctate"] },
    );
    expect(report.pullRequests[0].url).toBe(url);
    expect(report.coverageComplete).toBe(true);
    for (const bad of [
      undefined,
      "javascript:alert(1)",
      "https://user:password@github.com/o/r/pull/1",
      "https://github.com/o/r/pull/2",
    ]) {
      const invalid = await collectStatus(
        transport(async () => page([rawPr(1, { url: bad })])),
        { repos: ["o/r"], authors: ["ctate"] },
      );
      expect(invalid.coverageComplete).toBe(false);
    }
  });

  test("paginates repository connections beyond the search ceiling and retains selected authors only", async () => {
    let calls = 0;
    const t = transport(async (_query, vars) => {
      calls++;
      const offset = vars?.after ? Number(vars.after) : 0;
      const end = Math.min(1001, offset + 50);
      const nodes = Array.from({ length: end - offset }, (_, i) =>
        rawPr(offset + i + 1, { author: { login: offset + i === 1000 ? "RAILLY" : "outsider" } }),
      );
      return page(nodes, 1001, end < 1001, end < 1001 ? String(end) : null);
    });
    const report = await collectStatus(t, { repos: ["o/r"], authors: ["Railly"] });
    expect(calls).toBe(21);
    expect(report.coverage[0].scanned).toBe(1001);
    expect(report.coverageComplete).toBe(true);
    expect(report.totals.open.prIds).toEqual(["o/r#1001"]);
  });

  test("paginates assignees and requested teams as well as PR inventory", async () => {
    const queries: string[] = [];
    const t = transport(async (query, variables) => {
      queries.push(query);
      if (variables?.n) {
        const field = query.includes("reviewRequests") ? "reviewRequests" : "assignees";
        return {
          data: {
            repository: {
              pullRequest: {
                [field]:
                  field === "assignees"
                    ? people([{ login: "railly" }])
                    : people([
                        { requestedReviewer: { slug: "labs", organization: { login: "vercel" } } },
                      ]),
              },
            },
          },
        };
      }
      return page([
        rawPr(1, {
          assignees: people([{ login: "ctate" }], true, "a"),
          reviewRequests: people([{ requestedReviewer: { login: "Railly" } }], true, "b"),
        }),
      ]);
    });
    const report = await collectStatus(t, { repos: ["o/r"], authors: ["ctate"] });
    expect(queries).toHaveLength(3);
    expect(report.pullRequests[0].assignees).toEqual(["ctate", "railly"]);
    expect(report.pullRequests[0].requestedReviewers).toEqual(["Railly", "vercel/labs"]);
    expect(report.totals.unassigned.count).toBe(0);
  });

  test("preserves null review decision separately from absent or unexpected metadata", async () => {
    const report = await collectStatus(
      transport(async () =>
        page([
          rawPr(1, { reviewDecision: null }),
          rawPr(2, { reviewDecision: undefined }),
          rawPr(3, { reviewDecision: "FUTURE_STATE" }),
          rawPr(4, { mergeable: "UNKNOWN" }),
          rawPr(5, { author: null }),
        ]),
      ),
      { repos: ["o/r"], authors: ["ctate"] },
    );
    expect(report.totals.open.count).toBe(4);
    expect(report.totals.notRequired.count).toBe(1);
    expect(report.totals.reviewUnknown.count).toBe(2);
    expect(report.totals.conflicts.count).toBeNull();
    expect(report.coverageComplete).toBe(true);
  });

  test("does not silently count unavailable metadata as an empty assignment", async () => {
    const report = await collectStatus(
      transport(async () => page([rawPr(1, { assignees: null })])),
      { repos: ["o/r"], authors: ["ctate"] },
    );
    expect(report.pullRequests[0].assignees).toBeNull();
    expect(report.coverageComplete).toBe(false);
    expect(report.coverage[0].errors[0].code).toBe("INCOMPLETE_METADATA");
  });

  test("a failed later page retains evidence but no misleading complete counts", async () => {
    const report = await collectStatus(
      transport(async (_q, vars) => {
        if (vars?.after) throw new Error("network unavailable");
        return page([rawPr(1)], 2, true, "next");
      }),
      { repos: ["o/r"], authors: ["ctate"] },
    );
    expect(report.totals.open).toEqual({ count: null, prIds: ["o/r#1"], unknownIds: [] });
    expect(report.coverage[0].errors[0].code).toBe("FETCH_FAILED");
  });

  test("GraphQL errors and inaccessible repos cannot look like an empty queue", async () => {
    for (const value of [
      { data: { repository: null } },
      { errors: [{ message: "forbidden" }], ...page([]) },
      { data: {} },
    ]) {
      const report = await collectStatus(
        transport(async () => value),
        { repos: ["o/r"], authors: ["ctate"] },
      );
      expect(report.totals.open.count).toBeNull();
      expect(report.coverageComplete).toBe(false);
    }
  });

  test("stalled and missing cursors, invalid metadata, count drift, and page caps are incomplete", async () => {
    const cases = [
      transport(async () => page([rawPr(1)], 2, true, "same")),
      transport(async () => page([rawPr(1)], 2, true, null)),
      transport(async () => page([rawPr(1, { author: undefined })])),
      transport(async () => page([rawPr(1, { number: undefined })])),
      transport(async () => page([rawPr(1)], 2)),
      transport(async (_q, vars) =>
        page(
          [rawPr(vars?.after ? 2 : 1)],
          vars?.after ? 3 : 2,
          !vars?.after,
          vars?.after ? null : "next",
        ),
      ),
    ];
    for (const t of cases)
      expect(
        (await collectStatus(t, { repos: ["o/r"], authors: ["ctate"] })).coverageComplete,
      ).toBe(false);
    const capped = await collectStatus(
      transport(async () => page([rawPr(1)], 2, true, "next")),
      { repos: ["o/r"], authors: ["ctate"], maxPages: 1 },
    );
    expect(capped.coverage[0].errors[0].code).toBe("PAGE_LIMIT");
  });

  test("retains completed sibling repositories and reports progress from real pages", async () => {
    const progress: number[] = [];
    const report = await collectStatus(
      transport(async (_q, vars) => {
        if (vars?.repo === "broken") throw new Error("denied");
        return page([]);
      }),
      {
        repos: ["o/good", "o/broken"],
        authors: ["ctate"],
        onProgress: (event) => progress.push(event.pages),
      },
    );
    expect(report.projects.find((p) => p.repo === "o/good")?.counts.open.count).toBe(0);
    expect(report.projects.find((p) => p.repo === "o/broken")?.counts.open.count).toBeNull();
    expect(progress).toEqual([1]);
  });

  test("bounded concurrency and input guards", async () => {
    let active = 0;
    let peak = 0;
    const t = transport(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return page([]);
    });
    await collectStatus(t, { repos: ["o/a", "o/b", "o/c"], authors: ["ctate"], concurrency: 2 });
    expect(peak).toBe(2);
    for (const concurrency of [0, 33, 1.5])
      expect(
        collectStatus(t, { repos: ["o/r"], authors: ["ctate"], concurrency }),
      ).rejects.toThrow();
    expect(collectStatus(t, { repos: ["o/r"], authors: ["ctate"], maxPages: 0 })).rejects.toThrow();
  });
});
