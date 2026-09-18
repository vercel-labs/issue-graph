#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { classify, fillMentionedBy } from "./classify.js";
import { clusterPayload, clusterPrompt, runAgent } from "./cluster.js";
import { components, crawl } from "./crawl.js";
import { labelSeeds, makeFetchNode, openBacklogSeeds } from "./github.js";
import { type ClustersConfig, renderHtml } from "./html.js";
import { fileOverlaps } from "./overlaps.js";
import { buildPlanReport, renderPlan } from "./plan.js";
import { prioritize, renderPriority } from "./priority.js";
import { buildReconcileReport, renderReconcile } from "./reconcile.js";
import { parseSeed } from "./refs.js";
import { render } from "./render.js";
import { ISSUE_GRAPH_SCHEMA } from "./schema.js";
import {
  diffReconcileSnapshots,
  diffSnapshots,
  listSnapshots,
  readReconcileSnapshot,
  readSnapshot,
  reconcileSnapshotDir,
  snapshotDir,
  toReconcileSnapshot,
  toSnapshot,
  writeReconcileSnapshot,
  writeSnapshot,
} from "./snapshot.js";
import { runStatus, StatusUsageError } from "./status-cli.js";
import type { GhTransport } from "./transport.js";
import { shellTransport } from "./transports/shell.js";
import type { NodeKey, Seed } from "./types.js";

const USAGE = `usage: issue-graph <url|number> --repo owner/repo [options]
       issue-graph --seeds 1,2,3 --repo owner/repo [options]
       issue-graph --label bug --repo owner/repo [options]
       issue-graph reconcile --repo owner/repo [options]
       issue-graph plan --repo owner/repo [options]
       issue-graph status --repo owner/repo --author login[,login] [options]
       issue-graph schema

  status --help      PR counts by author/project and an evidence ledger
  --repo owner/repo   required for a bare number, --seeds, or --label
  --depth N           same-repo recursion depth (default 2); cross-repo refs
                      are fetched one hop and not expanded
  --seeds a,b,c       multi-seed backlog survey; adds connected components
  --label L           seed from every open issue carrying this label
  --max-nodes N       stop after this many nodes (default 80)
  --hub-threshold N   fetch but do not expand a node with more refs than this
                      (default 12), so one tracking issue cannot pull the
                      whole tracker
  --concurrency N     GitHub node requests in flight (default 4, max 32)
  --prioritize        rank open nodes by discussion heat
  --cluster           print a root-cause clustering prompt for your agent
  --cluster-run A     run that prompt through 'claude' or 'codex' instead
  --json PATH         write the machine-readable graph
  --html PATH         graph only: write a self-contained HTML explorer
  --clusters PATH     group the explorer by agent-named clusters
  --format F          reconcile/plan output: auto, json, or markdown (default auto)
  --no-snapshot       do not persist this run to ~/.issue-graph/
  -h, --help          show this`;

interface Args {
  command: "graph" | "reconcile" | "plan" | "schema";
  seed: string;
  repo: string;
  depth: number;
  jsonOut: string;
  htmlOut: string;
  clustersFile: string;
  seedsCsv: string;
  label: string;
  maxNodes: number;
  hubThreshold: number;
  concurrency: number;
  cluster: boolean;
  clusterRun: string;
  noSnapshot: boolean;
  prioritize: boolean;
  format: "auto" | "json" | "markdown";
  help: boolean;
}

export class UsageError extends Error {}

export function parseArgs(argv: string[]): Args {
  const command =
    argv[0] === "reconcile" || argv[0] === "plan" || argv[0] === "schema" ? argv[0] : "graph";
  const start = command === "graph" ? 0 : 1;
  const a: Args = {
    command,
    seed: "",
    repo: "",
    depth: 2,
    jsonOut: "",
    htmlOut: "",
    clustersFile: "",
    seedsCsv: "",
    label: "",
    maxNodes: 80,
    hubThreshold: 12,
    concurrency: 4,
    cluster: false,
    clusterRun: "",
    noSnapshot: false,
    prioritize: false,
    format: "auto",
    help: false,
  };
  for (let i = start; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") a.help = true;
    else if (arg === "--repo") a.repo = argv[++i];
    else if (arg === "--depth") a.depth = Number(argv[++i]);
    else if (arg === "--json") a.jsonOut = argv[++i];
    else if (arg === "--html") a.htmlOut = argv[++i];
    else if (arg === "--clusters") a.clustersFile = argv[++i];
    else if (arg === "--seeds") a.seedsCsv = argv[++i];
    else if (arg === "--label") a.label = argv[++i];
    else if (arg === "--max-nodes") a.maxNodes = Number(argv[++i]);
    else if (arg === "--hub-threshold") a.hubThreshold = Number(argv[++i]);
    else if (arg === "--concurrency") a.concurrency = Number(argv[++i]);
    else if (arg === "--format") {
      const format = argv[++i];
      if (format !== "auto" && format !== "json" && format !== "markdown") {
        throw new UsageError(`unknown format: ${format}\n\n${USAGE}`);
      }
      a.format = format;
    } else if (arg === "--prioritize") a.prioritize = true;
    else if (arg === "--cluster") a.cluster = true;
    else if (arg === "--cluster-run") {
      a.cluster = true;
      a.clusterRun = argv[++i];
    } else if (arg === "--no-snapshot") a.noSnapshot = true;
    // An unrecognized flag used to fall through to the seed, so a typo became
    // "Cannot parse seed: --hlep" — and `--help` crashed the same way.
    else if (arg.startsWith("-")) throw new UsageError(`unknown flag: ${arg}\n\n${USAGE}`);
    else a.seed = arg;
  }
  if (!Number.isInteger(a.maxNodes) || a.maxNodes < 1 || a.maxNodes > 1000) {
    throw new UsageError("--max-nodes must be an integer from 1 to 1000");
  }
  if (!Number.isInteger(a.concurrency) || a.concurrency < 1 || a.concurrency > 32) {
    throw new UsageError("--concurrency must be an integer from 1 to 32");
  }
  if (a.command === "plan" && a.htmlOut) {
    throw new UsageError("plan does not support --html");
  }
  return a;
}

async function resolveSeeds(a: Args, transport: GhTransport): Promise<Seed[]> {
  if (a.label) {
    if (!a.repo) throw new UsageError("--label needs --repo");
    const [owner, repo] = a.repo.split("/");
    const numbers = await labelSeeds(transport, a.repo, a.label, Math.min(a.maxNodes, 1000));
    return numbers.map((number) => ({ owner, repo, number }));
  }
  if (a.seedsCsv) {
    if (!a.repo) throw new UsageError("--seeds needs --repo");
    const [owner, repo] = a.repo.split("/");
    return a.seedsCsv.split(",").map((s) => ({ owner, repo, number: Number(s.trim()) }));
  }
  if (a.command === "reconcile" || a.command === "plan") {
    if (!a.repo) throw new UsageError(`${a.command} needs --repo`);
    const [owner, repo] = a.repo.split("/");
    if (!owner || !repo) throw new UsageError("--repo must be owner/repo");
    const numbers = await openBacklogSeeds(transport, a.repo, Math.min(a.maxNodes, 1000));
    return numbers.map((number) => ({ owner, repo, number }));
  }
  return [parseSeed(a.seed, a.repo)];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (!argv.length) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  if (argv[0] === "status") {
    process.exitCode = await runStatus(argv.slice(1), shellTransport(), {
      isTTY: Boolean(process.stdout.isTTY),
      noColor: process.env.NO_COLOR !== undefined,
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
  if (args.command === "schema") {
    console.log(JSON.stringify(ISSUE_GRAPH_SCHEMA, null, 2));
    return;
  }
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
      args.format === "auto" ? (process.stdout.isTTY ? "markdown" : "json") : args.format;
    if (args.command === "plan") {
      const plan = buildPlanReport(report, nodes, prioritize(nodes, new Date()));
      console.log(format === "json" ? JSON.stringify(plan, null, 2) : renderPlan(plan));
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

  const priorities = prioritize(nodes, new Date());
  if (args.prioritize) md += renderPriority(priorities);

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
      md += `- ${h.key} (${h.edges.length} refs) → \`issue-graph ${h.number} --repo ${h.owner}/${h.repo} --depth 1\`\n`;
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

  console.log(md);

  if (args.cluster) {
    const prompt = clusterPrompt(
      `${primary.owner}/${primary.repo}`,
      clusterPayload(nodes, seedKeys),
    );
    if (args.clusterRun) {
      process.stderr.write(`\nclustering via ${args.clusterRun}...\n`);
      try {
        console.log(
          `\n## Root-cause clusters (${args.clusterRun})\n\n${runAgent(args.clusterRun, prompt).trim()}\n`,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.log(
          `\n## Root-cause clusters\n\n(agent '${args.clusterRun}' failed: ${msg}. Prompt below.)\n`,
        );
        console.log(`\`\`\`\n${prompt}\n\`\`\``);
      }
    } else {
      console.log("\n## Cluster step (run this prompt in your agent context)\n");
      console.log(`\`\`\`cluster-prompt\n${prompt}\n\`\`\``);
    }
  }

  if (!args.noSnapshot) {
    const file = writeSnapshot(dir, snap);
    process.stderr.write(`\nsnapshot saved: ${file}\n`);
  }
  if (args.jsonOut) {
    Bun.write(
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
  if (args.htmlOut) {
    const clusters = args.clustersFile
      ? (JSON.parse(readFileSync(args.clustersFile, "utf8")) as ClustersConfig)
      : undefined;
    Bun.write(
      args.htmlOut,
      renderHtml(nodes, seedKeys, `${primary.owner}/${primary.repo}`, clusters),
    );
    process.stderr.write(`wrote ${args.htmlOut}\n`);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    // A transport failure must not look like an empty backlog: exit non-zero so
    // a scripted caller notices.
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(err instanceof UsageError || err instanceof StatusUsageError ? 2 : 1);
  });
}
