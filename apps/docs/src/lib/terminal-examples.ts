import capture from "./example-workflow.json";
import { plainTerminalText, type TerminalExample } from "./terminal-demo";

export interface TerminalLineRange {
  startLine: number;
  endLine: number;
}

export interface TerminalSelection {
  source: `${string}.terminalOutput`;
  lineNumbering: "1-based inclusive";
  lineRanges: readonly TerminalLineRange[];
}

export interface TerminalExampleSource {
  id: string;
  label: string;
  summary: string;
  command: string;
  output: string;
  selection: TerminalSelection;
  image?: { src: string; alt: string; width: number; height: number };
}

export function selectTerminalLines(text: string, ranges: readonly TerminalLineRange[]): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let previousEnd = 0;
  return ranges
    .map(({ startLine, endLine }) => {
      if (
        !Number.isInteger(startLine) ||
        !Number.isInteger(endLine) ||
        startLine <= previousEnd ||
        endLine < startLine ||
        endLine > lines.length
      ) {
        throw new RangeError("Terminal line ranges must be in source order and within the output.");
      }
      previousEnd = endLine;
      return lines.slice(startLine - 1, endLine).join("\n");
    })
    .join("\n");
}

export function summarizeGraphNodes(nodes: readonly { kind: string; state: string }[]): string {
  const merged = nodes.filter(
    (node) => node.kind === "PullRequest" && node.state === "MERGED",
  ).length;
  const open = nodes.filter((node) => node.kind === "Issue" && node.state === "OPEN").length;
  return `${merged} merged PR${merged === 1 ? "" : "s"}, ${open} open follow-up${open === 1 ? "" : "s"}`;
}

export function summarizeStatusOutput(output: string): string {
  const open = output.match(/^Totals:[ \t]+Open[ \t]+(\d+|\?)(?=[ \t·\r\n]|$)/m)?.[1] ?? "?";
  return open === "1"
    ? "1 open PR with its review state"
    : `${open} open PRs with their review states`;
}

export function summarizePlanOutput(output: string): string {
  const open = output.match(/^-[ \t]+Open items:[ \t]+(\d+|\?)[ \t]*\r?$/m)?.[1] ?? "?";
  const items = `${open} open item${open === "1" ? "" : "s"}`;
  return /^## Next\r?\n(?:\r?\n)*- \S/m.test(output)
    ? `${items}, a suggested next action`
    : `${items} in the captured backlog`;
}

export const terminalExampleCatalog = [
  {
    id: "open",
    label: "Capture",
    summary: "80 open items captured within an explicit budget",
    command: capture.open.command,
    output: capture.open.terminalOutput,
    selection: {
      source: "example-workflow.json.open.terminalOutput",
      lineNumbering: "1-based inclusive",
      lineRanges: [{ startLine: 1, endLine: capture.open.terminalOutput.split("\n").length }],
    },
  },
  {
    id: "query",
    label: "Prioritize",
    summary: "10 issues in the top 25% by Heat · first two shown",
    command: capture.query.command,
    output: capture.query.terminalOutput,
    selection: {
      source: "example-workflow.json.query.terminalOutput",
      lineNumbering: "1-based inclusive",
      lineRanges: [{ startLine: 1, endLine: capture.query.terminalOutput.split("\n").length }],
    },
  },
  {
    id: "dashboard",
    label: "Dashboard",
    summary: "Open the same ranking, filters, and weights in your browser",
    command: capture.dashboard.command,
    output: capture.dashboard.terminalOutput,
    selection: {
      source: "example-workflow.json.dashboard.terminalOutput",
      lineNumbering: "1-based inclusive",
      lineRanges: [{ startLine: 1, endLine: capture.dashboard.terminalOutput.split("\n").length }],
    },
    image: {
      src: "/dashboard-rank.png",
      alt: "Captured portless Rank dashboard with three active filters, adjustable weights, and issue #313 first at 33.2 Heat.",
      width: 1100,
      height: 690,
    },
  },
] as const satisfies readonly TerminalExampleSource[];

export function toTerminalExample(example: TerminalExampleSource): TerminalExample {
  return {
    id: example.id,
    label: example.label,
    summary: example.summary,
    command: example.command,
    output: plainTerminalText(selectTerminalLines(example.output, example.selection.lineRanges)),
    ...(example.image ? { image: example.image } : {}),
  };
}
