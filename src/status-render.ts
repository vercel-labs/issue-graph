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
type Entry = { repo: string; label: string; cells: Cell[]; total?: boolean };

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
const palette: Record<Tone, number> = {
  muted: 244,
  conflict: 203,
  changes: 214,
  unknown: 179,
  approved: 114,
};
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
  const width = Number.isFinite(options.width)
    ? Math.max(2, Math.floor(options.width as number))
    : 120;
  const text = markdown ? markdownText : safeStatusText;
  const out: string[] = [];
  const paint = (value: string, tone?: Tone) =>
    color && tone ? `${ansiEscape}[38;5;${palette[tone]}m${value}${ansiEscape}[0m` : value;
  const line = (value = "", tone?: Tone) => {
    if (markdown) {
      out.push(value && !/^(## |\| |- )/.test(value) ? `${value}  ` : value);
      return;
    }
    for (const part of wrap(value, width)) out.push(paint(part, tone));
  };
  const heading = (value: string) => line(markdown ? `## ${value}` : value);
  const detail = (label: string, value: string) =>
    line(`${markdown ? "- " : "  "}${label}: ${text(value)}`);
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

  heading(
    `issue-graph status${owner ? ` · Owner: ${text(owner)}` : ""} · ${report.scope.repos.length} repos · Authors: ${report.scope.authors.map(text).join(", ")}`,
  );
  line(
    `Query window: ${text(report.startedAt)} → ${text(report.generatedAt)} · Coverage: ${report.coverageComplete ? "complete" : "INCOMPLETE"}`,
    report.coverageComplete ? undefined : "unknown",
  );
  const headerMetrics: Array<[StatusMetric, string]> = [
    ["open", "Open"],
    ["drafts", "Drafts"],
    ["unassigned", "Unassigned"],
  ];
  if (report.totals.mergeUnknown.count !== 0) headerMetrics.push(["mergeUnknown", "Merge unknown"]);
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
    const widths = headers.map((header, index) =>
      Math.max(measure(header), ...entries.map((entry) => measure(entry.cells[index].text))),
    );
    const contentWidth = widths.reduce((sum, size) => sum + size, 0) + 3;
    const normalGaps = headers.length - 2;
    const gap = contentWidth + normalGaps * 2 <= width ? "  " : " ";
    if (contentWidth + normalGaps * gap.length > width) {
      for (const entry of entries) {
        heading(safeStatusText(entry.label));
        entry.cells.forEach((cell, index) => {
          line(`  ${headers[index]}: ${cell.text}`, cell.tone);
        });
        line();
      }
      return;
    }
    const row = (cells: Cell[]) =>
      cells
        .map((cell, index) => {
          const padding = " ".repeat(widths[index] - measure(cell.text));
          const padded = cell.numeric ? padding + cell.text : cell.text + padding;
          const separator = index === 0 ? "" : index === cells.length - 1 ? " │ " : gap;
          return separator + paint(padded, cell.tone);
        })
        .join("");
    const rule = widths
      .map(
        (size, index) =>
          `${index === 0 ? "" : index === widths.length - 1 ? "─┼─" : gap}${"─".repeat(size)}`,
      )
      .join("");
    out.push(row(headers.map((header) => ({ text: header }))));
    out.push(rule);
    let previousRepo: string | undefined;
    for (const entry of entries) {
      if (entry.total) out.push(rule);
      else if (previousRepo !== undefined && previousRepo !== entry.repo) out.push("");
      const cells = entry.cells.map((cell) => ({ ...cell }));
      if (!entry.total && entry.repo === previousRepo) cells[0].text = "";
      out.push(row(cells));
      previousRepo = entry.repo;
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
    heading(projects ? "Projects" : "Repository × author");
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
    if (!report.coverageComplete) {
      line();
      heading("Incomplete count details");
      const items = projects
        ? report.projects.map((project) => ({ label: project.repo, counts: project.counts }))
        : report.rows.map((row) => ({ label: `${row.repo} / ${row.author}`, counts: row.counts }));
      items.push({ label: "Total", counts: report.totals });
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
  line("Review=required; None=not required; Unknown=review unknown; ?=unknown, not zero.");
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
