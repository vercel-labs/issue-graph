import { parseWorkClusters, workClusterPrompt } from "./work-clusters.js";
import { concurrencyRange, WORK_LIMIT_RANGES, type WorkReport } from "./work-report.js";

export interface WorkDashboardOptions {
  path?: string;
  open: boolean;
  save: boolean;
  clusters?: unknown;
}

export interface WorkIO<TReport> {
  stdout(value: string): void;
  stderr(value: string): void;
  dashboard?(report: TReport, options: WorkDashboardOptions): Promise<void>;
  readClusters?(path: string): Promise<unknown>;
}

export interface WorkLimitsInput {
  maxDepth: number;
  maxNodes: number;
  hubThreshold: number;
  concurrency: number;
}

/** One neighborhood command, such as `issue-graph jira`. */
export interface WorkCommand<TReport extends WorkReport, TReader> {
  /** Provider name in messages: "Jira". */
  name: string;
  usage: string;
  maxConcurrency: number;
  /** The provider's authority flag, such as `--site`. */
  authority: { flag: string; missing: string; parse(value: string): string };
  /** "Specify exactly one Jira issue". */
  oneSeed?: string;
  /** "Specify a Jira issue key or browse URL". */
  noSeed: string;
  /** Checks the seed and returns the authority to read from; throws a usage error. */
  resolve(seeds: string[], authority: string | undefined): string | undefined;
  build(
    reader: TReader,
    seeds: string[],
    options: WorkLimitsInput & { authority?: string },
  ): Promise<TReport>;
  render(report: TReport): string;
  /** Label for the clustering task. */
  label(report: TReport): string;
}

/**
 * Runs one neighborhood command: parses flags, reads the graph, writes the dashboard when
 * asked, prints Markdown or JSON, and returns the exit code (0 complete, 1 partial or failed,
 * 2 invalid usage).
 */
export async function runWorkCommand<TReport extends WorkReport, TReader>(
  command: WorkCommand<TReport, TReader>,
  argv: string[],
  reader: (authority?: string) => TReader | Promise<TReader>,
  io: WorkIO<TReport>,
): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    io.stdout(`${command.usage}\n`);
    return 0;
  }
  const options = { maxDepth: 1, maxNodes: 80, hubThreshold: 12, concurrency: 4 };
  const integers = {
    "--depth": "maxDepth",
    "--max-nodes": "maxNodes",
    "--hub-threshold": "hubThreshold",
    "--concurrency": "concurrency",
  } as const;
  const seeds: string[] = [];
  let authority: string | undefined;
  let json = false;
  let htmlPath: string | undefined;
  let open = false;
  let save = true;
  let cluster = false;
  let clustersPath: string | undefined;
  const flagValue = (value: string | undefined, message: string) => {
    if (!value || value.startsWith("-")) throw new Error(message);
    return value;
  };
  try {
    for (let index = 0; index < argv.length; index++) {
      const arg = argv[index];
      if (arg === "--json") json = true;
      else if (arg === "--open") open = true;
      else if (arg === "--no-save") save = false;
      else if (arg === "--cluster") cluster = true;
      else if (arg === "--clusters")
        clustersPath = flagValue(argv[++index], "--clusters requires a JSON path");
      else if (arg === "--html")
        htmlPath = flagValue(argv[++index], "--html requires an output path");
      else if (arg === command.authority.flag)
        authority = command.authority.parse(flagValue(argv[++index], command.authority.missing));
      else if (Object.hasOwn(integers, arg)) {
        const name = integers[arg as keyof typeof integers];
        const [minimum, maximum] =
          name === "concurrency"
            ? concurrencyRange(command.maxConcurrency)
            : WORK_LIMIT_RANGES[name];
        const raw = argv[++index];
        const value = Number(raw);
        if (!raw || !/^\d+$/.test(raw) || value < minimum || value > maximum)
          throw new Error(`${arg} must be an integer from ${minimum} to ${maximum}`);
        options[name] = value;
      } else if (arg.startsWith("-")) throw new Error(`Unknown ${command.name} flag: ${arg}`);
      else if (seeds.length && command.oneSeed) throw new Error(command.oneSeed);
      else seeds.push(arg);
    }
    if (!seeds.length) throw new Error(command.noSeed);
    if (clustersPath && !htmlPath && !open) throw new Error("--clusters requires --html or --open");
    if (cluster && json) throw new Error("--cluster cannot be combined with --json");
    authority = command.resolve(seeds, authority);
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : `Invalid ${command.name} arguments`}\n`);
    return 2;
  }
  try {
    let clusters: unknown;
    if (clustersPath) {
      if (!io.readClusters) throw new Error("Cluster file input is unavailable in this caller");
      clusters = parseWorkClusters(await io.readClusters(clustersPath));
    }
    const report = await command.build(await reader(authority), seeds, { ...options, authority });
    if (htmlPath || open) {
      if (!io.dashboard) throw new Error("HTML output is unavailable in this caller");
      await io.dashboard(report, { path: htmlPath, open, save, clusters });
    }
    io.stdout(json ? `${JSON.stringify(report, null, 2)}\n` : command.render(report));
    if (cluster) io.stdout(`\n${workClusterPrompt(command.label(report), report.nodes)}\n`);
    return report.coverageComplete ? 0 : 1;
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : `${command.name} read failed`}\n`);
    return 1;
  }
}
