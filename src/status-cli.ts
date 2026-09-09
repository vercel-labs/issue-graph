import {
  collectStatus,
  normalizeStatusScope,
  type StatusFormat,
  type StatusOptions,
  type StatusView,
} from "./status.js";
import { renderStatus, safeStatusText } from "./status-render.js";
import type { GhTransport } from "./transport.js";

export const STATUS_USAGE = `usage: xref status --repo owner/repo --author login[,login] [options]

Count open PRs by repository and author without a graph crawl or local writes.

  --repo owner/repo       repeat for each repository (required)
  --author login[,login]  repeat or comma-separate authors (required)
  --view VIEW            authors (default), projects, or prs
  --format FORMAT        auto (default), table, markdown, or json
  --json                 JSON on stdout; no filename (status only)
  --concurrency N        repositories in flight, 1..32 (default 4)
  --max-pages N          pages per connection, 1..1000 (default 100)
  --no-snapshot          accepted; status never writes snapshots
  -h, --help             show this help

Auto output: terminal table for TTY, JSON for pipes. NO_COLOR disables color.
Exit 0: complete inventory; 1: incomplete/runtime failure; 2: invalid arguments.
Unknown counts are ?, not 0. Conflicts and drafts overlap review states.

Examples:
  xref status --repo vercel-labs/agent-browser --author ctate,Railly
  xref status --repo vercel-labs/wterm --author ctate --view prs
  xref status --repo vercel-labs/emulate --author ctate --json`;

export class StatusUsageError extends Error {}

export interface StatusArgs extends StatusOptions {
  view: StatusView;
  format: StatusFormat;
  help: boolean;
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
    else if (flag === "--no-snapshot") continue;
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
  const format = args.format === "auto" ? (io.isTTY ? "table" : "json") : args.format;
  const humanTTY = io.isTTY && format !== "json";
  if (humanTTY) io.stderr(`xref status · read-only inventory · ${args.repos.length} repos\n`);
  const report = await collectStatus(transport, {
    ...args,
    onProgress: humanTTY
      ? (event) =>
          io.stderr(
            `  ${safeStatusText(event.repo)}: ${event.scanned} PRs scanned, ${event.pages} pages${event.complete ? " (last page)" : ""}\n`,
          )
      : undefined,
  });
  io.stdout(
    format === "json"
      ? `${JSON.stringify(report, null, 2)}\n`
      : renderStatus(report, {
          view: args.view,
          format,
          color: format === "table" && io.isTTY && !io.noColor && !io.ci,
          width: io.width,
        }),
  );
  if (!report.coverageComplete) {
    io.stderr("INCOMPLETE_INVENTORY: some counts are unknown; inspect coverage and rerun.\n");
    return 1;
  }
  return 0;
}
