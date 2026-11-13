import type {
  StatusCount,
  StatusCounts,
  StatusMetric,
  StatusPullRequest,
  StatusReport,
  StatusView,
} from "./status.js";

type Tone = "muted" | "conflict" | "changes" | "unknown" | "approved";
type Cell = { text: string; tone?: Tone; numeric?: boolean };
type Entry = { repo: string; label: string; cells: Cell[]; counts: StatusCounts; total?: boolean };

const reviewColumns: Array<[StatusMetric, string]> = [
  ["open", "Open"],
  ["reviewRequired", "Review"],
  ["changesRequested", "Changes"],
  ["approved", "Approved"],
  ["notRequired", "None"],
  ["reviewUnknown", "Unknown"],
  ["conflicts", "Conflicts"],
];
const flagColumns: Array<[StatusMetric, string]> = [
  ["drafts", "Drafts"],
  ["unassigned", "Unassigned"],
  ["mergeUnknown", "Merge unknown"],
];
const ansiEscape = String.fromCharCode(27);
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

export function safeStatusText(value: string): string {
  let result = "";
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    let command = code;
    if (code === 27) command = value.charCodeAt(++i);
    if (
      (code === 27 && [93, 80, 88, 94, 95].includes(command)) ||
      [144, 152, 157, 158, 159].includes(code)
    ) {
      while (++i < value.length) {
        if (value.charCodeAt(i) === 7 || value.charCodeAt(i) === 156) break;
        if (value.charCodeAt(i) === 27 && value[i + 1] === "\\") {
          i++;
          break;
        }
      }
      continue;
    }
    if ((code === 27 && command === 91) || code === 155) {
      while (++i < value.length) {
        const part = value.charCodeAt(i);
        if (part >= 64 && part <= 126) break;
      }
      continue;
    }
    if (code === 27) {
      while (i < value.length && value.charCodeAt(i) >= 32 && value.charCodeAt(i) <= 47) i++;
      continue;
    }
    if ([9, 10, 11, 12, 13, 133, 8232, 8233].includes(code)) result += " ";
    else if (code >= 32 && !(code >= 127 && code <= 159)) result += value[i];
  }
  return result.replace(/[\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "").trim();
}

function markdownText(value: string): string {
  return safeStatusText(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*_[\]{}()#+.!|~-]/g, "\\$&");
}

function markdownCode(value: string): string {
  const content = safeStatusText(value);
  const length = [...content.matchAll(/`+/g)].reduce(
    (max, match) => Math.max(max, match[0].length),
    0,
  );
  const fence = "`".repeat(length + 1);
  return `${fence} ${content} ${fence}`;
}

function evidenceLink(pr: StatusPullRequest): string {
  const url = safeStatusText(pr.url);
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return markdownText(url);
    const target = url.replace(
      /[\s<>\\()[\]`"'|{}]/g,
      (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    return `[${markdownText(url)}](${target})`;
  } catch {
    return markdownText(url);
  }
}

function measure(value: string): number {
  let width = 0;
  for (const { segment } of graphemes.segment(value)) {
    if (/^(?:\p{Mark}|\u200d|\ufe0e|\ufe0f)+$/u.test(segment)) continue;
    width +=
      /\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff01-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]|\ufe0f/u.test(
        segment,
      )
        ? 2
        : 1;
  }
  return width;
}

function wrap(value: string, width: number, words = false): string[] {
  if (measure(value) <= width) return [value];
  const lines: string[] = [];
  let line = "";
  let size = 0;
  for (const { segment } of graphemes.segment(value)) {
    const next = measure(segment);
    if (size + next > width && line) {
      const boundary = words ? line.lastIndexOf(" ") + 1 : 0;
      lines.push(boundary ? line.slice(0, boundary) : line);
      line = boundary ? line.slice(boundary) : "";
      size = measure(line);
    }
    line += segment;
    size += next;
  }
  if (line) lines.push(line);
  return lines;
}

export { measure as textWidth, wrap as wrapText };

function countCell(count: StatusCount, metric?: StatusMetric): Cell {
  if (count.count === null) return { text: "?", tone: "unknown", numeric: true };
  const tone =
    count.count === 0
      ? "muted"
      : metric === "conflicts"
        ? "conflict"
        : metric === "changesRequested"
          ? "changes"
          : metric === "reviewUnknown" || metric === "mergeUnknown"
            ? "unknown"
            : metric === "approved"
              ? "approved"
              : undefined;
  return { text: String(count.count), tone, numeric: true };
}

function countDetail(count: StatusCount): string {
  if (count.count !== null) return String(count.count);
  return `? (at least ${count.prIds.length} known${count.unknownIds.length ? `; ${count.unknownIds.length} unknown PRs` : ""})`;
}

function graphCommand(pr: StatusPullRequest): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(pr.repo)) return null;
  if (!Number.isSafeInteger(pr.number) || pr.number < 1) return null;
  return `issue-graph ${pr.number} --repo ${pr.repo} --depth 1 --no-snapshot`;
}

export function formatStatusCapture(start: string, end: string): string {
  const parse = (value: string) => {
    const time = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
      ? Date.parse(value)
      : NaN;
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === value.slice(0, 19)
      ? time
      : NaN;
  };
  const from = parse(start);
  const to = parse(end);
  const captured = Number.isFinite(to)
    ? `${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(to)} at ${new Date(to).toISOString().slice(11, 16)} UTC`
    : "unknown";
  const elapsed = to - from;
  const duration =
    Number.isFinite(elapsed) && elapsed >= 0
      ? elapsed > 0 && elapsed < 100
        ? "<0.1s"
        : `${(elapsed / 1000).toFixed(1)}s`
      : "unknown";
  return `Captured ${captured} · Query ${duration}`;
}

export function renderStatus(
  report: StatusReport,
  options: {
    view?: StatusView;
    format?: "table" | "markdown";
    color?: boolean;
    width?: number;
  } = {},
): string {
  const view = options.view ?? "authors";
  const markdown = options.format === "markdown";
  const color = options.color === true && !markdown;
  const requestedWidth = Number.isFinite(options.width)
    ? Math.max(2, Math.floor(options.width as number))
    : 120;
  const width = !markdown && view !== "prs" ? Math.min(100, requestedWidth) : requestedWidth;
  const text = markdown ? markdownText : safeStatusText;
  const out: string[] = [];
  const paint = (value: string, tone?: Tone) =>
    color && tone ? `${ansiEscape}[${tone === "muted" ? 2 : 1}m${value}${ansiEscape}[0m` : value;
  const line = (value = "", tone?: Tone) => {
    if (markdown) {
      out.push(value && !/^(## |\| |- )/.test(value) ? `${value}  ` : value);
      return;
    }
    for (const part of wrap(value, width, view !== "prs")) out.push(paint(part, tone));
  };
  const heading = (value: string) => line(markdown ? `## ${value}` : value, "approved");
  const detail = (label: string, value: string) =>
    line(`${markdown ? "- " : "  "}${label}: ${text(value)}`, "muted");
  const metrics = (counts: StatusCounts, columns: Array<[StatusMetric, string]>) =>
    columns.map(([metric, label]) => `${label} ${countDetail(counts[metric])}`).join(" · ");
  const repoNames = [
    ...new Set([
      ...report.scope.repos,
      ...report.coverage.map((item) => item.repo),
      ...report.rows.map((item) => item.repo),
      ...report.projects.map((item) => item.repo),
      ...report.pullRequests.map((item) => item.repo),
    ]),
  ];
  const owners = new Set(repoNames.map((repo) => repo.split("/")[0]));
  const owner =
    owners.size === 1 && repoNames.every((repo) => repo.split("/").length === 2)
      ? repoNames[0].split("/")[0]
      : null;
  const repoLabel = (repo: string) =>
    safeStatusText(!markdown && owner ? repo.slice(repo.indexOf("/") + 1) : repo);

  if (markdown || view === "prs") {
    heading(
      `issue-graph status${owner ? ` · Owner: ${text(owner)}` : ""} · ${report.scope.repos.length} repos · Authors: ${report.scope.authors.map(text).join(", ")}`,
    );
    line(
      `Query window: ${text(report.startedAt)} → ${text(report.generatedAt)} · Coverage: ${report.coverageComplete ? "complete" : "INCOMPLETE"}`,
      report.coverageComplete ? undefined : "unknown",
    );
  } else {
    heading("issue-graph status");
    const capture = formatStatusCapture(report.startedAt, report.generatedAt);
    line(
      `${capture} · Coverage ${report.coverageComplete ? "complete" : "INCOMPLETE"}`,
      report.coverageComplete && !capture.includes("unknown") ? "muted" : "unknown",
    );
  }
  const headerMetrics: Array<[StatusMetric, string]> = [
    ["open", "Open"],
    ["drafts", "Drafts"],
    ["unassigned", "Unassigned"],
  ];
  if (report.totals.mergeUnknown.count !== 0) headerMetrics.push(["mergeUnknown", "Merge unknown"]);
  if (markdown || view === "prs")
    line(
      `Totals: ${headerMetrics
        .map(([metric, label]) => {
          const count = report.totals[metric];
          const value =
            report.coverageComplete && count.count === null
              ? `? (≥${count.prIds.length} known)`
              : countDetail(count);
          return `${label} ${value}`;
        })
        .join(" · ")}`,
    );
  if (!report.coverageComplete) {
    for (const coverage of report.coverage) {
      line(
        `  ${text(coverage.repo)}: ${coverage.complete ? "complete" : "INCOMPLETE"} · ${coverage.pages} pages · ${coverage.scanned} scanned`,
        coverage.complete ? undefined : "unknown",
      );
      for (const error of coverage.errors) detail(text(error.code), error.message);
    }
  }
  line();

  const table = (headers: string[], entries: Entry[]) => {
    if (markdown) {
      line(`| ${headers.map(text).join(" | ")} |`);
      line(`| ${headers.map(() => "---").join(" | ")} |`);
      for (const entry of entries)
        line(`| ${entry.cells.map((cell) => text(cell.text)).join(" | ")} |`);
      return;
    }
    const actual = entries.filter((entry) => !entry.total);
    const metricStart = headers.length - reviewColumns.length;
    const smallTable = (label: string, countLabel: string, rows: Array<[string, Cell]>) => {
      const numberWidth = Math.max(
        measure(countLabel),
        ...rows.map(([, cell]) => measure(cell.text)),
      );
      if (width <= numberWidth + 3) {
        const lines = wrap(`${label} / ${countLabel}`, width).map((part) =>
          paint(part, "approved"),
        );
        for (const [name, cell] of rows)
          lines.push(
            ...wrap(`${name}: ${cell.text}`, width).map((part) =>
              paint(part, cell.text === "0" ? "muted" : "approved"),
            ),
          );
        return { width, lines };
      }
      const labelWidth = Math.min(
        width - numberWidth - 2,
        Math.max(measure(label), ...rows.map(([name]) => measure(name))),
      );
      const tableWidth = labelWidth + 2 + numberWidth;
      const lines: string[] = [];
      const emit = (name: string, value: string, header = false) => {
        wrap(name, labelWidth, true).forEach((part, index) => {
          const number = index === 0 ? value : "";
          const left = part + " ".repeat(labelWidth - measure(part));
          const right = " ".repeat(numberWidth - measure(number)) + number;
          lines.push(
            paint(left, header ? "approved" : value === "0" ? "muted" : undefined) +
              "  " +
              paint(right, header ? "approved" : value === "0" ? "muted" : "approved"),
          );
        });
      };
      emit(label, countLabel, true);
      for (const [name, cell] of rows) emit(name, cell.text);
      return { width: tableWidth, lines };
    };
    const groups = new Map<string, Entry[]>();
    for (const entry of entries) {
      if (
        entry.total &&
        actual.length === 1 &&
        [...reviewColumns, ...flagColumns].every(
          ([metric]) =>
            entry.counts[metric].count !== null &&
            entry.counts[metric].count === actual[0].counts[metric].count,
        )
      )
        continue;
      const key = entry.total ? "" : entry.repo;
      const group = groups.get(key) ?? [];
      group.push(entry);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      const first = group[0];
      const byAuthor = headers[1] === "Author" && !first.total;
      const open = first.cells[metricStart].text;
      const scope = first.total ? "Total" : safeStatusText(first.repo);
      heading(group.length === 1 ? `${scope} · ${open} open PR${open === "1" ? "" : "s"}` : scope);
      const authorRows: Array<[string, Cell]> = first.total
        ? []
        : byAuthor
          ? group.map((entry): [string, Cell] => [entry.cells[1].text, entry.cells[metricStart]])
          : first.cells
              .slice(1, metricStart)
              .map((cell, index): [string, Cell] => [
                headers[index + 1].replace(/ \(open\)$/, ""),
                cell,
              ]);
      const authors = authorRows.length ? smallTable("Author", "Open PRs", authorRows) : null;
      const reviewTables = group.map((entry) => {
        const metricCell = (metric: StatusMetric) =>
          entry.cells[metricStart + reviewColumns.findIndex(([key]) => key === metric)];
        return smallTable(
          byAuthor ? `Review state · ${entry.cells[1].text}` : "Review state",
          "PRs",
          [
            ["Needs review", metricCell("reviewRequired")],
            ["Approved", metricCell("approved")],
            ["Changes requested", metricCell("changesRequested")],
            ["Not required", metricCell("notRequired")],
            ["Unknown", metricCell("reviewUnknown")],
          ],
        );
      });
      const reviewLines = reviewTables.flatMap((review, index) =>
        index ? ["", ...review.lines] : review.lines,
      );
      const reviewWidth = Math.max(...reviewTables.map((review) => review.width));
      if (authors && authors.width + reviewWidth + 4 <= width) {
        for (let index = 0; index < Math.max(authors.lines.length, reviewLines.length); index++)
          out.push(
            `${authors.lines[index] ?? " ".repeat(authors.width)}    ${reviewLines[index] ?? ""}`,
          );
      } else {
        if (authors) {
          out.push(...authors.lines);
          line();
        }
        out.push(...reviewLines);
      }
      for (const entry of group) {
        const label = byAuthor ? `Flags (${entry.cells[1].text})` : "Flags";
        const flags = `${label}: ${metrics(entry.counts, [
          ["drafts", "Drafts"],
          ["conflicts", "Conflicts"],
          ["unassigned", "Unassigned"],
          ["mergeUnknown", "Merge unknown"],
        ])}`;
        for (const part of wrap(flags, width, true))
          out.push(
            part.replace(/\b\d+\b|\?/g, (value) =>
              paint(value, value === "0" ? "muted" : "approved"),
            ),
          );
      }
      line();
    }
  };

  if (view === "prs") {
    heading("PR ledger");
    if (!report.pullRequests.length)
      line(
        report.coverageComplete
          ? "No open PRs in scope."
          : "No PRs observed; incomplete coverage is not an empty backlog.",
      );
    for (const pr of report.pullRequests) {
      const state =
        pr.reviewState === "required"
          ? "review required"
          : pr.reviewState === "not-required"
            ? "not required"
            : pr.reviewState === "changes-requested"
              ? "changes requested"
              : pr.reviewState;
      const conflict =
        pr.mergeability === "UNKNOWN" ? "?" : pr.mergeability === "CONFLICTING" ? "yes" : "no";
      line();
      heading(text(`${pr.repo}#${pr.number}`));
      line(
        `  Author: ${text(pr.author)} · State: open · Review: ${text(state)}`,
        state === "changes requested" ? "changes" : state === "unknown" ? "unknown" : undefined,
      );
      line(
        `  Draft: ${pr.isDraft === null ? "?" : pr.isDraft ? "yes" : "no"} · Conflict: ${conflict}`,
        conflict === "yes" ? "conflict" : conflict === "?" ? "unknown" : undefined,
      );
      detail("Title", pr.title);
      if (markdown) line(`- URL: ${evidenceLink(pr)}`);
      else detail("URL", pr.url);
      detail("ID", pr.id);
      detail(
        "Assignees",
        pr.assignees === null ? "?" : pr.assignees.join(", ") || "none (unassigned)",
      );
      detail(
        "Review requests",
        pr.requestedReviewers === null ? "?" : pr.requestedReviewers.join(", ") || "none",
      );
      detail("Head", pr.headSha ?? "?");
      detail("Updated", pr.updatedAt ?? "?");
      const command = graphCommand(pr);
      if (markdown && command) line(`- Graph: ${markdownCode(command)}`);
      else detail("Graph", command ?? "Unavailable: invalid PR identity");
    }
  } else {
    const projects = view === "projects";
    if (markdown) heading(projects ? "Projects" : "Repository × author");
    const authors = [
      ...new Set([
        ...report.scope.authors,
        ...report.projects.flatMap((project) => project.authors.map(({ author }) => author)),
      ]),
    ];
    const entries: Entry[] = projects
      ? report.projects.map((project) => ({
          repo: project.repo,
          label: project.repo,
          counts: project.counts,
          cells: [
            { text: repoLabel(project.repo) },
            ...authors.map((author) => {
              const count = project.authors.find((item) => item.author === author)?.count;
              return count
                ? countCell(count)
                : { text: "?", tone: "unknown" as const, numeric: true };
            }),
            ...reviewColumns.map(([metric]) => countCell(project.counts[metric], metric)),
          ],
        }))
      : report.rows.map((row) => ({
          repo: row.repo,
          label: `${row.repo} / ${row.author}`,
          counts: row.counts,
          cells: [
            { text: repoLabel(row.repo) },
            { text: safeStatusText(row.author) },
            ...reviewColumns.map(([metric]) => countCell(row.counts[metric], metric)),
          ],
        }));
    entries.push({
      repo: "",
      label: "Total",
      total: true,
      counts: report.totals,
      cells: [
        { text: "Total" },
        ...(projects ? authors : ["Author"]).map(() => ({ text: "" })),
        ...reviewColumns.map(([metric]) => countCell(report.totals[metric], metric)),
      ],
    });
    table(
      [
        projects ? "Project" : "Repo",
        ...(projects ? authors.map((author) => `${safeStatusText(author)} (open)`) : ["Author"]),
        ...reviewColumns.map(([, label]) => label),
      ],
      entries,
    );
    const items = projects
      ? report.projects.map((project) => ({ label: project.repo, counts: project.counts }))
      : report.rows.map((row) => ({ label: `${row.repo} / ${row.author}`, counts: row.counts }));
    items.push({ label: "Total", counts: report.totals });
    const unknownCounts = items.some(({ counts }) =>
      [...reviewColumns, ...flagColumns].some(([metric]) => counts[metric].count === null),
    );
    const unknownAuthors =
      projects &&
      report.projects.some((project) => project.authors.some(({ count }) => count.count === null));
    if (!report.coverageComplete || (!markdown && (unknownCounts || unknownAuthors))) {
      line();
      heading(report.coverageComplete ? "Unknown count details" : "Incomplete count details");
      for (const item of items) {
        if (
          ![...reviewColumns, ...flagColumns].some(([metric]) => item.counts[metric].count === null)
        )
          continue;
        line(`${text(item.label)}: ${metrics(item.counts, flagColumns)}`);
        for (const [metric, label] of reviewColumns) {
          if (item.counts[metric].count === null)
            line(`  ${label}: ${countDetail(item.counts[metric])}`, "unknown");
        }
      }
      if (projects) {
        for (const project of report.projects) {
          for (const author of project.authors) {
            if (author.count.count === null)
              detail(text(`${project.repo} / ${author.author} Open`), countDetail(author.count));
          }
        }
      }
    }
  }
  line();
  line(
    markdown || view === "prs"
      ? "Review=required; None=not required; Unknown=review unknown; ?=unknown, not zero."
      : "? means unknown, not zero.",
  );
  line("Flags overlap review states. Approval does not imply merge readiness.");
  const scope = report.scope;
  const validScope =
    scope.repos.length > 0 &&
    scope.authors.length > 0 &&
    scope.repos.every((repo) => /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(repo)) &&
    scope.authors.every((author) => /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(author));
  const defaults = new Set(
    scope.repos.map(
      (repo) => `issue-graph status --repo ${repo} --author ${scope.authors.join(",")} --view prs`,
    ),
  );
  const steps =
    view !== "prs" && validScope
      ? [
          `issue-graph status ${scope.repos.map((repo) => `--repo ${repo}`).join(" ")} --author ${scope.authors.join(",")} --view prs`,
          ...report.nextSteps.filter((step) => !defaults.has(step)),
        ]
      : report.nextSteps;
  for (const step of [...new Set(steps)]) {
    if (markdown) line(`- ${markdownCode(step)}`);
    else if (view === "prs") line(`  ${safeStatusText(step)}`);
    else out.push(wrap(safeStatusText(step), Math.max(1, width - 1), true).join("\\\n"));
  }
  return `${out.join("\n")}\n`;
}
