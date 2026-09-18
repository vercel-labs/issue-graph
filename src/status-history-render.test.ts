import { describe, expect, test } from "bun:test";
import { buildStatusReport, STATUS_METRICS, type StatusPullRequest } from "./status.js";
import { compareStatusSnapshots } from "./status-history.js";
import { renderStatusHistory } from "./status-history-render.js";
import type { StatusHistory, StatusSnapshot } from "./status-history-types.js";

const beforeTime = "2026-09-09T10:00:00.000Z";
const afterTime = "2026-09-09T11:00:00.000Z";
const checkedTime = "2026-09-09T11:01:00.000Z";
const pr = (number: number, extra: Partial<StatusPullRequest> = {}): StatusPullRequest => ({
  id: `o/r#${number}`,
  repo: "o/r",
  number,
  title: `PR ${number}`,
  url: `https://github.com/o/r/pull/${number}`,
  author: "Railly",
  headSha: "a".repeat(40),
  updatedAt: beforeTime,
  isDraft: false,
  reviewState: "required",
  mergeability: "MERGEABLE",
  assignees: [],
  requestedReviewers: [],
  ...extra,
});
function history(before = [pr(1)], after = before, authors = ["Railly"]): StatusHistory {
  const scope = { repos: ["o/r"], authors };
  const coverage = [{ repo: "o/r", complete: true, pages: 1, scanned: 1, errors: [] }];
  const snapshot: StatusSnapshot = {
    kind: "issue-graph-status-snapshot",
    schemaVersion: 1,
    startedAt: beforeTime,
    generatedAt: beforeTime,
    scope,
    coverage,
    pullRequests: before,
    provenance: { kind: "live", note: "GitHub capture", sources: [] },
  };
  const report = buildStatusReport(after, coverage, {
    ...scope,
    startedAt: afterTime,
    generatedAt: afterTime,
  });
  return compareStatusSnapshots(snapshot, report, [], checkedTime);
}

describe("status history appendix", () => {
  test("80-column comparisons compact shared owners and field labels before falling back", () => {
    const input = history(
      [pr(1)],
      [pr(1, { reviewState: "changes-requested", requestedReviewers: ["Railly"] })],
    );
    for (const change of input.changes) change.id = "vercel-labs/agent-browser#1770";
    const output = renderStatusHistory(input, { width: 80 });
    expect(output).toContain("PR owner: vercel-labs");
    expect(output).toContain("agent-browser#1770");
    expect(output).toContain("Reviewers");
    expect(output).not.toContain("PR: vercel-labs");
    for (const line of output.split("\n")) expect(line.length).toBeLessThanOrEqual(80);
  });

  for (const format of ["table", "markdown"] as const) {
    test(`${format} shows baseline, comparison time, provenance, deltas and known transitions`, () => {
      const input = history(
        [pr(1)],
        [pr(1, { reviewState: "changes-requested", assignees: ["reviewer"], isDraft: true })],
      );
      const rendered = renderStatusHistory(input, { format, width: 200 });
      expect(rendered).toContain(format === "markdown" ? "## Changes" : "Changes");
      expect(rendered).toContain("Baseline:");
      expect(rendered).toContain(
        format === "markdown" ? "2026\\-09\\-09T10:00:00\\.000Z" : beforeTime,
      );
      expect(rendered).toContain("Compared at:");
      expect(rendered).toContain("Baseline provenance: live");
      expect(rendered).toContain("Changes requested 0 → 1 (+1)");
      expect(rendered).toContain("PR");
      expect(rendered).toContain("Field");
      expect(rendered).toContain("Before");
      expect(rendered).toContain("After");
      expect(rendered).toContain("reviewState");
      expect(rendered).toContain(
        format === "markdown" ? "changes\\-requested" : "changes-requested",
      );
      expect(rendered).not.toContain("ctate");
      expect(rendered).not.toContain("No changes");
      expect(rendered).not.toContain(String.fromCharCode(27));
    });

    test(`${format} shows author row deltas even when totals and tracked fields are unchanged`, () => {
      const input = history(
        [pr(1, { author: "alice" })],
        [pr(1, { author: "bob" })],
        ["alice", "bob"],
      );
      expect(STATUS_METRICS.every((metric) => input.totals[metric].delta === 0)).toBe(true);
      expect(input.changes).toEqual([]);
      expect(input.added).toEqual([]);
      expect(input.departures).toEqual([]);
      expect(input.uncertain).toEqual([]);
      expect(input.rows.map((row) => row.counts.open.delta)).toEqual([-1, 1]);
      const original = JSON.stringify(input);
      const rendered = renderStatusHistory(input, { format, width: 200 });
      expect(rendered).toContain("Delta rows:");
      expect(rendered).toContain("o/r · alice: Open 1 → 0 (-1)");
      expect(rendered).toContain("o/r · bob: Open 0 → 1 (+1)");
      expect(rendered).toContain("Review required 1 → 0 (-1)");
      expect(rendered).not.toContain("No changes");
      expect(rendered).not.toContain("Comparison is incomplete");
      expect(rendered).not.toContain("| PR |");
      expect(
        renderStatusHistory({ ...input, rows: [...input.rows].reverse() }, { format, width: 200 }),
      ).toBe(rendered);
      expect(JSON.stringify(input)).toBe(original);
      input.coverageComplete = false;
      const partial = renderStatusHistory(input, { format, width: 200 });
      expect(partial).toContain("INCOMPLETE");
      expect(partial).toContain("o/r · alice: Open 1 → 0 (-1)");
      expect(partial).not.toContain("No changes");
    });

    test(`${format} unknown row deltas are not treated as zero or known changes`, () => {
      const input = history();
      input.rows[0].counts.approved = { before: null, after: 0, delta: null };
      const rendered = renderStatusHistory(input, { format });
      expect(rendered).toContain("INCOMPLETE");
      expect(rendered).toContain("Comparison is incomplete; changes cannot be ruled out.");
      expect(rendered).not.toContain("No changes");
      expect(rendered).not.toContain("Delta rows:");
    });

    test(`${format} says no changes only for a complete known comparison`, () => {
      const unchanged = renderStatusHistory(history(), { format });
      expect(unchanged).toContain("No changes.");
      expect(unchanged).not.toContain("Delta rows:");
      const incomplete = history();
      incomplete.coverageComplete = false;
      expect(renderStatusHistory(incomplete, { format })).not.toContain("No changes");
      expect(renderStatusHistory(incomplete, { format })).toContain("INCOMPLETE");
      const unknown = history([pr(1, { headSha: null })]);
      expect(renderStatusHistory(unknown, { format })).toContain("uncertain");
      expect(renderStatusHistory(unknown, { format })).not.toContain("No changes");
      const unknownTotals = history();
      unknownTotals.totals.approved.delta = null;
      expect(renderStatusHistory(unknownTotals, { format })).not.toContain("No changes");
    });

    test(`${format} shows new-to-scope, merged, closed and uncertain membership separately`, () => {
      const input = history([pr(1), pr(2), pr(3)], [pr(4)]);
      input.departures[0] = {
        ...input.departures[0],
        state: "MERGED",
        closedAt: afterTime,
        mergedAt: afterTime,
        reason: null,
      };
      input.departures[1] = {
        ...input.departures[1],
        state: "CLOSED",
        closedAt: afterTime,
        mergedAt: null,
        reason: null,
      };
      input.uncertain = input.uncertain.filter((item) => item.id === "o/r#3");
      const rendered = renderStatusHistory(input, { format, width: 200 });
      expect(rendered).toContain("newly in scope");
      expect(rendered).not.toContain("newly created");
      expect(rendered).toContain("merged");
      expect(rendered).toContain("MERGED");
      expect(rendered).toContain("closed");
      expect(rendered).toContain("CLOSED");
      expect(rendered).toContain("uncertain");
      expect(rendered).toContain("terminal state has not been verified");
    });

    test(`${format} makes reconstructed provenance visible and does not invent a reviewer`, () => {
      const input = history([pr(1)], [pr(1, { reviewState: "approved" })]);
      input.previousProvenance = {
        kind: "reconstructed",
        note: "Only earlier observed metadata",
        sources: ["prior capture"],
      };
      const rendered = renderStatusHistory(input, { format });
      expect(rendered).toContain("reconstructed");
      expect(rendered).toContain("Only earlier observed metadata");
      expect(rendered).toContain("Sources: prior capture");
      expect(rendered).not.toContain("ctate");
    });
  }

  test("row summaries include only known nonzero metrics and sort repositories without mutation", () => {
    const input = history([pr(1)], [pr(1, { isDraft: true })]);
    input.rows[0].counts.approved = { before: null, after: 0, delta: null };
    input.rows.push({ ...input.rows[0], repo: "a/r" });
    const original = JSON.stringify(input);
    const rendered = renderStatusHistory(input, { width: 200 });
    expect(rendered).toContain("INCOMPLETE");
    expect(rendered).toContain(
      "Delta rows:\na/r · Railly: Drafts 0 → 1 (+1)\no/r · Railly: Drafts 0 → 1 (+1)\n",
    );
    expect(rendered).not.toContain("No changes");
    expect(JSON.stringify(input)).toBe(original);
  });

  test("row labels are sanitized, Markdown escaped and wrapped at narrow widths", () => {
    const input = history(
      [pr(1, { author: "alice" })],
      [pr(1, { author: "bob" })],
      ["alice", "bob"],
    );
    const esc = String.fromCharCode(27);
    input.rows[0].repo = `${esc}[31m<img>|repo${esc}[0m\n## fake`;
    input.rows[0].author = "[alice](bad)\u202e";
    const markdown = renderStatusHistory(input, { format: "markdown" });
    expect(markdown).toContain(
      "&lt;img&gt;\\|repo \\#\\# fake · \\[alice\\]\\(bad\\): Open 1 → 0 (-1)",
    );
    expect(markdown).not.toContain("<img>");
    expect(markdown).not.toContain("\n## fake");
    const table = renderStatusHistory(input, { width: 16 });
    expect(table.split("\n").every((line) => [...line].length <= 16)).toBe(true);
    expect(table.replaceAll("\n", "")).toContain(
      "<img>|repo ## fake · [alice](bad): Open 1 → 0 (-1)",
    );
    for (const rendered of [table, markdown]) {
      expect(rendered).not.toContain(esc);
      expect(rendered).not.toContain("\u202e");
      expect(rendered).not.toContain("No changes");
    }
  });

  test("Markdown escapes untrusted cells, timestamps, reasons and provenance", () => {
    const input = history(
      [pr(1)],
      [pr(1, { assignees: ["A|B", "[link](javascript:bad)", "<script>", "`code`"] })],
    );
    input.previousProvenance.note = "<img src=x> | **fake**\n## injected";
    input.previousProvenance.sources = ["[source](https://example.com)"];
    input.previousGeneratedAt = "unsafe|time";
    input.uncertain.push({ id: "o/r#2|oops", reason: "<script>\n| fake | table |" });
    const rendered = renderStatusHistory(input, { format: "markdown" });
    expect(rendered).toContain("a\\|b");
    expect(rendered).toContain("\\[link\\]\\(javascript:bad\\)");
    expect(rendered).toContain("&lt;script&gt;");
    expect(rendered).toContain("\\`code\\`");
    expect(rendered).toContain("unsafe\\|time");
    expect(rendered).toContain("\\*\\*fake\\*\\*");
    expect(rendered).toContain("\\#\\# injected");
    expect(rendered).not.toContain("<img");
    expect(rendered).not.toContain("\n## injected");
    expect(rendered).toContain("| PR | Field | Before | After |");
  });

  test("both formats strip terminal escapes, control characters and bidi text", () => {
    const esc = String.fromCharCode(27);
    const input = history([pr(1)], [pr(1, { headSha: `${esc}[31mvalue${esc}[0m\n\u202eevil` })]);
    input.previousProvenance.note = `${esc}]8;;https://bad.example\u0007label${esc}]8;;\u0007\ttext`;
    input.uncertain.push({ id: `o/r#2${esc}[2J`, reason: `bad\rreason\u009b31m` });
    for (const format of ["table", "markdown"] as const) {
      const rendered = renderStatusHistory(input, { format });
      expect(rendered).not.toContain(esc);
      expect(rendered).not.toContain("\u202e");
      expect(rendered).not.toContain("\u009b");
      expect(rendered).not.toContain("\r");
      expect(rendered).not.toContain("https://bad.example");
      expect(rendered).toContain("label text");
    }
  });

  test("table respects narrow widths without dropping long values or using ANSI", () => {
    const input = history([pr(1)], [pr(1, { headSha: "b".repeat(40) })]);
    const rendered = renderStatusHistory(input, { width: 32 });
    expect(rendered.split("\n").every((line) => [...line].length <= 32)).toBe(true);
    expect(rendered).toContain("PR: o/r#1");
    expect(rendered).toContain("Field: headSha");
    expect(rendered).not.toContain(String.fromCharCode(27));
    expect(renderStatusHistory(input, { width: Number.NaN })).toBe(renderStatusHistory(input));
  });

  test("narrow wrapping preserves complete emoji graphemes", () => {
    const input = history();
    input.previousProvenance.note = "家族 👨‍👩‍👧‍👦 safe";
    const rendered = renderStatusHistory(input, { width: 8 });
    expect(rendered).toContain("👨‍👩‍👧‍👦");
    expect(rendered).not.toContain("\ufffd");
  });

  test("renderer remains deterministic without mutating source arrays", () => {
    const input = history(
      [pr(2), pr(1)],
      [pr(2, { isDraft: true }), pr(1, { reviewState: "approved" })],
    );
    const original = JSON.stringify(input);
    const first = renderStatusHistory(input, { format: "markdown" });
    const second = renderStatusHistory(
      { ...input, changes: [...input.changes].reverse() },
      { format: "markdown" },
    );
    expect(first).toBe(second);
    expect(JSON.stringify(input)).toBe(original);
    expect(first.indexOf("o/r\\#1")).toBeLessThan(first.indexOf("o/r\\#2"));
  });

  test("an unverified departure renders uncertainty even without a companion uncertainty row", () => {
    const input = history([pr(1)], []);
    input.uncertain = [];
    expect(renderStatusHistory(input)).toContain("uncertain");
    expect(renderStatusHistory(input)).not.toContain("No changes");
  });
});
