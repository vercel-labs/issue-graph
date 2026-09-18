import {
  collectStatus,
  normalizeStatusScope,
  type StatusFormat,
  type StatusOptions,
  type StatusView,
} from "./status.js";
import { inspectStatusHistory } from "./status-history.js";
import { renderStatusHistory } from "./status-history-render.js";
import type { StatusHistoryOutput, StatusSnapshot } from "./status-history-types.js";
import { renderStatus, safeStatusText } from "./status-render.js";
import { toStatusSnapshot } from "./status-snapshot.js";
import { latestStatusSnapshot, readStatusSnapshot, writeStatusSnapshot } from "./status-store.js";
import type { GhTransport } from "./transport.js";

export const STATUS_USAGE = `usage: issue-graph status --repo owner/repo --author login[,login] [options]

Count open PRs by repository and author without a graph crawl. Local writes are opt-in.

  --repo owner/repo       repeat for each repository (required)
  --author login[,login]  repeat or comma-separate authors (required)
  --view VIEW            authors (default), projects, or prs
  --format FORMAT        auto (default), table, markdown, or json
  --json                 JSON on stdout; no filename (status only)
  --concurrency N        repositories in flight, 1..32 (default 4)
  --max-pages N          pages per connection, 1..1000 (default 100)
  --save                 save an immutable capture under ISSUE_GRAPH_HOME (default ~/.issue-graph)
  --since last|PATH      compare with a matching-scope snapshot or exported JSON
  --no-snapshot          forbid snapshot writes; incompatible with --save
  -h, --help             show this help

Auto output: terminal table for TTY, JSON for pipes. NO_COLOR disables color.
Exit 0: complete inventory; 1: incomplete/runtime failure; 2: invalid arguments.
Unknown counts are ?, not 0. Conflicts and drafts overlap review states.

Examples:
  issue-graph status --repo vercel-labs/agent-browser --author ctate,Railly
  issue-graph status --repo vercel-labs/wterm --author ctate --view prs
  issue-graph status --repo vercel-labs/emulate --author ctate --json
  issue-graph status --repo vercel-labs/agent-browser --author ctate,Railly --save
  issue-graph status --repo vercel-labs/agent-browser --author ctate,Railly --since last --save`;

export class StatusUsageError extends Error {}

export interface StatusArgs extends StatusOptions {
  view: StatusView;
  format: StatusFormat;
  help: boolean;
  save: boolean;
  since: string | null;
  noSnapshot: boolean;
}

export function parseStatusArgs(argv: string[]): StatusArgs {
  const args: StatusArgs = {
    repos: [],
    authors: [],
    concurrency: 4,
    maxPages: 100,
    view: "authors",
    format: "auto",
    help: false,
    save: false,
    since: null,
    noSnapshot: false,
  };
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const next = argv[++i];
      if (!next || next.startsWith("-")) throw new StatusUsageError(`${flag} needs a value`);
      return next;
    };
    if (flag === "--help" || flag === "-h") args.help = true;
    else if (flag === "--repo") args.repos.push(value());
    else if (flag === "--author")
      args.authors.push(
        ...value()
          .split(",")
          .map((author) => author.trim()),
      );
    else if (flag === "--json") json = true;
    else if (flag === "--no-snapshot") args.noSnapshot = true;
    else if (flag === "--save") args.save = true;
    else if (flag === "--since") args.since = value();
    else if (flag === "--view") {
      const view = value();
      if (view !== "authors" && view !== "projects" && view !== "prs")
        throw new StatusUsageError(`unknown view: ${view}`);
      args.view = view;
    } else if (flag === "--format") {
      const format = value();
      if (format !== "auto" && format !== "table" && format !== "markdown" && format !== "json")
        throw new StatusUsageError(`unknown format: ${format}`);
      args.format = format;
    } else if (flag === "--concurrency") args.concurrency = Number(value());
    else if (flag === "--max-pages") args.maxPages = Number(value());
    else throw new StatusUsageError(`unexpected argument: ${flag}\n\n${STATUS_USAGE}`);
  }
  if (
    !Number.isInteger(args.concurrency) ||
    (args.concurrency ?? 0) < 1 ||
    (args.concurrency ?? 0) > 32
  )
    throw new StatusUsageError("--concurrency must be an integer from 1 to 32");
  if (!Number.isInteger(args.maxPages) || (args.maxPages ?? 0) < 1 || (args.maxPages ?? 0) > 1000)
    throw new StatusUsageError("--max-pages must be an integer from 1 to 1000");
  if (json && args.format !== "auto" && args.format !== "json")
    throw new StatusUsageError("--json conflicts with --format table or markdown");
  if (json) args.format = "json";
  if (args.save && args.noSnapshot)
    throw new StatusUsageError("--save conflicts with --no-snapshot");
  if (!args.help) {
    try {
      Object.assign(args, normalizeStatusScope(args.repos, args.authors));
    } catch (error) {
      throw new StatusUsageError(error instanceof Error ? error.message : "Invalid status scope");
    }
  }
  return args;
}

export interface StatusIO {
  isTTY: boolean;
  noColor?: boolean;
  ci?: boolean;
  width?: number;
  snapshotHome?: string;
  stdout: (value: string) => void;
  stderr: (value: string) => void;
}

export async function runStatus(
  argv: string[],
  transport: GhTransport,
  io: StatusIO,
): Promise<number> {
  const args = parseStatusArgs(argv);
  if (args.help) {
    io.stdout(`${STATUS_USAGE}\n`);
    return 0;
  }
  let previous: StatusSnapshot | null = null;
  if (args.since) {
    if (args.since === "last") {
      const saved = latestStatusSnapshot(
        { repos: args.repos, authors: args.authors },
        io.snapshotHome,
      );
      if (!saved)
        throw new Error(
          `No prior status snapshot for this scope. First run: issue-graph status ${args.repos.map((repo) => `--repo ${repo}`).join(" ")} --author ${args.authors.join(",")} --save`,
        );
      previous = saved.snapshot;
    } else previous = readStatusSnapshot(args.since);
    const scopeKey = (scope: { repos: string[]; authors: string[] }) => {
      const normalized = normalizeStatusScope(scope.repos, scope.authors);
      return JSON.stringify({
        repos: normalized.repos.map((value) => value.toLowerCase()),
        authors: normalized.authors.map((value) => value.toLowerCase()),
      });
    };
    if (scopeKey(previous.scope) !== scopeKey({ repos: args.repos, authors: args.authors }))
      throw new StatusUsageError(
        "Status history scope mismatch: use the same repositories and authors as the baseline.",
      );
    if (Date.parse(previous.generatedAt) > Date.now())
      throw new StatusUsageError(
        "Status history baseline is in the future; cannot compare it with a current capture.",
      );
  }
  const format = args.format === "auto" ? (io.isTTY ? "table" : "json") : args.format;
  const humanTTY = io.isTTY && format !== "json";
  if (humanTTY)
    io.stderr(`issue-graph status · read-only inventory · ${args.repos.length} repos\n`);
  const report = await collectStatus(transport, {
    ...args,
    onProgress: humanTTY
      ? (event) =>
          io.stderr(
            `  ${safeStatusText(event.repo)}: ${event.scanned} PRs scanned, ${event.pages} pages${event.complete ? " (last page)" : ""}\n`,
          )
      : undefined,
  });
  const extra: StatusHistoryOutput = {};
  if (previous)
    extra.history = await inspectStatusHistory(transport, previous, report, {
      concurrency: args.concurrency,
    });
  if (args.save) {
    const path = writeStatusSnapshot(toStatusSnapshot(report), io.snapshotHome);
    extra.snapshot = { path, generatedAt: report.generatedAt };
    if (format !== "json") io.stderr(`Snapshot saved: ${safeStatusText(path)}\n`);
  }
  io.stdout(
    format === "json"
      ? `${JSON.stringify({ ...report, ...extra }, null, 2)}\n`
      : renderStatus(report, {
          view: args.view,
          format,
          color: format === "table" && io.isTTY && !io.noColor && !io.ci,
          width: io.width,
        }) +
          (extra.history
            ? `\n${renderStatusHistory(extra.history, { format, width: io.width })}`
            : ""),
  );
  if (!report.coverageComplete) {
    io.stderr("INCOMPLETE_INVENTORY: some counts are unknown; inspect coverage and rerun.\n");
    return 1;
  }
  if (extra.history && !extra.history.coverageComplete) {
    io.stderr(
      "INCOMPLETE_HISTORY: some transitions could not be verified; inspect history.uncertain, departures and totals.\n",
    );
    return 1;
  }
  return 0;
}
