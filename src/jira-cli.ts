import { crawlGraph } from "./crawl.js";
import {
  buildJiraReport,
  fetchJiraNode,
  type JiraReader,
  jiraDepthForEdge,
  jiraNodeKey,
  normalizeJiraKey,
  renderJiraReport,
} from "./jira.js";

export const JIRA_USAGE = `usage: issue-graph jira ISSUE-KEY [options]

Trace Jira work-item relationships through an authenticated customer TWG CLI.
This command is read-only and writes no snapshots.

  --site SITE           Atlassian site prefix or cloud ID; uses TWG default when omitted
  --depth N             same-project recursion depth, 0..10 (default 2)
  --max-nodes N         total Jira nodes, 1..1000 (default 80)
  --hub-threshold N     fetch but do not expand non-seed nodes above this degree (default 12)
  --concurrency N       concurrent TWG reads, 1..32 (default 4)
  --format FORMAT       auto (default), markdown, or json
  --json                JSON stdout shorthand; takes no filename
  -h, --help            show this help

Auto output is Markdown in a terminal and versioned JSON in a pipe.
Structured cross-project links are fetched as one-hop boundaries. Cross-project text matches and non-Jira links are reported but not fetched.

Examples:
  issue-graph jira PROJ-123
  issue-graph jira PROJ-123 --site example --depth 1 --max-nodes 20
  issue-graph jira PROJ-123 --site 00000000-0000-0000-0000-000000000000 --json`;

export class JiraUsageError extends Error {}

export interface JiraArgs {
  issueKey: string;
  site?: string;
  depth: number;
  maxNodes: number;
  hubThreshold: number;
  concurrency: number;
  format: "auto" | "markdown" | "json";
  help: boolean;
}

function value(argv: string[], index: number, flag: string): string {
  const next = argv[index + 1];
  if (!next || next.startsWith("-")) throw new JiraUsageError(`${flag} requires a value`);
  return next;
}

export function parseJiraArgs(argv: string[]): JiraArgs {
  const args: JiraArgs = {
    issueKey: "",
    depth: 2,
    maxNodes: 80,
    hubThreshold: 12,
    concurrency: 4,
    format: "auto",
    help: false,
  };
  let json = false;
  let explicitFormat: JiraArgs["format"] | null = null;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--site") args.site = value(argv, index++, arg);
    else if (arg === "--depth") args.depth = Number(value(argv, index++, arg));
    else if (arg === "--max-nodes") args.maxNodes = Number(value(argv, index++, arg));
    else if (arg === "--hub-threshold") args.hubThreshold = Number(value(argv, index++, arg));
    else if (arg === "--concurrency") args.concurrency = Number(value(argv, index++, arg));
    else if (arg === "--format") {
      const format = value(argv, index++, arg);
      if (format !== "auto" && format !== "markdown" && format !== "json")
        throw new JiraUsageError(`unknown Jira format: ${format}`);
      args.format = format;
      explicitFormat = format;
    } else if (arg === "--json") {
      args.format = "json";
      json = true;
    } else if (arg.startsWith("-")) throw new JiraUsageError(`unknown Jira flag: ${arg}`);
    else if (args.issueKey) throw new JiraUsageError("jira accepts exactly one issue key");
    else args.issueKey = arg;
  }

  if (json && explicitFormat && explicitFormat !== "json")
    throw new JiraUsageError("--json conflicts with a non-JSON --format");
  if (args.site?.startsWith("-")) throw new JiraUsageError("--site cannot start with '-'");
  if (!Number.isInteger(args.depth) || args.depth < 0 || args.depth > 10)
    throw new JiraUsageError("--depth must be an integer from 0 to 10");
  if (!Number.isInteger(args.maxNodes) || args.maxNodes < 1 || args.maxNodes > 1000)
    throw new JiraUsageError("--max-nodes must be an integer from 1 to 1000");
  if (!Number.isInteger(args.hubThreshold) || args.hubThreshold < 0 || args.hubThreshold > 1000)
    throw new JiraUsageError("--hub-threshold must be an integer from 0 to 1000");
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1 || args.concurrency > 32)
    throw new JiraUsageError("--concurrency must be an integer from 1 to 32");
  if (!args.help) {
    const issueKey = normalizeJiraKey(args.issueKey);
    if (!issueKey) throw new JiraUsageError("jira requires an issue key such as PROJ-123");
    args.issueKey = issueKey;
  }
  return args;
}

export interface JiraIO {
  isTTY: boolean;
  stdout: (value: string) => void;
  stderr: (value: string) => void;
  now?: () => Date;
}

export async function runJira(argv: string[], reader: JiraReader, io: JiraIO): Promise<number> {
  const args = parseJiraArgs(argv);
  if (args.help) {
    io.stdout(`${JIRA_USAGE}\n`);
    return 0;
  }
  const format = args.format === "auto" ? (io.isTTY ? "markdown" : "json") : args.format;
  if (format === "markdown" && io.isTTY)
    io.stderr(
      `issue-graph jira · read-only TWG crawl · ${args.issueKey} · depth ${args.depth} · max ${args.maxNodes}\n`,
    );

  const result = await crawlGraph(
    [{ key: jiraNodeKey(args.issueKey) }],
    {
      maxDepth: args.depth,
      maxNodes: args.maxNodes,
      hubThreshold: args.hubThreshold,
      concurrency: args.concurrency,
      depthForEdge: jiraDepthForEdge(args.issueKey),
    },
    (key, depth) => fetchJiraNode(reader, key, depth, args.site),
  );
  const report = buildJiraReport(
    args.issueKey,
    args.site,
    {
      maxDepth: args.depth,
      maxNodes: args.maxNodes,
      hubThreshold: args.hubThreshold,
      concurrency: args.concurrency,
    },
    result,
    (io.now ?? (() => new Date()))().toISOString(),
  );
  io.stdout(format === "json" ? `${JSON.stringify(report, null, 2)}\n` : renderJiraReport(report));
  if (!report.coverageComplete) {
    io.stderr(
      "INCOMPLETE_JIRA_GRAPH: inspect coverage.failed and coverage.cappedOut before acting.\n",
    );
    return 1;
  }
  return 0;
}
