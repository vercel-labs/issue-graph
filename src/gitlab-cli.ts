import {
  buildGitLabGraph,
  type GitLabReader,
  type GitLabReport,
  parseGitLabHost,
  parseGitLabLocator,
  renderGitLab,
} from "./gitlab.js";
import { gitlabDashboardModel } from "./gitlab-html.js";
import { parseWorkClusters, workClusterPrompt } from "./work-clusters.js";

export const GITLAB_USAGE = `usage: issue-graph gitlab <issue-or-mr-url|group/project#N|group/project!N> [options]

Read GitLab issue links, closing merge requests, and mentions from system notes
through the GitLab CLI (glab).

  --host HOST           GitLab host (default: the URL's host, or glab's default host)
  --depth N             same-project reference depth, 0..8 (default 1)
  --max-nodes N         node cap, 1..1000 (default 80)
  --hub-threshold N     stop expanding non-seed hubs, 1..1000 (default 12)
  --concurrency N       items read in parallel, 1..16 (default 4)
  --json                print JSON to stdout
  --html PATH           write an HTML explorer and save this project to the dashboard
  --open                open the HTML explorer (creates a temporary file if needed)
  --no-save             do not save this run to the dashboard
  --cluster             print a thematic clustering task for the calling agent
  --clusters PATH       apply proposed themes from JSON to --html or --open
  -h, --help            show help without running glab

Sign in with \`glab auth login\` first, or set GITLAB_TOKEN, which glab sends only
to its default or configured hosts. Every read is a \`glab api --method GET\` call.
Nothing is written to GitLab, local files are written only with --html or --open,
and issue-graph reads or stores no GitLab credential.
Issues (#N) and merge requests (!N) are separate nodes. References into other
projects are read one hop and not expanded. Mentions come from "mentioned in"
system notes on the item that was mentioned, so an item's own outgoing text
references appear only when GitLab recorded them on the target. Group-level
work items, such as epics, are listed as link targets but not read.
Exit codes: 0 complete within scope, 1 partial or failed, 2 invalid usage.`;

export interface GitLabIO {
  stdout(value: string): void;
  stderr(value: string): void;
  dashboard?(
    report: GitLabReport,
    options: { path?: string; open: boolean; save: boolean; clusters?: unknown },
  ): Promise<void>;
  readClusters?(path: string): Promise<unknown>;
}

export async function runGitLab(
  argv: string[],
  reader: (host?: string) => GitLabReader | Promise<GitLabReader>,
  io: GitLabIO,
): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    io.stdout(`${GITLAB_USAGE}\n`);
    return 0;
  }
  const options = { maxDepth: 1, maxNodes: 80, hubThreshold: 12, concurrency: 4 };
  const integers = {
    "--depth": ["maxDepth", 0, 8],
    "--max-nodes": ["maxNodes", 1, 1000],
    "--hub-threshold": ["hubThreshold", 1, 1000],
    "--concurrency": ["concurrency", 1, 16],
  } as const;
  let seed: string | undefined;
  let host: string | undefined;
  let json = false;
  let htmlPath: string | undefined;
  let open = false;
  let save = true;
  let cluster = false;
  let clustersPath: string | undefined;
  try {
    const flagValue = (index: number, message: string) => {
      const value = argv[index];
      if (!value || value.startsWith("-")) throw new Error(message);
      return value;
    };
    for (let index = 0; index < argv.length; index++) {
      const arg = argv[index];
      if (arg === "--json") json = true;
      else if (arg === "--open") open = true;
      else if (arg === "--no-save") save = false;
      else if (arg === "--cluster") cluster = true;
      else if (arg === "--clusters")
        clustersPath = flagValue(++index, "--clusters requires a JSON path");
      else if (arg === "--html") htmlPath = flagValue(++index, "--html requires an output path");
      else if (arg === "--host")
        host = parseGitLabHost(flagValue(++index, "--host requires a GitLab host"));
      else if (Object.hasOwn(integers, arg)) {
        const [name, minimum, maximum] = integers[arg as keyof typeof integers];
        const raw = argv[++index];
        const value = Number(raw);
        if (!raw || !/^\d+$/.test(raw) || value < minimum || value > maximum)
          throw new Error(`${arg} must be an integer from ${minimum} to ${maximum}`);
        options[name] = value;
      } else if (arg.startsWith("-")) throw new Error(`Unknown GitLab flag: ${arg}`);
      else if (seed) throw new Error("Specify exactly one GitLab issue or merge request");
      else seed = arg;
    }
    if (!seed) throw new Error("Specify a GitLab issue or merge request URL or reference");
    if (clustersPath && !htmlPath && !open) throw new Error("--clusters requires --html or --open");
    if (cluster && json) throw new Error("--cluster cannot be combined with --json");
    const locator = parseGitLabLocator(seed);
    if (locator.host && host && locator.host !== host)
      throw new Error("GitLab URL and --host disagree");
    host ??= locator.host;
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : "Invalid GitLab arguments"}\n`);
    return 2;
  }
  try {
    let clusters: unknown;
    if (clustersPath) {
      if (!io.readClusters) throw new Error("Cluster file input is unavailable in this caller");
      clusters = parseWorkClusters(await io.readClusters(clustersPath));
    }
    const report = await buildGitLabGraph(await reader(host), seed, { ...options, host });
    if (htmlPath || open) {
      if (!io.dashboard) throw new Error("HTML output is unavailable in this caller");
      await io.dashboard(report, { path: htmlPath, open, save, clusters });
    }
    io.stdout(json ? `${JSON.stringify(report, null, 2)}\n` : renderGitLab(report));
    if (cluster)
      io.stdout(
        `\n${workClusterPrompt(gitlabDashboardModel(report).label ?? report.host, report.nodes)}\n`,
      );
    return report.coverageComplete ? 0 : 1;
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : "GitLab read failed"}\n`);
    return 1;
  }
}
