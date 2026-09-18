import { describe, expect, test } from "bun:test";
import {
  buildStatusReport,
  STATUS_METRICS,
  type StatusCoverage,
  type StatusPullRequest,
} from "./status.js";
import { compareStatusSnapshots, inspectStatusHistory } from "./status-history.js";
import type { StatusDeparture, StatusSnapshot } from "./status-history-types.js";
import type { GhTransport } from "./transport.js";

const baselineTime = "2026-09-09T10:00:00.000Z";
const startTime = "2026-09-09T11:00:00.000Z";
const endTime = "2026-09-09T11:01:00.000Z";
const terminalTime = "2026-09-09T10:30:00Z";
const checkedTime = "2026-09-09T11:02:00.000Z";
const now = () => checkedTime;
const coverage = (repo = "o/r", complete = true): StatusCoverage => ({
  repo,
  complete,
  pages: 1,
  scanned: 0,
  errors: complete ? [] : [{ code: "FETCH_FAILED", message: "unavailable" }],
});
const pr = (number = 1, extra: Partial<StatusPullRequest> = {}): StatusPullRequest => ({
  id: `o/r#${number}`,
  repo: "o/r",
  number,
  title: `PR ${number}`,
  url: `https://github.com/o/r/pull/${number}`,
  author: "Railly",
  headSha: "a".repeat(40),
  updatedAt: baselineTime,
  isDraft: false,
  reviewState: "required",
  mergeability: "MERGEABLE",
  assignees: [],
  requestedReviewers: [],
  ...extra,
});
const current = (
  prs: StatusPullRequest[],
  inventories = [coverage()],
  repos = ["o/r"],
  authors = ["Railly"],
) =>
  buildStatusReport(prs, inventories, {
    repos,
    authors,
    startedAt: startTime,
    generatedAt: endTime,
  });
const snapshot = (
  prs: StatusPullRequest[],
  inventories = [coverage()],
  repos = ["o/r"],
  authors = ["Railly"],
): StatusSnapshot => ({
  kind: "issue-graph-status-snapshot",
  schemaVersion: 1,
  startedAt: baselineTime,
  generatedAt: baselineTime,
  scope: { repos, authors },
  coverage: inventories,
  pullRequests: prs,
  provenance: { kind: "live", note: "Captured from GitHub", sources: [] },
});
const transport = (graphql: GhTransport["graphql"]): GhTransport => ({
  graphql,
  search: async () => {
    throw new Error("History must not search");
  },
});
const response = (number = 1, extra: Record<string, unknown> = {}) => ({
  data: {
    repository: {
      pullRequest: {
        number,
        state: "MERGED",
        url: `https://github.com/o/r/pull/${number}`,
        repository: { nameWithOwner: "o/r" },
        closedAt: terminalTime,
        mergedAt: terminalTime,
        ...extra,
      },
    },
  },
});
const departure = (extra: Partial<StatusDeparture> = {}): StatusDeparture => ({
  id: "o/r#1",
  repo: "o/r",
  number: 1,
  title: "PR 1",
  url: "https://github.com/o/r/pull/1",
  author: "Railly",
  state: "MERGED",
  checkedAt: checkedTime,
  closedAt: terminalTime,
  mergedAt: terminalTime,
  reason: null,
  ...extra,
});

describe("pure status history", () => {
  test("unknown metadata on newly observed PRs keeps comparison incomplete", () => {
    const result = compareStatusSnapshots(
      snapshot([]),
      current([pr(1, { mergeability: "UNKNOWN" })]),
      [],
      checkedTime,
    );
    expect(result.added).toHaveLength(1);
    expect(result.coverageComplete).toBe(false);
    expect(result.totals.conflicts.delta).toBeNull();
    expect(result.uncertain[0].reason).toContain("mergeability");
  });

  test("a merge predating the baseline and impossible merge chronology are unverified", () => {
    for (const evidence of [
      departure({ mergedAt: "2026-09-09T09:00:00Z" }),
      departure({ mergedAt: "2026-09-09T10:31:00Z", closedAt: "2026-09-09T10:30:00Z" }),
    ]) {
      const result = compareStatusSnapshots(snapshot([pr()]), current([]), [evidence], checkedTime);
      expect(result.departures[0].state).toBe("UNVERIFIED");
      expect(result.coverageComplete).toBe(false);
    }
  });

  for (const state of ["MERGED", "CLOSED"] as const) {
    test(`${state} evidence must match the baseline URL origin`, async () => {
      for (const [baselineOrigin, evidenceOrigin] of [
        ["https://github.com", "https://github.example.com"],
        ["https://github.example.com", "https://github.com"],
        ["https://github.com", "https://github.com:8443"],
      ]) {
        const before = snapshot([pr(1, { url: `${baselineOrigin}/o/r/pull/1` })]);
        const evidence = departure({
          state,
          mergedAt: state === "MERGED" ? terminalTime : null,
          url: `${evidenceOrigin}/o/r/pull/1`,
        });
        const histories = [
          compareStatusSnapshots(before, current([]), [evidence], checkedTime),
          await inspectStatusHistory(
            transport(async () => response(1, { ...evidence })),
            before,
            current([]),
            { now },
          ),
        ];
        for (const history of histories) {
          expect(history.departures[0]).toMatchObject({
            state: "UNVERIFIED",
            url: `${baselineOrigin}/o/r/pull/1`,
            mergedAt: null,
            closedAt: null,
          });
          expect(history.uncertain[0].reason).toContain("URL");
          expect(history.coverageComplete).toBe(false);
        }
      }
    });

    test(`${state} evidence outside the current observation window remains uncertain`, () => {
      for (const times of [
        { checkedAt: "2026-09-09T10:59:59.999Z" },
        { checkedAt: "2026-09-09T11:02:00.001Z" },
        { checkedAt: "2026-09-10T11:02:00.000Z" },
        {
          checkedAt: "2026-09-10T11:02:00.000Z",
          closedAt: "2026-09-10T11:01:00.000Z",
          mergedAt: state === "MERGED" ? "2026-09-10T11:01:00.000Z" : null,
        },
        {
          closedAt: "2026-09-09T11:02:00.001Z",
          mergedAt: state === "MERGED" ? "2026-09-09T11:02:00.001Z" : null,
        },
        {
          closedAt: "2026-09-09T09:59:59.999Z",
          mergedAt: state === "MERGED" ? "2026-09-09T09:59:59.999Z" : null,
        },
      ]) {
        const evidence = departure({
          state,
          mergedAt: state === "MERGED" ? terminalTime : null,
          ...times,
        });
        const history = compareStatusSnapshots(
          snapshot([pr()]),
          current([]),
          [evidence],
          checkedTime,
        );
        expect(history.departures[0]).toMatchObject({
          state: "UNVERIFIED",
          closedAt: null,
          mergedAt: null,
        });
        expect(history.uncertain[0].reason).toContain("Membership");
        expect(history.coverageComplete).toBe(false);
      }
    });

    test(`${state} accepts matching origins and inclusive observation boundaries`, () => {
      for (const checkedAt of [startTime, endTime, checkedTime, "2026-09-09T13:02:00+02:00"]) {
        const before = snapshot([pr(1, { url: "https://github.example.com/o/r/pull/1" })]);
        const evidence = departure({
          state,
          url: "https://GITHUB.example.com:443/o/r/pull/1",
          checkedAt,
          closedAt: terminalTime,
          mergedAt: state === "MERGED" ? terminalTime : null,
        });
        const history = compareStatusSnapshots(before, current([]), [evidence], checkedTime);
        expect(history.departures[0].state).toBe(state);
        expect(history.uncertain).toEqual([]);
        expect(history.coverageComplete).toBe(true);
      }
      const evidence = departure({
        state,
        closedAt: checkedTime,
        mergedAt: state === "MERGED" ? checkedTime : null,
      });
      expect(
        compareStatusSnapshots(snapshot([pr()]), current([]), [evidence], checkedTime).departures[0]
          .state,
      ).toBe(state);
    });
  }

  test("accepted sub-millisecond ISO timestamps remain comparable", () => {
    const previous = {
      ...snapshot([pr()]),
      startedAt: "2026-09-09T10:00:00.000000Z",
      generatedAt: "2026-09-09T10:00:00.000000Z",
    };
    const result = compareStatusSnapshots(previous, current([pr()]), [], checkedTime);
    expect(result.coverageComplete).toBe(true);
    expect(result.changes).toEqual([]);
  });

  test("records all six known field transitions, without review attribution or source mutation", () => {
    const before = snapshot([pr()]);
    const after = current([
      pr(1, {
        reviewState: "changes-requested",
        mergeability: "CONFLICTING",
        isDraft: true,
        headSha: "b".repeat(40),
        assignees: ["Z", "a"],
        requestedReviewers: ["reviewer"],
      }),
    ]);
    const original = JSON.stringify({ before, after });
    const history = compareStatusSnapshots(before, after, [], checkedTime);
    expect(history.changes.map((item) => item.field)).toEqual([
      "assignees",
      "headSha",
      "isDraft",
      "mergeability",
      "requestedReviewers",
      "reviewState",
    ]);
    expect(history.changes[0].after).toEqual(["a", "z"]);
    expect(history.changes[5]).toMatchObject({
      before: "required",
      after: "changes-requested",
      author: "Railly",
    });
    expect(history.totals.changesRequested).toEqual({ before: 0, after: 1, delta: 1 });
    expect(history.totals.reviewRequired.delta).toBe(-1);
    expect(history.coverageComplete).toBe(true);
    expect(JSON.stringify(history)).not.toContain("ctate");
    expect(JSON.stringify({ before, after })).toBe(original);
  });

  test("review and draft transitions also work in the reverse direction", () => {
    const history = compareStatusSnapshots(
      snapshot([pr(1, { reviewState: "changes-requested", isDraft: true })]),
      current([pr(1, { reviewState: "approved" })]),
      [],
      checkedTime,
    );
    expect(history.changes.map((item) => [item.field, item.before, item.after])).toEqual([
      ["isDraft", true, false],
      ["reviewState", "changes-requested", "approved"],
    ]);
    expect(history.totals.approved.delta).toBe(1);
    expect(history.totals.drafts.delta).toBe(-1);
  });

  test("case, array order, duplicate names, titles and update timestamps do not create changes", () => {
    const history = compareStatusSnapshots(
      snapshot([pr(1, { assignees: ["A", "z", "a"], requestedReviewers: ["ORG/team", "user"] })]),
      current([
        pr(1, {
          assignees: ["Z", "a"],
          requestedReviewers: ["USER", "org/TEAM", "user"],
          title: "renamed",
          updatedAt: endTime,
        }),
      ]),
      [],
      checkedTime,
    );
    expect(history.changes).toEqual([]);
    expect(history.uncertain).toEqual([]);
    expect(history.coverageComplete).toBe(true);
    for (const metric of STATUS_METRICS) expect(history.totals[metric].delta).toBe(0);
  });

  test("scope equality ignores order and case for repositories and authors", () => {
    const history = compareStatusSnapshots(
      snapshot([pr()], [coverage(), coverage("o/s")], ["o/s", "o/r"], ["Railly", "Other"]),
      current([pr()], [coverage("O/R"), coverage("O/S")], ["O/R", "O/S"], ["OTHER", "RAILLY"]),
      [],
      checkedTime,
    );
    expect(history.coverageComplete).toBe(true);
    expect(history.changes).toEqual([]);
    expect(history.rows).toHaveLength(4);
    expect(history.rows.every((row) => row.counts.open.delta === 0)).toBe(true);
  });

  for (const field of [
    "reviewState",
    "mergeability",
    "isDraft",
    "headSha",
    "assignees",
    "requestedReviewers",
  ] as const) {
    for (const side of ["baseline", "current", "both"] as const) {
      test(`${field} unknown in ${side} creates uncertainty, not a transition`, () => {
        const unknown = {
          [field]:
            field === "reviewState" ? "unknown" : field === "mergeability" ? "UNKNOWN" : null,
        };
        const history = compareStatusSnapshots(
          snapshot([pr(1, side !== "current" ? unknown : {})]),
          current([pr(1, side !== "baseline" ? unknown : {})]),
          [],
          checkedTime,
        );
        expect(history.changes).toEqual([]);
        expect(history.coverageComplete).toBe(false);
        expect(history.uncertain).toHaveLength(1);
        expect(history.uncertain[0].reason).toContain(field);
        expect(history.uncertain[0].reason).toContain("unknown");
      });
    }
  }

  test("unknown review buckets and flags cannot yield numeric claims", () => {
    const history = compareStatusSnapshots(
      snapshot([
        pr(1, { reviewState: "unknown", mergeability: "UNKNOWN", isDraft: null, assignees: null }),
      ]),
      current([pr(1, { reviewState: "approved", isDraft: true })]),
      [],
      checkedTime,
    );
    for (const metric of [
      "reviewRequired",
      "changesRequested",
      "approved",
      "notRequired",
      "drafts",
      "conflicts",
      "unassigned",
    ] as const) {
      expect(history.totals[metric].before).toBeNull();
      expect(history.totals[metric].delta).toBeNull();
      expect(history.rows[0].counts[metric].delta).toBeNull();
    }
    expect(history.totals.open.delta).toBe(0);
    expect(history.totals.reviewUnknown).toEqual({ before: 1, after: 0, delta: -1 });
  });

  test("rebuilds counts from PR evidence rather than trusting report aggregate fields", () => {
    const after = current([pr()]);
    after.totals.open.count = 900;
    const history = compareStatusSnapshots(snapshot([pr()]), after, [], checkedTime);
    expect(history.totals.open.after).toBe(1);
    expect(after.totals.open.count).toBe(900);
  });

  test("failed sibling does not erase valid same-PR changes or row deltas", () => {
    const before = snapshot([pr()], [coverage(), coverage("o/s")], ["o/r", "o/s"]);
    const after = current(
      [pr(1, { reviewState: "approved" })],
      [coverage(), coverage("o/s", false)],
      ["o/r", "o/s"],
    );
    const history = compareStatusSnapshots(before, after, [], checkedTime);
    expect(history.changes).toHaveLength(1);
    expect(history.coverageComplete).toBe(false);
    expect(history.rows.find((row) => row.repo === "o/r")?.counts.approved.delta).toBe(1);
    expect(history.rows.find((row) => row.repo === "o/s")?.counts.approved.delta).toBeNull();
    expect(history.totals.approved.delta).toBeNull();
  });

  test("partial baseline gates added claims per repository and records membership uncertainty", () => {
    const before = snapshot([], [coverage(), coverage("o/s", false)], ["o/r", "o/s"]);
    const after = current(
      [pr(), pr(2, { repo: "o/s", id: "o/s#2" })],
      [coverage(), coverage("o/s")],
      ["o/r", "o/s"],
    );
    const history = compareStatusSnapshots(before, after, [], checkedTime);
    expect(history.added.map((item) => item.id)).toEqual(["o/r#1"]);
    expect(history.uncertain).toEqual([
      {
        id: "o/s#2",
        reason: expect.stringContaining("baseline repository inventory was incomplete"),
      },
    ]);
    expect(history.coverageComplete).toBe(false);
    expect(history.rows.find((row) => row.repo === "o/s")?.counts.open.before).toBeNull();
  });

  test("missing coverage is not an empty baseline", () => {
    const history = compareStatusSnapshots(snapshot([], []), current([pr()]), [], checkedTime);
    expect(history.added).toEqual([]);
    expect(history.uncertain[0].reason).toContain("Membership");
  });

  test("newly in scope does not depend on PR creation or update time", () => {
    const history = compareStatusSnapshots(snapshot([]), current([pr()]), [], checkedTime);
    expect(history.added.map((item) => item.id)).toEqual(["o/r#1"]);
    expect(history.totals.open.delta).toBe(1);
  });

  test("missing PR without evidence remains unverified, while irrelevant evidence is ignored", () => {
    const history = compareStatusSnapshots(
      snapshot([pr(), pr(2)]),
      current([pr(2)]),
      [departure({ id: "o/r#2", number: 2 })],
      checkedTime,
    );
    expect(history.departures).toHaveLength(1);
    expect(history.departures[0].state).toBe("UNVERIFIED");
    expect(history.uncertain[0].id).toBe("o/r#1");
  });

  test("pure comparison rejects malformed or conflicting supplied terminal evidence", () => {
    for (const evidence of [
      [departure({ number: 2 })],
      [departure({ closedAt: "bad" })],
      [departure(), departure({ state: "CLOSED", mergedAt: null })],
    ]) {
      const history = compareStatusSnapshots(snapshot([pr()]), current([]), evidence, checkedTime);
      expect(history.departures[0].state).toBe("UNVERIFIED");
      expect(history.coverageComplete).toBe(false);
    }
  });

  test("changes, additions, departures and uncertainties have deterministic ID and field ordering", () => {
    const before = snapshot([pr(2), pr(10), pr(7), pr(6)]);
    const after = current([
      pr(2, { isDraft: true, headSha: null }),
      pr(10, { isDraft: true, headSha: null }),
      pr(9),
      pr(3),
    ]);
    const a = compareStatusSnapshots(before, after, [], checkedTime);
    const b = compareStatusSnapshots(
      { ...before, pullRequests: [...before.pullRequests].reverse() },
      { ...after, pullRequests: [...after.pullRequests].reverse() },
      [],
      checkedTime,
    );
    expect(a).toEqual(b);
    expect(a.changes.map((item) => item.id)).toEqual(["o/r#10", "o/r#2"]);
    expect(a.departures.map((item) => item.id)).toEqual(["o/r#6", "o/r#7"]);
    expect(a.added.map((item) => item.id)).toEqual(["o/r#3", "o/r#9"]);
  });

  test("preserves reconstructed baseline provenance without sharing its source array", () => {
    const before = snapshot([pr()]);
    before.provenance = {
      kind: "reconstructed",
      note: "Partial historical evidence",
      sources: ["earlier observation"],
    };
    const history = compareStatusSnapshots(before, current([pr()]), [], checkedTime);
    expect(history.previousProvenance).toEqual(before.provenance);
    history.previousProvenance.sources.push("new");
    expect(before.provenance.sources).toEqual(["earlier observation"]);
  });

  test("rejects mismatched scopes, future baselines, overlapping windows and invalid timestamps", () => {
    const before = snapshot([]);
    const after = current([]);
    for (const changed of [
      { ...before, scope: { repos: ["o/other"], authors: ["Railly"] } },
      { ...before, scope: { repos: ["o/r"], authors: ["other"] } },
      { ...before, generatedAt: "2026-09-09T11:00:30.000Z" },
      { ...before, generatedAt: checkedTime },
      { ...before, generatedAt: "2026-02-30T10:00:00.000Z" },
      { ...before, startedAt: endTime },
    ])
      expect(() => compareStatusSnapshots(changed, after, [], checkedTime)).toThrow();
    expect(() => compareStatusSnapshots(before, after, [], "invalid")).toThrow();
    expect(() =>
      compareStatusSnapshots(before, { ...after, generatedAt: baselineTime }, [], checkedTime),
    ).toThrow();
    expect(() =>
      compareStatusSnapshots({ ...before, generatedAt: startTime }, after, [], checkedTime),
    ).not.toThrow();
    expect(() =>
      compareStatusSnapshots(
        { ...before, generatedAt: "2026-09-09T12:00:00+02:00" },
        after,
        [],
        checkedTime,
      ),
    ).not.toThrow();
  });
});

describe("terminal status inspection", () => {
  test("verifies MERGED and CLOSED using explicit read-only GraphQL PR queries", async () => {
    const calls: Array<Record<string, string | number> | undefined> = [];
    const t = transport(async (query, variables) => {
      expect(query).toContain("pullRequest(number:$number)");
      expect(query).not.toContain("mutation");
      for (const field of [
        "state",
        "url",
        "number",
        "mergedAt",
        "closedAt",
        "repository{nameWithOwner}",
      ])
        expect(query).toContain(field);
      calls.push(variables);
      return response(
        Number(variables?.number),
        variables?.number === 2 ? { state: "CLOSED", mergedAt: null } : {},
      );
    });
    const history = await inspectStatusHistory(t, snapshot([pr(2), pr()]), current([]), { now });
    expect(calls).toHaveLength(2);
    expect(calls).toContainEqual({ owner: "o", repo: "r", number: 1 });
    expect(history.departures.map((item) => item.state)).toEqual(["MERGED", "CLOSED"]);
    expect(
      history.departures.every((item) => item.checkedAt === checkedTime && item.reason === null),
    ).toBe(true);
    expect(history.coverageComplete).toBe(true);
    expect(history.comparedAt).toBe(checkedTime);
  });

  test("terminal evidence survives failed inventory in the same repo and sibling repos", async () => {
    const history = await inspectStatusHistory(
      transport(async () => response()),
      snapshot([pr()], [coverage(), coverage("o/s")], ["o/r", "o/s"]),
      current([], [coverage("o/r", false), coverage("o/s", false)], ["o/r", "o/s"]),
      { now },
    );
    expect(history.departures[0].state).toBe("MERGED");
    expect(history.coverageComplete).toBe(false);
    expect(history.totals.open.after).toBeNull();
  });

  for (const [label, result] of [
    ["null response", null],
    ["missing data", {}],
    ["missing PR", { data: { repository: { pullRequest: null } } }],
    ["GraphQL errors with usable data", { ...response(), errors: [{ message: "denied" }] }],
    ["malformed errors", { ...response(), errors: "denied" }],
    ["OPEN", response(1, { state: "OPEN", mergedAt: null, closedAt: null })],
    ["invalid state", response(1, { state: "DELETED" })],
    ["missing repository identity", response(1, { repository: null })],
    ["repository mismatch", response(1, { repository: { nameWithOwner: "other/r" } })],
    ["number mismatch", response(2)],
    ["string number", response(1, { number: "1" })],
    ["fractional number", response(1, { number: 1.5 })],
    ["unsafe number", response(1, { number: Number.MAX_SAFE_INTEGER + 1 })],
    ["non-HTTPS URL", response(1, { url: "http://github.com/o/r/pull/1" })],
    ["unsafe URL", response(1, { url: "javascript:alert(1)" })],
    ["credential URL", response(1, { url: "https://user@github.com/o/r/pull/1" })],
    ["URL number mismatch", response(1, { url: "https://github.com/o/r/pull/2" })],
    ["URL repo mismatch", response(1, { url: "https://github.com/o/other/pull/1" })],
    ["control characters in URL", response(1, { url: "https://github.com/o/r/pull/1\n" })],
    ["missing URL", response(1, { url: undefined })],
    ["invalid mergedAt", response(1, { mergedAt: "yesterday" })],
    ["rollover date", response(1, { mergedAt: "2026-02-30T10:30:00Z" })],
    ["invalid hour", response(1, { closedAt: "2026-09-09T24:00:00Z" })],
    ["future date", response(1, { mergedAt: "2026-09-10T10:00:00Z" })],
    ["null mergedAt", response(1, { mergedAt: null })],
    ["missing closedAt", response(1, { closedAt: undefined })],
    ["numeric closedAt", response(1, { closedAt: 123 })],
    ["closed PR with mergedAt", response(1, { state: "CLOSED" })],
    [
      "closed PR missing closedAt",
      response(1, { state: "CLOSED", mergedAt: null, closedAt: null }),
    ],
  ] as const) {
    test(`${label} remains UNVERIFIED, never a terminal claim`, async () => {
      const history = await inspectStatusHistory(
        transport(async () => result),
        snapshot([pr()]),
        current([]),
        { now },
      );
      expect(history.departures[0]).toMatchObject({
        state: "UNVERIFIED",
        mergedAt: null,
        closedAt: null,
      });
      expect(history.departures[0].reason).toBeTruthy();
      expect(history.uncertain[0].reason).toContain("Membership");
      expect(history.coverageComplete).toBe(false);
    });
  }

  test("a thrown lookup failure does not cancel its sibling", async () => {
    const history = await inspectStatusHistory(
      transport(async (_query, variables) => {
        if (variables?.number === 1) throw new Error("not accessible");
        return response(2);
      }),
      snapshot([pr(), pr(2)]),
      current([]),
      { now },
    );
    expect(history.departures.map((item) => item.state)).toEqual(["UNVERIFIED", "MERGED"]);
    expect(history.departures[0].reason).toContain("not accessible");
  });

  test("accepts case-insensitive repository identity and valid timezone timestamps", async () => {
    const history = await inspectStatusHistory(
      transport(async () =>
        response(1, {
          repository: { nameWithOwner: "O/R" },
          mergedAt: "2026-09-09T12:30:00+02:00",
        }),
      ),
      snapshot([pr()]),
      current([]),
      { now },
    );
    expect(history.departures[0].state).toBe("MERGED");
  });

  test("no API calls when no previous PR is missing, including an empty baseline", async () => {
    let calls = 0;
    const t = transport(async () => {
      calls++;
      throw new Error("must not call");
    });
    await inspectStatusHistory(t, snapshot([pr()]), current([pr()]), { now });
    await inspectStatusHistory(t, snapshot([]), current([pr()]), { now });
    expect(calls).toBe(0);
  });

  test("validates scope, window and concurrency before network access", async () => {
    let calls = 0;
    const t = transport(async () => {
      calls++;
      return response();
    });
    for (const concurrency of [0, -1, 1.5, 33, Number.NaN, Number.POSITIVE_INFINITY])
      await expect(
        inspectStatusHistory(t, snapshot([pr()]), current([]), { concurrency, now }),
      ).rejects.toThrow("concurrency");
    await expect(
      inspectStatusHistory(t, { ...snapshot([pr()]), generatedAt: endTime }, current([]), { now }),
    ).rejects.toThrow("overlap");
    await expect(
      inspectStatusHistory(t, snapshot([pr()]), current([], [coverage("o/s")], ["o/s"]), { now }),
    ).rejects.toThrow("scope");
    expect(calls).toBe(0);
  });

  test("bounds concurrency and checks each missing PR exactly once", async () => {
    let active = 0;
    let peak = 0;
    const called: number[] = [];
    const releases: Array<() => void> = [];
    const t = transport(async (_query, variables) => {
      active++;
      peak = Math.max(peak, active);
      const number = Number(variables?.number);
      called.push(number);
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
      return response(number);
    });
    const pending = inspectStatusHistory(
      t,
      snapshot(Array.from({ length: 7 }, (_, i) => pr(i + 1))),
      current([]),
      { concurrency: 2, now },
    );
    expect(called).toHaveLength(2);
    for (let i = 0; i < 7; i++) {
      while (!releases.length) await Promise.resolve();
      releases.shift()?.();
      await Promise.resolve();
    }
    const history = await pending;
    expect(peak).toBe(2);
    expect(active).toBe(0);
    expect([...called].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(history.departures).toHaveLength(7);
  });

  test("lookup timestamps are recorded after responses and comparison time after lookups", async () => {
    let returned = false;
    let ticks = 0;
    const clock = () => {
      expect(returned).toBe(true);
      return ticks++ === 0 ? checkedTime : "2026-09-09T11:03:00.000Z";
    };
    const history = await inspectStatusHistory(
      transport(async () => {
        returned = true;
        return response();
      }),
      snapshot([pr()]),
      current([]),
      { now: clock },
    );
    expect(history.departures[0].checkedAt).toBe(checkedTime);
    expect(history.comparedAt).toBe("2026-09-09T11:03:00.000Z");
  });
});
