import {
  buildLinearGraph,
  buildLinearProject,
  type LinearReport,
  parseLinearLocator,
  renderLinear,
} from "./linear.js";
import { linearDashboardModel } from "./linear-html.js";
import type { LinearReader } from "./linear-queries.js";
import { parseWorkClusters, workClusterPrompt } from "./work-clusters.js";

export const LINEAR_USAGE = `usage: issue-graph linear <issue-url|identifier|uuid> [options]

Read explicit Linear issue relationships, hierarchy, and attachment links.

  --project UUID        capture all non-archived project issues instead of an issue neighborhood
  --workspace SLUG      require this workspace (also checked against issue URLs)
  --depth N             relationship depth, 0..8 (default 1)
  --max-nodes N         node cap, 1..1000 (default 80)
  --max-pages N         pages per connection per issue, 1..100 (default 5)
  --hub-threshold N     stop expanding non-seed hubs, 1..1000 (default 12)
  --concurrency N       issue reads in flight, 1..32 (default 4)
  --json                print JSON to stdout
  --html PATH           write an HTML explorer and save this project to the dashboard
  --open                open the HTML explorer (creates a temporary file if needed)
  --no-snapshot         do not save this run to the dashboard
  --cluster             print a thematic clustering task for the calling agent
  --clusters PATH       apply proposed themes from JSON to --html or --open
  -h, --help            show help without authentication or network

Set exactly one of LINEAR_API_KEY or LINEAR_ACCESS_TOKEN.
Only queries are sent. Local files are written only with --html or --open.
Text mentions are not collected; attachment targets are not fetched.
Exit codes: 0 complete within scope, 1 partial or failed, 2 invalid usage.`;

export interface LinearIO {
  stdout(value: string): void;
  stderr(value: string): void;
  dashboard?(
    report: LinearReport,
    options: { path?: string; open: boolean; save: boolean; clusters?: unknown },
  ): Promise<void>;
  readClusters?(path: string): Promise<unknown>;
}

export async function runLinear(
  argv: string[],
  reader: () => LinearReader | Promise<LinearReader>,
  io: LinearIO,
): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    io.stdout(`${LINEAR_USAGE}\n`);
    return 0;
  }
  const options = {
    maxDepth: 1,
    maxNodes: 80,
    maxPages: 5,
    hubThreshold: 12,
    concurrency: 4,
    workspace: undefined as string | undefined,
  };
  const integers = {
    "--depth": ["maxDepth", 0, 8],
    "--max-nodes": ["maxNodes", 1, 1000],
    "--max-pages": ["maxPages", 1, 100],
    "--hub-threshold": ["hubThreshold", 1, 1000],
    "--concurrency": ["concurrency", 1, 32],
  } as const;
  let seed: string | undefined;
  let project: string | undefined;
  let json = false;
  let htmlPath: string | undefined;
  let open = false;
  let save = true;
  let cluster = false;
  let clustersPath: string | undefined;
  try {
    for (let index = 0; index < argv.length; index++) {
      const arg = argv[index];
      if (arg === "--json") json = true;
      else if (arg === "--open") open = true;
      else if (arg === "--no-snapshot") save = false;
      else if (arg === "--cluster") cluster = true;
      else if (arg === "--clusters") {
        const value = argv[++index];
        if (!value || value.startsWith("-")) throw new Error("--clusters requires a JSON path");
        clustersPath = value;
      } else if (arg === "--html") {
        const value = argv[++index];
        if (!value || value.startsWith("-")) throw new Error("--html requires an output path");
        htmlPath = value;
      } else if (arg === "--project") {
        const value = argv[++index];
        if (!value || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value))
          throw new Error("--project requires a project UUID");
        project = value;
      } else if (arg === "--workspace") {
        const value = argv[++index];
        if (!value || !/^[a-z0-9][a-z0-9-]*$/i.test(value))
          throw new Error("--workspace requires a workspace slug");
        options.workspace = value.toLowerCase();
      } else if (Object.hasOwn(integers, arg)) {
        const [name, minimum, maximum] = integers[arg as keyof typeof integers];
        const raw = argv[++index];
        const value = Number(raw);
        if (!raw || !/^\d+$/.test(raw) || value < minimum || value > maximum)
          throw new Error(`${arg} must be an integer from ${minimum} to ${maximum}`);
        options[name] = value;
      } else if (arg.startsWith("-")) throw new Error(`Unknown Linear flag: ${arg}`);
      else if (seed) throw new Error("Specify exactly one Linear issue");
      else seed = arg;
    }
    if (!seed && !project) throw new Error("Specify a Linear issue or --project UUID");
    if (seed && project) throw new Error("Choose an issue neighborhood or --project UUID");
    if (clustersPath && !htmlPath && !open) throw new Error("--clusters requires --html or --open");
    if (cluster && json) throw new Error("--cluster cannot be combined with --json");
    if (seed) {
      const locator = parseLinearLocator(seed);
      if (locator.workspace && options.workspace && locator.workspace !== options.workspace)
        throw new Error("Linear URL and --workspace disagree");
    }
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : "Invalid Linear arguments"}\n`);
    return 2;
  }
  try {
    let clusters: unknown;
    if (clustersPath) {
      if (!io.readClusters) throw new Error("Cluster file input is unavailable in this caller");
      clusters = parseWorkClusters(await io.readClusters(clustersPath));
    }
    const source = await reader();
    const report = project
      ? await buildLinearProject(source, project, options)
      : await buildLinearGraph(source, seed as string, options);
    if (htmlPath || open) {
      if (!io.dashboard) throw new Error("HTML output is unavailable in this caller");
      await io.dashboard(report, { path: htmlPath, open, save, clusters });
    }
    io.stdout(json ? `${JSON.stringify(report, null, 2)}\n` : renderLinear(report));
    if (cluster) {
      const model = linearDashboardModel(report);
      io.stdout(
        `\n${workClusterPrompt(
          model.label ?? report.workspace.name,
          report.nodes.filter((node) => model.nodes[node.key]),
        )}\n`,
      );
    }
    return report.coverageComplete ? 0 : 1;
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : "Linear read failed"}\n`);
    return 1;
  }
}
