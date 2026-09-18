import { STATUS_METRICS, type StatusMetric } from "./status.js";
import type {
  StatusChangeValue,
  StatusHistory,
  StatusMetricDeltas,
} from "./status-history-types.js";
import { safeStatusText } from "./status-render.js";

const labels: Record<StatusMetric, string> = {
  open: "Open",
  reviewRequired: "Review required",
  changesRequested: "Changes requested",
  approved: "Approved",
  notRequired: "Not required",
  reviewUnknown: "Review unknown",
  drafts: "Drafts",
  conflicts: "Conflicts",
  mergeUnknown: "Merge unknown",
  unassigned: "Unassigned",
};
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });
const size = (segment: string) =>
  /^(?:\p{Mark}|\u200d|\ufe0e|\ufe0f)+$/u.test(segment)
    ? 0
    : /\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff01-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]|\ufe0f/u.test(
          segment,
        )
      ? 2
      : 1;
const measure = (value: string) =>
  [...graphemes.segment(value)].reduce((total, { segment }) => total + size(segment), 0);

function wrap(value: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  let used = 0;
  for (const { segment } of graphemes.segment(value)) {
    const next = size(segment);
    if (used + next > width && line) {
      lines.push(line);
      line = "";
      used = 0;
    }
    line += segment;
    used += next;
  }
  lines.push(line);
  return lines;
}

function markdownText(value: string): string {
  return safeStatusText(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*_[\]{}()#+.!|~-]/g, "\\$&");
}

const display = (value: StatusChangeValue): string =>
  Array.isArray(value) ? (value.length ? value.join(", ") : "(none)") : String(value);

export function renderStatusHistory(
  history: StatusHistory,
  options: { format?: "table" | "markdown"; width?: number } = {},
): string {
  const markdown = options.format === "markdown";
  const width = Number.isFinite(options.width)
    ? Math.max(2, Math.floor(options.width as number))
    : 120;
  const text = markdown ? markdownText : safeStatusText;
  const out: string[] = [];
  const line = (value = "") => {
    out.push(...(markdown ? [value] : wrap(value, width)));
  };
  line(markdown ? "## Changes" : "Changes");
  line(`Baseline: ${text(history.previousGeneratedAt)} → ${text(history.currentGeneratedAt)}`);
  line(`Compared at: ${text(history.comparedAt)}`);
  line(
    `Baseline provenance: ${text(history.previousProvenance.kind)} · ${text(history.previousProvenance.note)}`,
  );
  if (history.previousProvenance.sources.length)
    line(`Sources: ${history.previousProvenance.sources.map(text).join("; ")}`);
  const complete =
    history.coverageComplete &&
    history.uncertain.length === 0 &&
    history.departures.every((item) => item.state !== "UNVERIFIED") &&
    [history.totals, ...history.rows.map((row) => row.counts)].every(
      (counts) =>
        STATUS_METRICS.every((metric) => counts[metric].delta !== null) &&
        ["reviewUnknown", "mergeUnknown"].every((metric) => {
          const count = counts[metric as StatusMetric];
          return count.before === 0 && count.after === 0;
        }),
    );
  line(
    `Coverage: ${complete ? "complete" : "INCOMPLETE; unknown observations or capture gaps remain"}`,
  );
  const metricText = (counts: StatusMetricDeltas, metric: StatusMetric) => {
    const count = counts[metric];
    const delta =
      count.delta === null ? "?" : count.delta > 0 ? `+${count.delta}` : String(count.delta);
    return `${labels[metric]} ${count.before ?? "?"} → ${count.after ?? "?"} (${delta})`;
  };
  line(
    `Delta totals: ${STATUS_METRICS.map((metric) => metricText(history.totals, metric)).join(" · ")}`,
  );
  const deltaRows = history.rows
    .map((row) => ({
      ...row,
      metrics: STATUS_METRICS.filter(
        (metric) => row.counts[metric].delta !== null && row.counts[metric].delta !== 0,
      ),
    }))
    .filter((row) => row.metrics.length)
    .sort((a, b) => compare(a.repo, b.repo) || compare(a.author, b.author));
  if (deltaRows.length) {
    line("Delta rows:");
    for (const row of deltaRows)
      line(
        `${text(row.repo)} · ${text(row.author)}: ${row.metrics.map((metric) => metricText(row.counts, metric)).join(" · ")}`,
      );
  }
  const rows: Array<{ id: string; field: string; before: string; after: string }> = [];
  for (const change of history.changes)
    rows.push({
      id: change.id,
      field: change.field,
      before: display(change.before),
      after: display(change.after),
    });
  for (const pr of history.added)
    rows.push({
      id: pr.id,
      field: "newly in scope",
      before: "not in baseline scope",
      after: "OPEN",
    });
  for (const departure of history.departures) {
    if (departure.state === "UNVERIFIED") {
      if (!history.uncertain.some((item) => item.id === departure.id))
        rows.push({
          id: departure.id,
          field: "uncertain",
          before: "OPEN",
          after: departure.reason ?? "Terminal state unverified",
        });
    } else {
      const at = departure.state === "MERGED" ? departure.mergedAt : departure.closedAt;
      rows.push({
        id: departure.id,
        field: departure.state.toLowerCase(),
        before: "OPEN",
        after: `${departure.state}${at ? ` at ${at}` : ""}`,
      });
    }
  }
  for (const item of history.uncertain)
    rows.push({ id: item.id, field: "uncertain", before: "?", after: item.reason });
  rows.sort(
    (a, b) => compare(a.id, b.id) || compare(a.field, b.field) || compare(a.after, b.after),
  );
  if (!rows.length && !deltaRows.length) {
    if (complete && STATUS_METRICS.every((metric) => history.totals[metric].delta === 0))
      line("No changes.");
    else line("Comparison is incomplete; changes cannot be ruled out.");
  }
  if (!rows.length) return out.join("\n");
  line();
  const headers = ["PR", "Field", "Before", "After"];
  let cells = rows.map((row) => [row.id, row.field, row.before, row.after].map(text));
  if (markdown) {
    line(`| ${headers.join(" | ")} |`);
    line("| --- | --- | --- | --- |");
    for (const row of cells) line(`| ${row.join(" | ")} |`);
  } else {
    const measureColumns = (values: string[][]) =>
      headers.map((header, index) =>
        Math.max(measure(header), ...values.map((row) => measure(row[index]))),
      );
    let widths = measureColumns(cells);
    if (widths.reduce((total, value) => total + value, 0) + 9 > width) {
      const owners = new Set(rows.map((row) => row.id.split("/")[0]));
      const fieldLabels: Record<string, string> = {
        mergeability: "Mergeability",
        requestedReviewers: "Reviewers",
        reviewState: "Review",
        isDraft: "Draft",
        headSha: "Head",
        assignees: "Assignees",
        merged: "State",
        closed: "State",
        "newly in scope": "Membership",
      };
      if (owners.size === 1 && rows.every((row) => /^[^/]+\/[^/]+#\d+$/.test(row.id))) {
        const compact = rows.map((row) =>
          [
            row.id.slice(row.id.indexOf("/") + 1),
            fieldLabels[row.field] ?? row.field,
            row.field === "newly in scope" ? "Absent" : row.before,
            row.after,
          ].map(text),
        );
        const compactWidths = measureColumns(compact);
        if (compactWidths.reduce((total, value) => total + value, 0) + 9 <= width) {
          line(`PR owner: ${text([...owners][0])}`);
          cells = compact;
          widths = compactWidths;
        }
      }
    }
    if (widths.reduce((total, value) => total + value, 0) + 9 <= width) {
      const rowLine = (row: string[]) =>
        line(
          row
            .map((cell, index) => cell + " ".repeat(widths[index] - measure(cell)))
            .join(" | ")
            .trimEnd(),
        );
      rowLine(headers);
      line(widths.map((value) => "-".repeat(value)).join("-+-"));
      for (const row of cells) rowLine(row);
    } else {
      for (const row of cells) {
        line(`${headers[0]}: ${row[0]}`);
        for (let i = 1; i < headers.length; i++) line(`  ${headers[i]}: ${row[i]}`);
      }
    }
  }
  return out.join("\n");
}
