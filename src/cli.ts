import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { classify, fillMentionedBy } from "./classify.js";
import {
  clusterJsonPrompt,
  clusterPayload,
  clusterPrompt,
  parseClustersReply,
  renderClusters,
  runAgent,
} from "./cluster.js";
import { modelDefaults, readConfig, resolveWeights } from "./config.js";
import { components, crawl } from "./crawl.js";
import { labelSeeds, makeFetchNode, openBacklogSeeds, repositoryOpenCount } from "./github.js";
import { applyClusters, type ClustersConfig, dashboardModel, type Model } from "./html.js";
import { renderHumanOutput } from "./human-output.js";
import { writeNextDashboard } from "./next-dashboard.js";
import { fileOverlaps } from "./overlaps.js";
import { buildPlanReport, renderPlan } from "./plan.js";
import { prioritize, renderPriority } from "./priority.js";
import { runQueryCli } from "./query-cli.js";
import { buildReconcileReport, renderReconcile } from "./reconcile.js";
import { parseSeed } from "./refs.js";
import { render } from "./render.js";
import { ISSUE_GRAPH_SCHEMA } from "./schema.js";
import { inferRepo, parseScope, type Scope } from "./scope.js";
import { runSkills } from "./skills-cli.js";
import {
  diffReconcileSnapshots,
  diffSnapshots,
  listDashboardRuns,
  listSnapshots,
  readDashboardModel,
  readDashboardModels,
  readReconcileSnapshot,
  readSnapshot,
  reconcileSnapshotDir,
  removeDashboardRun,
  snapshotDir,
  toReconcileSnapshot,
  toSnapshot,
  writeDashboardModel,
  writeReconcileSnapshot,
  writeSnapshot,
} from "./snapshot.js";
import { runStatus } from "./status-cli.js";
import type { GhTransport } from "./transport.js";
import { shellTransport } from "./transports/shell.js";
import type { NodeKey, Seed } from "./types.js";

const USAGE = `usage: issue-graph [command] [scope...] [options]

Run with no arguments inside a GitHub repository to open its backlog dashboard.

commands
  open [repo]              open issues and PRs → optional root-cause clusters → dashboard
  graph <item...>          reference graph of issues/PRs: linked work, competing fixes, overlap
  rank [repo]              what to fix first, by discussion heat
  query [provider:scope]   filter saved captures and open the exact view (--help for filters)
  config show | set       global, provider and project defaults (--help for weights)
  cluster [repo]           the task for your agent to group open work by root cause
  cluster [repo] --apply F apply the agent's answer (a file, or - for stdin) to the dashboard
  reconcile [repo]         open-backlog verification queue
  plan [repo]              next backlog action
  status [repo...] --author login[,login]   PR counts by author, project, or review state
  dashboard                every saved run in one explorer, with a project switcher
  runs [list | rm <repo>]  saved runs behind the dashboard
  auth [status]            provider sign-in state
  schema                   JSON contract for reconcile, plan, and status
  skills [list | get core] bundled agent guides

scope
  (none)                   the GitHub repository of the current directory
  owner/repo               a repository; github:owner/repo names the provider
  123  #123  owner/repo#123  <issue or PR URL>   one or more items

options
  --label L                only items with this label
  --state open|all         which items a repository scope covers (default open)
  --format F               human, markdown, or json (default: human in a terminal, else markdown)
  -o, --out PATH           also write a file; .json for the graph, .html for the explorer
  --open, --no-open        open the explorer (open defaults to yes in an interactive terminal)
  --agent A                claude or codex: cluster without an agent session (cron, CI)
  --clusters PATH          group the explorer by clusters from a JSON file instead of an agent
  --no-save                do not keep this run under ~/.issue-graph/
  -h, --help               show this

advanced
  --budget N               stop after N items (default 80, or 1000 for a whole repository)
  --depth N                same-repository reference depth (default 2)
  --hub-threshold N        fetch but do not expand an item with more references (default 12)
  --concurrency N          GitHub requests in flight (default 4, max 32)

Older flags still work for one minor release and print their replacement.
NO_COLOR, CI, or TERM=dumb disables styling.`;

type Command =
  | "graph"
  | "open"
  | "rank"
  | "cluster"
  | "reconcile"
  | "plan"
  | "schema"
  | "dashboard"
  | "runs"
  | "auth";
const COMMANDS: Command[] = [
  "graph",
  "open",
  "rank",
  "cluster",
  "reconcile",
  "plan",
  "schema",
  "dashboard",
  "runs",
  "auth",
];

interface Args {
  command: Command;
  /** true when the command was typed, false when a bare seed implied graph */
  explicit: boolean;
  seed: string;
  items: Array<{ repo?: string; number: number }>;
  rest: string[];
  repo: string;
  depth: number;
  jsonOut: string;
  htmlOut: string;
  clustersFile: string;
  seedsCsv: string;
  label: string;
  state: "open" | "all";
  allOpen: boolean;
  maxNodes: number;
  budgetSet: boolean;
  hubThreshold: number;
  concurrency: number;
  cluster: boolean;
  clusterRun: string;
  agent: "" | "claude" | "codex" | "none";
  apply: string;
  open: boolean;
  openMode: "auto" | "yes" | "no";
  noSnapshot: boolean;
  prioritize: boolean;
  format: "auto" | "json" | "markdown" | "text";
  help: boolean;
  deprecations: string[];
}

export class UsageError extends Error {}

const need = (argv: string[], i: number, flag: string): string => {
  const v = argv[i];
  if (v === undefined || v.startsWith("-")) throw new UsageError(`${flag} needs a value`);
  return v;
};

export function parseArgs(argv: string[]): Args {
  const explicit = (COMMANDS as string[]).includes(argv[0] ?? "");
  const command: Command = explicit ? (argv[0] as Command) : "graph";
  const a: Args = {
    command,
    explicit,
    seed: "",
    items: [],
    rest: [],
    repo: "",
    depth: 2,
    jsonOut: "",
    htmlOut: "",
    clustersFile: "",
    seedsCsv: "",
    label: "",
    state: "open",
    allOpen: false,
    maxNodes: 80,
    budgetSet: false,
    hubThreshold: 12,
    concurrency: 4,
    cluster: false,
    clusterRun: "",
    agent: "",
    apply: "",
    open: false,
    openMode: "auto",
    noSnapshot: false,
    prioritize: false,
    format: "auto",
    help: false,
    deprecations: [],
  };
  const old = (flag: string, now: string) => a.deprecations.push(`${flag} is now ${now}`);
  const positional: string[] = [];
  for (let i = explicit ? 1 : 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") a.help = true;
    else if (arg === "--repo") a.repo = need(argv, ++i, arg);
    else if (arg === "--depth") a.depth = Number(need(argv, ++i, arg));
    else if (arg === "--label") a.label = need(argv, ++i, arg);
    else if (arg === "--state") {
      const v = need(argv, ++i, arg);
      if (v !== "open" && v !== "all") throw new UsageError("--state must be open or all");
      a.state = v;
    } else if (arg === "--budget" || arg === "--max-nodes") {
      if (arg === "--max-nodes") old(arg, "--budget");
      a.maxNodes = Number(need(argv, ++i, arg));
      a.budgetSet = true;
    } else if (arg === "--hub-threshold") a.hubThreshold = Number(need(argv, ++i, arg));
    else if (arg === "--concurrency") a.concurrency = Number(need(argv, ++i, arg));
    else if (arg === "--format") {
      const f = need(argv, ++i, arg);
      const map: Record<string, Args["format"]> = {
        auto: "auto",
        human: "text",
        text: "text",
        markdown: "markdown",
        json: "json",
      };
      if (!map[f]) throw new UsageError(`unknown format: ${f} (use human, markdown, or json)`);
      a.format = map[f];
    } else if (arg === "-o" || arg === "--out") {
      const out = need(argv, ++i, arg);
      if (out.endsWith(".html")) a.htmlOut = out;
      else if (out.endsWith(".json")) a.jsonOut = out;
      else throw new UsageError(`${arg} takes a .json or .html path`);
    } else if (arg === "--json") {
      old(arg, "-o PATH.json");
      a.jsonOut = need(argv, ++i, arg);
    } else if (arg === "--html") {
      old(arg, "-o PATH.html");
      a.htmlOut = need(argv, ++i, arg);
    } else if (arg === "--clusters") a.clustersFile = need(argv, ++i, arg);
    else if (arg === "--seeds") {
      old(arg, "a list of items, e.g. issue-graph graph 1 2 3");
      a.seedsCsv = need(argv, ++i, arg);
    } else if (arg === "--all-open") {
      old(arg, "issue-graph open");
      a.allOpen = true;
    } else if (arg === "--prioritize") {
      old(arg, "issue-graph rank");
      a.prioritize = true;
    } else if (arg === "--cluster") a.cluster = true;
    else if (arg === "--cluster-run") {
      old(arg, "--agent");
      a.cluster = true;
      a.clusterRun = need(argv, ++i, arg);
    } else if (arg === "--agent") {
      const v = need(argv, ++i, arg);
      if (v !== "claude" && v !== "codex" && v !== "none")
        throw new UsageError("--agent must be claude, codex, or none");
      a.agent = v;
    } else if (arg === "--apply") {
      // "-" means stdin, so it cannot go through need(), which rejects dash-leading values
      const v = argv[++i];
      if (v === undefined) throw new UsageError("--apply needs a file, or - for stdin");
      a.apply = v;
    } else if (arg === "--open") a.openMode = "yes";
    else if (arg === "--no-open") a.openMode = "no";
    else if (arg === "--no-save" || arg === "--no-snapshot") {
      if (arg === "--no-snapshot") old(arg, "--no-save");
      a.noSnapshot = true;
    } else if (arg === "--save") a.noSnapshot = false;
    // An unrecognized flag used to fall through to the seed, so a typo became
    // "Cannot parse seed: --hlep" — and `--help` crashed the same way.
    else if (arg.startsWith("-")) throw new UsageError(`unknown flag: ${arg}\n\n${USAGE}`);
    else positional.push(arg);
  }
  if (a.command === "runs" || a.command === "auth") a.rest = positional;
  else
    for (const p of positional) {
      let sc: Scope;
      try {
        sc = parseScope(p);
      } catch (e) {
        throw new UsageError(e instanceof Error ? e.message : String(e));
      }
      if (sc.kind === "repo") {
        if (a.repo && a.repo !== sc.repo)
          throw new UsageError(`one repository per run: ${a.repo} and ${sc.repo}`);
        a.repo = sc.repo;
      } else a.items.push({ repo: sc.repo, number: sc.number });
    }
  // keep the legacy single-seed field for callers and messages that read it
  if (a.items.length === 1 && !a.explicit)
    a.seed = positional.find((p) => !p.includes("/") || p.includes("#")) ?? "";
  if (a.clusterRun) {
    if (a.clusterRun !== "claude" && a.clusterRun !== "codex")
      throw new UsageError("--cluster-run must be claude or codex");
    a.agent = a.clusterRun;
  }
  if (a.agent === "claude" || a.agent === "codex") {
    a.cluster = true;
    a.clusterRun = a.agent;
  }
  // repository-wide commands cover the whole open backlog unless items or a label narrow them
  const wide = a.command === "open" || a.command === "rank" || a.command === "cluster";
  if (wide && !a.items.length && !a.label && !a.seedsCsv) a.allOpen = true;
  if (a.allOpen && !a.budgetSet) a.maxNodes = 1000;
  if (a.command === "rank") a.prioritize = true;
  if (a.command === "cluster") a.cluster = true;
  a.open = a.openMode === "yes";
  if (!Number.isInteger(a.maxNodes) || a.maxNodes < 1 || a.maxNodes > 1000) {
    throw new UsageError("--budget must be an integer from 1 to 1000");
  }
  if (!Number.isInteger(a.concurrency) || a.concurrency < 1 || a.concurrency > 32) {
    throw new UsageError("--concurrency must be an integer from 1 to 32");
  }
  // reconcile's readable output is its Markdown report
  if (a.format === "text" && a.command === "reconcile") a.format = "markdown";
  if (a.format === "text" && !["graph", "plan", "open", "rank", "cluster"].includes(a.command)) {
    throw new UsageError(`${a.command} does not support --format human`);
  }
  if (a.apply && a.command !== "cluster")
    throw new UsageError("--apply belongs to issue-graph cluster");
  if (a.command === "plan" && (a.htmlOut || a.openMode === "yes")) {
    throw new UsageError("plan does not support --html or --open");
  }
  return a;
}

/** Whether a person is at the terminal: prompts and opening a browser need one. */
function interactive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY) && !process.env.CI;
}

/** The repository for a run: --repo or a scope, else the current directory's GitHub remote. */
function resolveRepo(a: Args, infer: () => string | undefined = inferRepo): string {
  const fromItem = a.items.find((i) => i.repo)?.repo;
  const repo = a.repo || fromItem || infer();
  if (!repo)
    throw new UsageError("no repository: pass owner/repo, or run inside a GitHub repository");
  return repo;
}

async function resolveSeeds(a: Args, transport: GhTransport): Promise<Seed[]> {
  const split = (full: string) => {
    const [owner, repo] = full.split("/");
    if (!owner || !repo) throw new UsageError("repository must be owner/repo");
    return { owner, repo };
  };
  if (a.items.length || (a.seed && !a.explicit)) {
    const needsRepo = a.items.some((i) => !i.repo);
    const fallback = needsRepo ? resolveRepo(a) : "";
    return a.items.map((i) => ({ ...split(i.repo || fallback), number: i.number }));
  }
  if (a.seedsCsv) {
    const { owner, repo } = split(resolveRepo(a));
    return a.seedsCsv.split(",").map((s) => ({ owner, repo, number: Number(s.trim()) }));
  }
  if (a.label) {
    const full = resolveRepo(a);
    const { owner, repo } = split(full);
    const numbers = await labelSeeds(transport, full, a.label, Math.min(a.maxNodes, 1000));
    return numbers.map((number) => ({ owner, repo, number }));
  }
  if (a.allOpen || a.command === "reconcile" || a.command === "plan") {
    const full = resolveRepo(a);
    const { owner, repo } = split(full);
    const limit = Math.min(a.maxNodes, 1000);
    const numbers =
      a.state === "all" && a.allOpen
        ? (await transport.search(`repo:${full}`, limit)).map((h) => h.number)
        : await openBacklogSeeds(transport, full, limit);
    if (a.allOpen && numbers.length >= limit) {
      process.stderr.write(
        `note: ${numbers.length} items seeded, the --budget limit; raise it (up to 1000) to include more\n`,
      );
    }
    return numbers.map((number) => ({ owner, repo, number }));
  }
  if (a.command === "graph")
    throw new UsageError("graph needs an item: issue-graph graph 123, or use issue-graph open");
  return [parseSeed(a.seed, a.repo)];
}

/** Suggest the views this run did not use, as commands to copy. */
export function nextSteps(a: Args, owner: string, repo: string): string {
  const full = `${owner}/${repo}`;
  const scope = a.label ? `${full} --label ${a.label}` : full;
  const lines: string[] = [];
  if (a.command !== "open" && !a.htmlOut && !a.open)
    lines.push(
      `- Open the dashboard (Swarm, Impact, Rank, Cleanup): \`issue-graph open ${scope}\``,
    );
  if (!a.cluster)
    lines.push(
      `- Group by root cause (your agent answers the task, then --apply): \`issue-graph cluster ${scope}\``,
    );
  if (!a.prioritize) lines.push(`- Rank what to fix first: \`issue-graph rank ${scope}\``);
  if ((a.command === "open" || a.htmlOut || a.open) && !a.noSnapshot)
    lines.push("- See every saved run in one dashboard: `issue-graph dashboard`");
  return lines.length ? `\n## Next steps\n\n${lines.join("\n")}\n` : "";
}

async function writeOutput(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  if (["query", "config"].includes(argv[0])) return runQueryCli(argv, openInBrowser);
  if (!argv.length) {
    // a person inside a GitHub repository gets its dashboard; scripts and CI keep the usage
    if (interactive() && inferRepo()) argv = ["open"];
    else {
      console.error(USAGE);
      process.exitCode = 2;
      return;
    }
  }
  if (argv[0] === "skills") {
    process.exitCode = await runSkills(argv.slice(1), {
      stdout: (value) => process.stdout.write(value),
      stderr: (value) => process.stderr.write(value),
    });
    return;
  }
  if (argv[0] === "status") {
    process.exitCode = await runStatus(statusArgs(argv.slice(1)), shellTransport(), {
      isTTY: Boolean(process.stdout.isTTY),
      noColor: process.env.NO_COLOR !== undefined || process.env.TERM === "dumb",
      ci: Boolean(process.env.CI),
      width: process.stdout.columns,
      stdout: (value) => process.stdout.write(value),
      stderr: (value) => process.stderr.write(value),
    });
    return;
  }
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return;
  }
  for (const d of new Set(args.deprecations)) process.stderr.write(`note: ${d}\n`);
  if (args.command === "runs") return runRuns(args);
  if (args.command === "cluster" && args.apply) return runApply(args);
  if (args.command === "auth") return runAuth(args);
  if (args.command === "dashboard") {
    const models = readDashboardModels<Model>();
    if (!models.length) {
      throw new UsageError(
        "no saved runs yet: run a graph with --open or --html first (without --no-snapshot)",
      );
    }
    const out = args.htmlOut || join(tmpdir(), `issue-graph-dashboard-${Date.now()}.html`);
    writeNextDashboard(out, models, modelDefaults(models));
    process.stderr.write(`wrote ${out} (${models.map((m) => m.label ?? m.repo).join(", ")})\n`);
    if (args.openMode === "yes" || (args.openMode === "auto" && interactive())) openInBrowser(out);
    return;
  }
  if (args.command === "schema") {
    console.log(JSON.stringify(ISSUE_GRAPH_SCHEMA, null, 2));
    return;
  }
  const human = (output: string, kind: "graph" | "plan") =>
    renderHumanOutput(output, {
      kind,
      width: process.stdout.columns,
      color:
        Boolean(process.stdout.isTTY) &&
        process.env.NO_COLOR === undefined &&
        !process.env.CI &&
        process.env.TERM !== "dumb",
    });
  const transport = shellTransport();
  const seeds = await resolveSeeds(args, transport);
  if (!seeds.length && args.command !== "reconcile" && args.command !== "plan") {
    console.error("no seeds resolved");
    process.exit(1);
  }

  const [fallbackOwner, fallbackRepo] = args.repo.split("/");
  const primary = seeds[0]
    ? { owner: seeds[0].owner, repo: seeds[0].repo }
    : { owner: fallbackOwner, repo: fallbackRepo };
  const multi = seeds.length > 1;
  process.stderr.write(
    seeds.length
      ? `crawling ${seeds.length} seed(s) in ${primary.owner}/${primary.repo} (depth ${args.depth}, max ${args.maxNodes} nodes, concurrency ${args.concurrency}, hub>${args.hubThreshold})\n`
      : `backlog empty in ${primary.owner}/${primary.repo}; no graph crawl needed\n`,
  );

  const { nodes, cappedOut } = seeds.length
    ? await crawl(
        seeds,
        {
          maxDepth: args.depth,
          maxNodes: args.maxNodes,
          hubThreshold: args.hubThreshold,
          concurrency: args.concurrency,
          primaryRepo: primary,
        },
        makeFetchNode(transport),
      )
    : { nodes: new Map(), cappedOut: new Set<NodeKey>() };
  classify(nodes);
  fillMentionedBy(nodes);

  const seedKeys = seeds.map((s) => `${s.owner}/${s.repo}#${s.number}`);
  if (args.command === "reconcile" || args.command === "plan") {
    const report = buildReconcileReport(nodes, {
      repo: `${primary.owner}/${primary.repo}`,
      seeds: seedKeys,
      seedLimit: Math.min(args.maxNodes, 1000),
      nodeCap: args.maxNodes,
      cappedOut,
    });
    const format =
      args.format === "auto"
        ? process.stdout.isTTY
          ? args.command === "plan"
            ? "text"
            : "markdown"
          : "json"
        : args.format;
    if (args.command === "plan") {
      const plan = buildPlanReport(
        report,
        nodes,
        prioritize(nodes, new Date(), resolveWeights(readConfig(), "github", report.repo)),
      );
      console.log(
        format === "json"
          ? JSON.stringify(plan, null, 2)
          : format === "text"
            ? human(renderPlan(plan), "plan")
            : renderPlan(plan),
      );
    } else {
      const dir = reconcileSnapshotDir(primary.owner, primary.repo);
      const previousFiles = listSnapshots(dir);
      const previousFile = previousFiles.at(-1);
      const previous = previousFile ? readReconcileSnapshot(`${dir}/${previousFile}`) : null;
      const snapshot = toReconcileSnapshot(report);
      if (previous) report.history = diffReconcileSnapshots(previous, snapshot);
      console.log(format === "json" ? JSON.stringify(report, null, 2) : renderReconcile(report));
      if (!args.noSnapshot) {
        const file = writeReconcileSnapshot(dir, snapshot);
        process.stderr.write(`\nsnapshot saved: ${file}\n`);
      }
    }
    return;
  }
  let md = render(nodes, seedKeys, multi);

  const weights = resolveWeights(readConfig(), "github", `${primary.owner}/${primary.repo}`);
  const priorities = prioritize(nodes, new Date(), weights);
  if (args.prioritize) md += renderPriority(priorities, weights);

  if (cappedOut.size) {
    md += `\n## Not crawled (node cap ${args.maxNodes} reached): ${cappedOut.size}\n\n`;
    md += `${[...cappedOut]
      .sort()
      .map((k) => `- ${k}`)
      .join("\n")}\n`;
  }

  // hub auto-suggest: each unexpanded hub becomes a one-command re-seed
  const hubs = [...nodes.values()].filter((n) => n.hub);
  if (hubs.length) {
    md += "\n## Hubs not expanded — re-seed to explore\n\n";
    for (const h of hubs) {
      md += `- ${h.key} (${h.edges.length} refs) → \`issue-graph graph ${h.owner}/${h.repo}#${h.number} --depth 1\`\n`;
    }
  }

  // temporal snapshot + diff
  const now = new Date().toISOString();
  const dir = snapshotDir(primary.owner, primary.repo, seedKeys);
  const prevFiles = listSnapshots(dir);
  const snap = toSnapshot(nodes, now);
  if (prevFiles.length) {
    const prev = readSnapshot(`${dir}/${prevFiles[prevFiles.length - 1]}`);
    if (prev) md += diffSnapshots(prev, snap);
  } else {
    md += "\n## Snapshot\n\n- first snapshot for this seed; re-run later to see changes\n";
  }

  const printGraph = (output: string) =>
    console.log(
      args.format === "text" || (args.format === "auto" && process.stdout.isTTY)
        ? human(output, "graph")
        : output,
    );
  const repoName = `${primary.owner}/${primary.repo}`;
  const own = [...nodes.values()].filter(
    (n) => `${n.owner}/${n.repo}` === repoName && n.state === "OPEN",
  );
  // open and cluster answer in JSON on request or in a pipe, like plan and reconcile
  const summarizes = args.command === "open" || args.command === "cluster";
  const machine =
    summarizes && (args.format === "json" || (args.format === "auto" && !process.stdout.isTTY));
  const say = (line: string) => {
    if (!machine) process.stdout.write(`${line}\n`);
  };
  const result: Record<string, unknown> = {
    schemaVersion: 1,
    command: args.command,
    repo: repoName,
    clusters: null,
    agent: null,
    prompt: null,
    error: null,
    dashboard: null,
    saved: false,
    opened: false,
  };
  if (args.command === "graph") printGraph(md + nextSteps(args, primary.owner, primary.repo));
  else if (args.command === "rank") {
    if (args.format === "json")
      console.log(JSON.stringify({ repo: repoName, weights, priorities }, null, 2));
    else
      printGraph(
        renderPriority(priorities, weights) + nextSteps(args, primary.owner, primary.repo),
      );
  } else {
    // open and cluster summarize; the full report stays one command away
    const linked = nodes.size - own.length;
    say(
      `${repoName} · ${own.length} open issues and PRs` +
        (linked
          ? ` (+${linked} linked${cappedOut.size ? `, ${cappedOut.size} not crawled` : ""})`
          : ""),
    );
    result.open = own.length;
    result.linked = linked;
    result.notCrawled = cappedOut.size;
  }

  const openAfter =
    args.openMode === "yes" ||
    (args.openMode === "auto" && args.command === "open" && interactive());
  const wantsHtml = Boolean(
    args.htmlOut || args.open || args.command === "open" || args.command === "cluster",
  );
  // open and cluster may use a detected agent, but only after a person agrees to send it data
  // the calling agent clusters in its own context; only a person at a terminal is offered
  // an installed agent, because nobody else is there to answer the task
  if (
    args.command === "open" &&
    !args.clusterRun &&
    args.agent !== "none" &&
    !args.clustersFile &&
    interactive()
  ) {
    const agent = await chooseAgent(own.length || nodes.size);
    if (agent) {
      args.clusterRun = agent;
      args.cluster = true;
    }
  }
  let agentClusters: ClustersConfig | undefined;
  if (args.clusterRun && wantsHtml) {
    process.stderr.write(`\nclustering via ${args.clusterRun}...\n`);
    try {
      const parsed = parseClustersReply(
        runAgent(args.clusterRun, clusterJsonPrompt(repoName, clusterPayload(nodes, seedKeys))),
      );
      agentClusters = parsed;
      result.agent = args.clusterRun;
      result.clusters = parsed.clusters.map((c) => ({
        label: c.label,
        rootCause: c.root_cause ?? null,
        members: c.members.length,
      }));
      if (summarizes) say(`${parsed.clusters.length} root causes via ${args.clusterRun}`);
      else
        console.log(`\n## Root-cause clusters (${args.clusterRun})\n\n${renderClusters(parsed)}\n`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.error = `agent '${args.clusterRun}' failed: ${msg}`;
      if (!machine)
        console.log(
          `\n## Root-cause clusters\n\n(agent '${args.clusterRun}' failed: ${msg}; the explorer falls back to connected components.)\n`,
        );
    }
  } else if (args.cluster) {
    const prompt = clusterPrompt(
      `${primary.owner}/${primary.repo}`,
      clusterPayload(nodes, seedKeys),
    );
    if (args.clusterRun) {
      process.stderr.write(`\nclustering via ${args.clusterRun}...\n`);
      try {
        printGraph(
          `\n## Root-cause clusters (${args.clusterRun})\n\n${runAgent(args.clusterRun, prompt).trim()}\n`,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        printGraph(
          `\n## Root-cause clusters\n\n(agent '${args.clusterRun}' failed: ${msg}. Prompt below.)\n`,
        );
        printGraph(`\`\`\`\n${prompt}\n\`\`\``);
      }
    } else if (args.command === "cluster") {
      // the handshake: the calling agent answers this in its own context, then applies it
      const task = clusterJsonPrompt(repoName, clusterPayload(nodes, seedKeys));
      const apply = `issue-graph cluster ${repoName} --apply -`;
      result.task = task;
      result.apply = apply;
      if (!machine) {
        printGraph("\n## Cluster task (answer it in your agent, then apply the JSON)\n");
        printGraph(`\`\`\`cluster-task\n${task}\n\`\`\``);
        say(`\napply the answer: ${apply} < answer.json`);
      }
    } else if (machine) result.prompt = prompt;
    else {
      printGraph("\n## Cluster step (run this prompt in your agent context)\n");
      printGraph(`\`\`\`cluster-prompt\n${prompt}\n\`\`\``);
    }
  }

  if (!args.noSnapshot) {
    const file = writeSnapshot(dir, snap);
    process.stderr.write(`\nsnapshot saved: ${file}\n`);
  }
  if (args.jsonOut) {
    await writeOutput(
      args.jsonOut,
      JSON.stringify(
        {
          seeds: seedKeys,
          depth: args.depth,
          nodes: [...nodes.values()],
          cappedOut: [...cappedOut],
          components: components(nodes),
          overlaps: fileOverlaps(nodes),
          priorities,
        },
        null,
        2,
      ),
    );
    process.stderr.write(`wrote ${args.jsonOut}\n`);
  }
  if (wantsHtml) {
    const clusters = args.clustersFile
      ? (JSON.parse(readFileSync(args.clustersFile, "utf8")) as ClustersConfig)
      : agentClusters;
    const out =
      args.htmlOut ||
      join(tmpdir(), `issue-graph-${primary.owner}-${primary.repo}-${Date.now()}.html`);
    const model = dashboardModel(nodes, seedKeys, repoName, clusters, cappedOut.size);
    try {
      model.openCount = await repositoryOpenCount(transport, primary.owner, primary.repo);
    } catch {
      process.stderr.write("Repository open totals unavailable; selector count will be unknown.\n");
    }
    writeNextDashboard(out, [model], modelDefaults([model]));
    if (args.command !== "open" && args.command !== "cluster")
      process.stderr.write(`wrote ${out}\n`);
    // keep the latest run per repository so `issue-graph dashboard` can switch between them
    if (!args.noSnapshot) {
      const saved = writeDashboardModel(repoName, model);
      if (args.command !== "open" && args.command !== "cluster")
        process.stderr.write(`dashboard run saved: ${saved}\n`);
    }
    result.dashboard = out;
    result.saved = !args.noSnapshot;
    if (openAfter) {
      openInBrowser(out);
      result.opened = true;
      say(`opened ${out}`);
    } else if (summarizes)
      say(`dashboard: ${out}${args.noSnapshot ? "" : " (also in issue-graph dashboard)"}`);
  }
  if (machine) {
    if (args.command === "open" && !result.clusters)
      result.next = `issue-graph cluster ${repoName}`;
    console.log(JSON.stringify(result, null, 2));
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Attach an agent's clusters to the saved run and rebuild its dashboard; no crawl. */
async function runApply(a: Args): Promise<void> {
  const repo = resolveRepo(a);
  const model = readDashboardModel<Model>(repo);
  if (!model)
    throw new UsageError(`no saved run for ${repo}: run issue-graph cluster ${repo} first`);
  const raw = a.apply === "-" ? await readStdin() : readFileSync(a.apply, "utf8");
  let parsed: ReturnType<typeof parseClustersReply>;
  try {
    parsed = parseClustersReply(raw);
  } catch (e) {
    throw new UsageError(
      `the answer is not usable: ${e instanceof Error ? e.message : String(e)}; expected {"clusters":[{"label","root_cause","members":[{"key"}]}],"cleanup":[{"key","text"}]}`,
    );
  }
  const { model: next, unknown } = applyClusters(model, parsed);
  if (unknown.length) {
    throw new UsageError(
      `the answer names ${unknown.length} item(s) this run does not contain (${unknown.slice(0, 5).join(", ")}${unknown.length > 5 ? ", …" : ""}); use keys exactly as the task lists them`,
    );
  }
  writeDashboardModel(repo, next);
  const out =
    a.htmlOut || join(tmpdir(), `issue-graph-${repo.replace("/", "-")}-${Date.now()}.html`);
  writeNextDashboard(out, [next], modelDefaults([next]));
  const opened = a.openMode === "yes" || (a.openMode === "auto" && interactive());
  if (opened) openInBrowser(out);
  const machine = a.format === "json" || (a.format === "auto" && !process.stdout.isTTY);
  const clusters = parsed.clusters.map((c) => ({
    label: c.label,
    rootCause: c.root_cause ?? null,
    members: c.members.length,
  }));
  if (machine)
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          command: "cluster",
          repo,
          applied: true,
          clusters,
          dashboard: out,
          saved: true,
          opened,
        },
        null,
        2,
      ),
    );
  else
    process.stdout.write(
      `${repo} · ${clusters.length} root causes applied\n${opened ? "opened" : "dashboard:"} ${out}\n`,
    );
}

/** A detected agent the person agreed to use, or undefined. Never asks without a terminal. */
async function chooseAgent(count: number): Promise<"claude" | "codex" | undefined> {
  const found = (["claude", "codex"] as const).find((name) => {
    try {
      execFileSync("which", [name], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  });
  if (!found) return undefined;
  if (!interactive()) {
    process.stderr.write(`note: pass --agent ${found} to group these by root cause\n`);
    return undefined;
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  let answer = "n";
  try {
    answer = await rl.question(
      `Group ${count} items by root cause with ${found}? Sends titles and links. (Y/n) `,
    );
  } catch {
    // Ctrl+D or a closed stdin is a no, not a crash
    process.stderr.write("\n");
  } finally {
    rl.close();
  }
  return /^(y|yes|)$/i.test(answer.trim()) ? found : undefined;
}

/** status keeps its own parser; a positional or inferred repository becomes --repo. */
export function statusArgs(argv: string[], infer: () => string | undefined = inferRepo): string[] {
  const out: string[] = [];
  let hasRepo = false;
  const valued = new Set([
    "--repo",
    "--author",
    "--view",
    "--format",
    "--concurrency",
    "--max-pages",
    "--since",
  ]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (valued.has(arg)) {
      if (arg === "--repo") hasRepo = true;
      out.push(arg, argv[++i]);
    } else if (!arg.startsWith("-")) {
      let sc: Scope;
      try {
        sc = parseScope(arg);
      } catch (e) {
        throw new UsageError(e instanceof Error ? e.message : String(e));
      }
      if (sc.kind !== "repo") throw new UsageError(`status takes repositories, not items: ${arg}`);
      out.push("--repo", sc.repo);
      hasRepo = true;
    } else out.push(arg);
  }
  if (!hasRepo && !argv.includes("--help") && !argv.includes("-h")) {
    const repo = infer();
    if (repo) out.push("--repo", repo);
  }
  return out;
}

function runRuns(a: Args): void {
  const [sub = "list", target] = a.rest;
  if (sub === "rm") {
    if (!target) throw new UsageError("runs rm needs a repository: issue-graph runs rm owner/repo");
    const repo = parseScope(target);
    if (repo.kind !== "repo") throw new UsageError("runs rm takes a repository");
    if (!removeDashboardRun(repo.repo)) throw new UsageError(`no saved run for ${repo.repo}`);
    process.stdout.write(`removed ${repo.repo}\n`);
    return;
  }
  if (sub !== "list") throw new UsageError(`unknown runs command: ${sub} (use list or rm)`);
  const runs = listDashboardRuns();
  if (a.format === "json") {
    console.log(
      JSON.stringify(
        runs.map(({ file: _f, ...r }) => r),
        null,
        2,
      ),
    );
    return;
  }
  if (!runs.length) {
    process.stdout.write("no saved runs yet: issue-graph open\n");
    return;
  }
  const w = Math.max(...runs.map((r) => r.repo.length));
  for (const r of runs)
    process.stdout.write(
      `${r.repo.padEnd(w)}  ${String(r.nodes).padStart(5)} items  ${r.savedAt.slice(0, 16).replace("T", " ")}\n`,
    );
}

function runAuth(a: Args): void {
  const [sub = "status"] = a.rest;
  if (sub !== "status") throw new UsageError(`unknown auth command: ${sub} (use status)`);
  let ok = true;
  try {
    execFileSync("gh", ["auth", "status"], { stdio: "ignore" });
  } catch {
    ok = false;
  }
  const rows = [{ provider: "github", signedIn: ok, via: "gh", fix: ok ? "" : "gh auth login" }];
  if (a.format === "json") console.log(JSON.stringify(rows, null, 2));
  else
    for (const r of rows)
      process.stdout.write(
        `${r.provider}  ${r.signedIn ? "signed in" : "not signed in"} via ${r.via}${r.fix ? `  (run: ${r.fix})` : ""}\n`,
      );
  if (!ok) process.exitCode = 1;
}

/** Best-effort: hand the file to the OS opener; the path is already printed. */
function openInBrowser(file: string): void {
  const [cmd, argv] =
    process.platform === "darwin"
      ? ["open", [file]]
      : process.platform === "win32"
        ? ["rundll32.exe", ["url.dll,FileProtocolHandler", file]]
        : ["xdg-open", [file]];
  try {
    spawn(cmd, argv, { detached: true, stdio: "ignore" })
      .on("error", () => {})
      .unref();
  } catch {
    // no opener available; the printed path still works
  }
}
