import { execFileSync } from "node:child_process";
import { kindTag } from "./render.js";
import type { ClusterNode, GraphNode, NodeKey } from "./types.js";

/**
 * The clustering step is the agent's job, not the CLI's. The CLI emits a prompt
 * plus this compact payload; the calling agent answers it in its own context
 * (no API key baked in, no extra cost). `--cluster-run` shells out to a headless
 * agent instead, for unattended use.
 */
export function clusterPayload(nodes: Map<NodeKey, GraphNode>, seedKeys: NodeKey[]): ClusterNode[] {
  return [...nodes.values()]
    .filter((n) => n.state === "OPEN" || seedKeys.includes(n.key))
    .map((n) => ({
      key: n.key,
      kind: kindTag(n.kind),
      state: n.state,
      title: n.title,
      verdict: n.verdict,
      // adjacency lets the agent cluster by shared structure, not just titles
      edges: n.edges.map((e) => `${e.via} ${e.to}`),
    }));
}

/** Build the root-cause clustering prompt handed to the agent. */
export function clusterPrompt(repo: string, payload: ClusterNode[]): string {
  const lines = payload
    .map((p) => {
      const rel = p.edges.length ? `  [${p.edges.join("; ")}]` : "";
      return `- ${p.key} | ${p.kind} | ${p.state} | ${p.title}${rel}`;
    })
    .join("\n");
  return [
    `You are triaging the GitHub reference graph of ${repo}. Below are the open (and seed) nodes reachable from the seed(s).`,
    "Each node lists its edges in [brackets] (closes/mentions/cross-ref/connected → target).",
    "Group them into ROOT-CAUSE CLUSTERS: sets that share one underlying defect or theme.",
    "Cluster by the edge structure and the defect it implies — shared closing targets, mutual references, a common subsystem — NOT by title-keyword overlap.",
    "",
    "OUTPUT (markdown, terse), in two layers:",
    "1. An **index** table, one row per cluster: `Cluster | Root cause (one line) | # | Action`.",
    '   Action is one of: "one fix closes all" / "needs tracking issue" / "close superseded" / "independent".',
    "2. Then a section per cluster: `### Cluster N — <label>` followed by a NARROW table with columns",
    "   `Issue | State | PR | Verdict`. One row per member. In the PR column name the associated PR(s);",
    "   in Verdict be decisive and name the person: e.g. `close #349 — credit @ahfoysal, keep merged #352`,",
    "   `review/merge #300 (credit @EfeDurmaz16)`, or `duplicate of #X — pick one`.",
    "   Do NOT put a comma-separated member list in one cell — one issue per row.",
    "Finally, a **Cleanup** list: every node to close/supersede, each with the exact PR and the @author to credit.",
    "",
    "NODES:",
    lines,
  ].join("\n");
}

/** Shell out to a headless coding agent to run the clustering prompt. */
export function runAgent(agent: string, prompt: string): string {
  const opts = { input: prompt, encoding: "utf8" as const, maxBuffer: 16 * 1024 * 1024 };
  if (agent === "claude") return execFileSync("claude", ["-p"], opts);
  if (agent === "codex") return execFileSync("codex", ["exec", "-"], opts);
  throw new Error(`unknown agent: ${agent} (use claude|codex)`);
}

/**
 * The same clustering task, answered as the `--clusters` JSON the explorer
 * reads, so `--cluster-run` can feed the dashboard without a manual step.
 */
export function clusterJsonPrompt(repo: string, payload: ClusterNode[]): string {
  const base = clusterPrompt(repo, payload);
  const nodes = base.slice(base.indexOf("NODES:"));
  const intro = base.slice(0, base.indexOf("OUTPUT (markdown"));
  return [
    intro.trimEnd(),
    "",
    "OUTPUT: only one JSON object, no prose and no code fence:",
    '{"clusters":[{"label":"short name, at most 24 characters","root_cause":"one line","members":[{"key":"<exact node key>","verdict":"optional decisive verdict naming the @author to credit"}]}],',
    ' "cleanup":[{"key":"<node key>","text":"close, supersede, or retest action with the @author to credit"}]}',
    "Put every node key below in exactly one cluster, spelled exactly as listed.",
    "",
    nodes,
  ].join("\n");
}

/** Pull the clusters object out of an agent reply; throws when it is not there. */
export function parseClustersReply(reply: string): {
  clusters: ClusterReply[];
  cleanup: Array<{ key?: string; text: string }>;
} {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("agent reply has no JSON object");
  const parsed = JSON.parse(reply.slice(start, end + 1)) as {
    clusters?: unknown;
    cleanup?: unknown;
  };
  if (!Array.isArray(parsed.clusters)) throw new Error("agent reply has no clusters array");
  return {
    clusters: parsed.clusters as ClusterReply[],
    cleanup: Array.isArray(parsed.cleanup)
      ? (parsed.cleanup as Array<{ key?: string; text: string }>)
      : [],
  };
}

export interface ClusterReply {
  label: string;
  root_cause?: string;
  members: Array<{ key: NodeKey; verdict?: string }>;
}

/** Terminal summary of parsed clusters, one line per cluster. */
export function renderClusters(c: { clusters: ClusterReply[]; cleanup: unknown[] }): string {
  const rows = c.clusters.map(
    (k) => `| ${k.label} | ${k.root_cause ?? ""} | ${k.members.length} |`,
  );
  return [
    "| Cluster | Root cause | # |",
    "| --- | --- | --- |",
    ...rows,
    "",
    `${c.cleanup.length} cleanup actions.`,
  ].join("\n");
}
