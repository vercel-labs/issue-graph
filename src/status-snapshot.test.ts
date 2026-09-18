import { describe, expect, test } from "bun:test";
import { buildStatusReport, type StatusPullRequest } from "./status.js";
import type { StatusSnapshot } from "./status-history-types.js";
import { parseStatusSnapshot, snapshotReport, toStatusSnapshot } from "./status-snapshot.js";

const time = "2026-09-09T13:00:00.000Z";
const pr: StatusPullRequest = {
  id: "o/r#1",
  repo: "o/r",
  number: 1,
  title: "Observed title",
  url: "https://github.com/o/r/pull/1",
  author: "alice",
  headSha: null,
  updatedAt: null,
  isDraft: null,
  reviewState: "unknown",
  mergeability: "UNKNOWN",
  assignees: null,
  requestedReviewers: null,
};

function report() {
  return buildStatusReport(
    [{ ...pr }],
    [
      { repo: "o/r", complete: true, pages: 1, scanned: 1, errors: [] },
      { repo: "o/empty", complete: true, pages: 1, scanned: 0, errors: [] },
    ],
    { repos: ["o/r", "o/empty"], authors: ["alice"], startedAt: time, generatedAt: time },
  );
}

function snapshot(): StatusSnapshot {
  return toStatusSnapshot(report());
}

function withPr(patch: Record<string, unknown>): unknown {
  return { ...snapshot(), pullRequests: [{ ...pr, ...patch }] };
}

describe("status snapshot evidence", () => {
  test("live snapshots round-trip through JSON and rebuild the report", () => {
    const source = report();
    const result = toStatusSnapshot(source);
    expect(result.kind).toBe("issue-graph-status-snapshot");
    expect(result.provenance.kind).toBe("live");
    expect(result).not.toHaveProperty("totals");
    expect(snapshotReport(parseStatusSnapshot(JSON.parse(JSON.stringify(result))))).toEqual(source);
  });

  test("reconstruction provenance and unknown evidence survive without fabricated values", () => {
    const provenance: StatusSnapshot["provenance"] = {
      kind: "reconstructed",
      note: "Observed in the original session; assignments were not recorded.",
      sources: ["session:earlier/12", "local-evidence.json"],
    };
    const source = report();
    const result = toStatusSnapshot(source, provenance);
    expect(parseStatusSnapshot(JSON.parse(JSON.stringify(result)))).toEqual(result);
    expect(result.provenance).toEqual(provenance);
    expect(result.pullRequests[0]).toEqual(pr);
    const rebuilt = snapshotReport(result);
    for (const field of ["drafts", "conflicts", "unassigned"] as const) {
      expect(rebuilt.totals[field].count).toBeNull();
      expect(rebuilt.totals[field].unknownIds).toEqual([pr.id]);
    }
    provenance.sources.push("later");
    source.pullRequests[0].title = "Changed later";
    source.coverage[0].errors.push({ code: "LATER", message: "Changed later" });
    expect(result.provenance.sources).toHaveLength(2);
    expect(result.pullRequests[0].title).toBe(pr.title);
    expect(result.coverage[0].errors).toEqual([]);
  });

  test("raw schema-v1 report imports ignore serialized aggregate claims", () => {
    const raw = JSON.parse(JSON.stringify(report()));
    raw.totals.open.count = 999;
    raw.rows = [];
    raw.projects = [];
    const imported = parseStatusSnapshot(raw);
    expect(imported.provenance.kind).toBe("imported-report");
    expect(imported.provenance.note).toContain("report");
    expect(imported.provenance.sources).toEqual([]);
    expect(snapshotReport(imported)).toEqual(report());
  });

  test("rejects global coverage that contradicts repository evidence", () => {
    const raw = JSON.parse(JSON.stringify(report()));
    raw.coverageComplete = false;
    expect(() => parseStatusSnapshot(raw)).toThrow("contradicts repository coverage");
    raw.coverageComplete = true;
    raw.coverage[0].complete = false;
    expect(() => parseStatusSnapshot(raw)).toThrow("contradicts repository coverage");
  });

  test("normalizes explicit scope and case-insensitive membership", () => {
    const value = snapshot();
    value.scope = { repos: ["O/R", "o/empty", "o/r"], authors: ["ALICE", "alice"] };
    const parsed = parseStatusSnapshot(value);
    expect(parsed.scope).toEqual({ repos: ["o/empty", "O/R"], authors: ["ALICE"] });
    expect(parsed.pullRequests[0].repo).toBe("O/R");
    expect(parsed.pullRequests[0].author).toBe("ALICE");
    expect(parsed.pullRequests[0].id).toBe("o/r#1");
    expect(snapshotReport(parsed).totals.open.count).toBe(1);
  });

  test("retains canonical URLs for renamed repositories and enterprise hosts", () => {
    const url = "https://github.example.com/o/renamed/pull/1";
    expect(parseStatusSnapshot(withPr({ url })).pullRequests[0].url).toBe(url);
  });

  test("nullable fields also accept known values and string arrays", () => {
    const parsed = parseStatusSnapshot(
      withPr({
        headSha: "abc123",
        updatedAt: time,
        isDraft: false,
        reviewState: "approved",
        mergeability: "MERGEABLE",
        assignees: [],
        requestedReviewers: ["o/team", "alice"],
      }),
    );
    expect(snapshotReport(parsed).totals.approved.count).toBe(1);
    expect(snapshotReport(parsed).totals.unassigned.count).toBe(1);
  });

  test("partial evidence remains partial, with errors and null aggregate counts", () => {
    const value = snapshot();
    value.coverage[1].complete = false;
    value.coverage[1].errors = [{ code: "LIMIT", message: "Only the first page was observed." }];
    const parsed = parseStatusSnapshot(value);
    expect(parsed.coverage).toEqual(value.coverage);
    expect(snapshotReport(parsed).totals.open.count).toBeNull();
  });

  test("future timestamps remain pure data for the caller's baseline-time policy", () => {
    const value = snapshot();
    value.startedAt = "2099-01-01T00:00:00.000Z";
    value.generatedAt = "2099-01-01T00:00:01.000Z";
    expect(parseStatusSnapshot(value).generatedAt).toBe(value.generatedAt);
  });

  test("valid leap days and timezone offsets compare by instant", () => {
    const value = snapshot();
    value.startedAt = "2024-02-29T12:00:00+02:00";
    value.generatedAt = "2024-02-29T10:00:01Z";
    expect(parseStatusSnapshot(value).startedAt).toBe(value.startedAt);
  });
});

describe("status snapshot validation", () => {
  test.each([
    "repos",
    "authors",
  ] as const)("rejects control sequences in scope.%s with a field-only diagnostic", (field) => {
    const value = snapshot();
    value.scope[field][0] += "\x1b]52;c;c2VjcmV0\x07";
    expect(() => parseStatusSnapshot(value)).toThrow(/^Invalid status snapshot: scope$/);
  });

  test.each(
    [null, [], "snapshot", 1, {}, { schemaVersion: 2 }].map((value) => ({ value })),
  )("rejects invalid envelopes: %j", ({ value }) => {
    expect(() => parseStatusSnapshot(value)).toThrow();
  });

  test.each([
    { kind: "other" },
    { kind: undefined },
    { schemaVersion: "1" },
    { schemaVersion: 2 },
    { startedAt: "2026-09-10T00:00:00Z" },
    { generatedAt: null },
    { generatedAt: "yesterday" },
    { generatedAt: "2026-02-30T00:00:00Z" },
    { generatedAt: "2026-09-09" },
    { generatedAt: "2026-09-09T24:00:00Z" },
    { generatedAt: "2026-09-09T13:00:00" },
    { generatedAt: "2026-09-09T13:00:00+25:00" },
    { scope: undefined },
    { scope: { repos: [], authors: ["alice"] } },
    { scope: { repos: ["o/r"], authors: [] } },
    { scope: { repos: ["o/r/x"], authors: ["alice"] } },
    { scope: { repos: ["o/r"], authors: ["@alice"] } },
    { scope: { repos: ["o/r"], authors: [7] } },
    { provenance: undefined },
    { provenance: { kind: "unknown", note: "n", sources: [] } },
    { provenance: { kind: "live", note: "", sources: [] } },
    { provenance: { kind: "reconstructed", note: "n", sources: [null] } },
    { provenance: { kind: "reconstructed", note: "n" } },
    { pullRequests: null },
    { coverage: null },
  ])("rejects invalid snapshot fields: %j", (patch) => {
    expect(() => parseStatusSnapshot({ ...snapshot(), ...patch })).toThrow();
  });

  test.each([
    { number: 0 },
    { number: -1 },
    { number: 1.5 },
    { number: Number.MAX_SAFE_INTEGER + 1 },
    { number: "1" },
    { id: "o/r#2" },
    { id: "O/R#1" },
    { repo: "o/other" },
    { author: "outsider" },
    { author: null },
    { title: null },
    { title: 7 },
    { headSha: false },
    { headSha: undefined },
    { updatedAt: "invalid" },
    { updatedAt: "2026-02-29T13:00:00Z" },
    { updatedAt: undefined },
    { isDraft: "false" },
    { isDraft: undefined },
    { reviewState: "APPROVED" },
    { reviewState: null },
    { mergeability: "mergeable" },
    { mergeability: null },
    { assignees: "alice" },
    { assignees: [1] },
    { assignees: undefined },
    { requestedReviewers: [null] },
    { requestedReviewers: {} },
    { url: "http://github.com/o/r/pull/1" },
    { url: "https://alice:secret@github.com/o/r/pull/1" },
    { url: "https://github.com/o/r/pull/2" },
    { url: "https://github.com/o/r/issues/1" },
    { url: "javascript:alert(1)" },
    { url: "https://github.com/o/r/pull/01" },
    { url: " https://github.com/o/r/pull/1" },
    { url: "https://github.com/o/r/pull/1\n" },
  ])("rejects malformed PR metadata and identity: %j", (patch) => {
    expect(() => parseStatusSnapshot(withPr(patch))).toThrow();
  });

  test.each([
    { complete: "true" },
    { complete: undefined },
    { pages: -1 },
    { pages: 1.5 },
    { pages: Number.MAX_SAFE_INTEGER + 1 },
    { scanned: -1 },
    { scanned: 0 },
    { scanned: Number.NaN },
    { scanned: "1" },
    { errors: undefined },
    { errors: ["failure"] },
    { errors: [{ code: "", message: "failed" }] },
    { errors: [{ code: "FAIL", message: "" }] },
    { errors: [{ code: "FAIL", message: "failed" }] },
    { repo: "outside/scope" },
  ])("rejects invalid coverage and cross-field bounds: %j", (patch) => {
    const value = snapshot();
    expect(() =>
      parseStatusSnapshot({
        ...value,
        coverage: value.coverage.map((item) =>
          item.repo === "o/r" ? { ...item, ...patch } : item,
        ),
      }),
    ).toThrow();
  });

  test("requires exactly one coverage entry per scoped repository and unique PR identities", () => {
    const value = snapshot();
    expect(() => parseStatusSnapshot({ ...value, coverage: value.coverage.slice(1) })).toThrow(
      "omits",
    );
    expect(() =>
      parseStatusSnapshot({
        ...value,
        coverage: [...value.coverage, { ...value.coverage[1], repo: "O/R" }],
      }),
    ).toThrow("duplicate");
    expect(() =>
      parseStatusSnapshot({ ...value, pullRequests: [pr, { ...pr, repo: "O/R" }] }),
    ).toThrow("duplicate");
  });

  test("scanned bounds are per repository, not pooled across the scope", () => {
    const value = snapshot();
    value.coverage[0].scanned = 100;
    value.coverage[1].scanned = 0;
    expect(() => parseStatusSnapshot(value)).toThrow("below matched");
  });

  test("public conversion and reconstruction validate rather than silently repair evidence", () => {
    const source = report();
    source.pullRequests[0].id = "wrong#1";
    expect(() => toStatusSnapshot(source)).toThrow("PR id");
    const value = snapshot();
    value.coverage = [];
    expect(() => snapshotReport(value)).toThrow("omits");
  });

  test("missing raw-report evidence is not invented from counts", () => {
    const raw = JSON.parse(JSON.stringify(report()));
    delete raw.pullRequests;
    expect(() => parseStatusSnapshot(raw)).toThrow("pullRequests");
  });
});
