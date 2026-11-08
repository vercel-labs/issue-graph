import { resolveGithubAttachments } from "./linear-github.js";
import {
  buildPlaneGraph,
  buildPlaneProject,
  type PlaneReport,
  parsePlaneLocator,
  renderPlane,
} from "./plane.js";
import { planeDashboardModel } from "./plane-html.js";
import type { PlaneReader } from "./plane-queries.js";
import type { GhTransport } from "./transport.js";
import { parseWorkClusters, workClusterPrompt } from "./work-clusters.js";

export const PLANE_USAGE = `usage: issue-graph plane <work-item-url|PROJ-123|uuid> [options]
       issue-graph plane --project <uuid|IDENTIFIER> [options]

Read explicit Plane work item relations, parent and sub-work-item hierarchy, and links.

  --project ID          capture all non-archived work items in a project (UUID or identifier, e.g. ENG)
  --workspace SLUG      workspace to read (default PLANE_WORKSPACE; also checked against URLs)
  --depth N             relationship depth, 0..8 (default 1)
  --max-nodes N         node cap, 1..1000 (default 80)
  --max-pages N         pages of 100 per list, 1..100 (default 5)
  --hub-threshold N     stop expanding non-seed hubs, 1..1000 (default 12)
  --concurrency N       work item reads in flight, 1..32 (default 2)
  --github              read linked GitHub issues and PRs one hop with gh (state, draft)
  --json                print JSON to stdout
  --html PATH           write an HTML explorer and save this project to the dashboard
  --open                open the HTML explorer (creates a temporary file if needed)
  --no-save             do not save this run to the dashboard
  --cluster             print a thematic clustering task for the calling agent
  --clusters PATH       apply proposed themes from JSON to --html or --open
  -h, --help            show help without authentication or network

Set PLANE_API_KEY to a Plane API key (Profile settings > Personal access tokens).
Self-hosted Plane: set PLANE_API_URL, and PLANE_WEB_URL if the web app is on another origin.
Plane Cloud allows 60 requests per minute per key; reads are paced to
PLANE_REQUESTS_PER_MINUTE (default 50). Each work item costs about 2 requests.
Only GET requests are sent. Local files are written only with --html or --open.
Text mentions are not collected; link targets are fetched only with --github.
Exit codes: 0 complete within scope, 1 partial or failed, 2 invalid usage.`;

export interface PlaneIO {
  stdout(value: string): void;
  stderr(value: string): void;
  /** Workspace used when neither --workspace nor a URL names one. */
  defaultWorkspace?: string;
  dashboard?(
    report: PlaneReport,
    options: { path?: string; open: boolean; save: boolean; clusters?: unknown },
  ): Promise<void>;
  readClusters?(path: string): Promise<unknown>;
  github?(): Pick<GhTransport, "graphql">;
}

const SLUG = /^[a-z0-9][a-z0-9_-]*$/i;

export async function runPlane(
  argv: string[],
  reader: (workspace: string) => PlaneReader | Promise<PlaneReader>,
  io: PlaneIO,
): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    io.stdout(`${PLANE_USAGE}\n`);
    return 0;
  }
  const options = { maxDepth: 1, maxNodes: 80, maxPages: 5, hubThreshold: 12, concurrency: 2 };
  const integers = {
    "--depth": ["maxDepth", 0, 8],
    "--max-nodes": ["maxNodes", 1, 1000],
    "--max-pages": ["maxPages", 1, 100],
    "--hub-threshold": ["hubThreshold", 1, 1000],
    "--concurrency": ["concurrency", 1, 32],
  } as const;
  let seed: string | undefined;
  let project: string | undefined;
  let workspace: string | undefined;
  let json = false;
  let htmlPath: string | undefined;
  let open = false;
  let save = true;
  let cluster = false;
  let clustersPath: string | undefined;
  let github = false;
  try {
    for (let index = 0; index < argv.length; index++) {
      const arg = argv[index];
      const value = () => {
        const next = argv[++index];
        if (!next || next.startsWith("-")) throw new Error(`${arg} requires a value`);
        return next;
      };
      if (arg === "--json") json = true;
      else if (arg === "--open") open = true;
      else if (arg === "--github") github = true;
      else if (arg === "--no-save") save = false;
      else if (arg === "--cluster") cluster = true;
      else if (arg === "--clusters") clustersPath = value();
      else if (arg === "--html") htmlPath = value();
      else if (arg === "--project") {
        project = value();
        if (
          !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(project) &&
          !/^[a-z][a-z0-9]*$/i.test(project)
        )
          throw new Error("--project requires a project UUID or identifier");
      } else if (arg === "--workspace") {
        workspace = value().toLowerCase();
        if (!SLUG.test(workspace)) throw new Error("--workspace requires a workspace slug");
      } else if (Object.hasOwn(integers, arg)) {
        const [name, minimum, maximum] = integers[arg as keyof typeof integers];
        const raw = argv[++index];
        const number = Number(raw);
        if (!raw || !/^\d+$/.test(raw) || number < minimum || number > maximum)
          throw new Error(`${arg} must be an integer from ${minimum} to ${maximum}`);
        options[name] = number;
      } else if (arg.startsWith("-")) throw new Error(`Unknown Plane flag: ${arg}`);
      else if (seed) throw new Error("Specify exactly one Plane work item");
      else seed = arg;
    }
    if (!seed && !project) throw new Error("Specify a Plane work item or --project ID");
    if (seed && project) throw new Error("Choose a work item neighborhood or --project ID");
    if (clustersPath && !htmlPath && !open) throw new Error("--clusters requires --html or --open");
    if (cluster && json) throw new Error("--cluster cannot be combined with --json");
    if (seed && /^https?:\/\//i.test(seed)) {
      // The host is checked against the reader's web URL later; here only the workspace matters.
      const fromUrl = parsePlaneLocator(seed, new URL(seed).origin).workspace;
      if (fromUrl && workspace && fromUrl !== workspace)
        throw new Error("Plane URL and --workspace disagree");
      workspace ??= fromUrl;
    } else if (seed) parsePlaneLocator(seed);
    workspace ??= io.defaultWorkspace?.toLowerCase();
    if (!workspace) throw new Error("Specify --workspace SLUG or set PLANE_WORKSPACE");
    if (!SLUG.test(workspace)) throw new Error("Invalid Plane workspace slug");
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : "Invalid Plane arguments"}\n`);
    return 2;
  }
  try {
    let clusters: unknown;
    if (clustersPath) {
      if (!io.readClusters) throw new Error("Cluster file input is unavailable in this caller");
      clusters = parseWorkClusters(await io.readClusters(clustersPath));
    }
    const source = await reader(workspace);
    const report = project
      ? await buildPlaneProject(source, project, options)
      : await buildPlaneGraph(source, seed as string, options);
    if (source.label) report.readSource = source.label;
    if (github) {
      if (!io.github) throw new Error("GitHub reads are unavailable in this caller");
      await resolveGithubAttachments(report, io.github());
    }
    if (htmlPath || open) {
      if (!io.dashboard) throw new Error("HTML output is unavailable in this caller");
      await io.dashboard(report, { path: htmlPath, open, save, clusters });
    }
    io.stdout(json ? `${JSON.stringify(report, null, 2)}\n` : renderPlane(report));
    if (cluster) {
      const model = planeDashboardModel(report);
      io.stdout(
        `\n${workClusterPrompt(
          model.label ?? report.workspace.name,
          report.nodes.filter((node) => model.nodes[node.key]),
        )}\n`,
      );
    }
    return report.coverageComplete ? 0 : 1;
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : "Plane read failed"}\n`);
    return 1;
  }
}

/** What to do when no Plane key is set; printed instead of a bare error. */
export function planeSetupGuide(): string {
  return `Plane is not connected.

  export PLANE_API_KEY=plane_api_...   (Profile settings > Personal access tokens)
  export PLANE_WORKSPACE=your-workspace

Self-hosted Plane: also set PLANE_API_URL=https://plane.example.com
Check with: issue-graph auth status
`;
}
