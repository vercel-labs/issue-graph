import graph from "./example-graph.json";
import plan from "./example-plan.json";
import status from "./example-status.json";
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
    id: "graph",
    label: "Graph",
    summary: summarizeGraphNodes(graph.nodes),
    command: graph.command,
    output: graph.terminalOutput,
    selection: {
      source: "example-graph.json.terminalOutput",
      lineNumbering: "1-based inclusive",
      lineRanges: [
        { startLine: 1, endLine: 3 },
        { startLine: 9, endLine: 10 },
        { startLine: 14, endLine: 20 },
      ],
    },
  },
  {
    id: "status",
    label: "PR status",
    summary: summarizeStatusOutput(status.terminalOutput),
    command: status.command,
    output: status.terminalOutput,
    selection: {
      source: "example-status.json.terminalOutput",
      lineNumbering: "1-based inclusive",
      lineRanges: [{ startLine: 1, endLine: 13 }],
    },
  },
  {
    id: "plan",
    label: "Backlog",
    summary: summarizePlanOutput(plan.terminalOutput),
    command: plan.command,
    output: plan.terminalOutput,
    selection: {
      source: "example-plan.json.terminalOutput",
      lineNumbering: "1-based inclusive",
      lineRanges: [{ startLine: 1, endLine: 16 }],
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
  };
}
