import { isSupersededVerdict } from "./classify.js";
import { components } from "./crawl.js";
import { dashboardScript } from "./dashboard-client.js";
import { DASHBOARD_CSS } from "./dashboard-style.js";
import type {
  OpenItemCount,
  ReadCoverage,
  RelationshipEvidence,
  WorkLink,
} from "./dashboard-types.js";
import { fileOverlaps } from "./overlaps.js";
import { prioritize } from "./priority.js";
import type { Weights } from "./scoring.js";
import type { GraphNode, NodeKey } from "./types.js";

/** Optional semantic clustering supplied by the calling agent (`--clusters`). */
export interface ClusterInput {
  label: string;
  root_cause?: string;
  members: Array<{ key: NodeKey; verdict?: string }>;
}

/** One actionable cleanup line: close/supersede/retest, with credit. */
export interface CleanupItem {
  /** Node this action targets, so the UI can link to it. */
  key?: NodeKey;
  text: string;
}

/**
 * The `--clusters` file is either a bare `ClusterInput[]` or an object that
 * also carries a global `cleanup` checklist (the actionable close/credit list).
 */
export type ClustersConfig = ClusterInput[] | { clusters: ClusterInput[]; cleanup?: CleanupItem[] };

function normalizeClusters(c?: ClustersConfig): {
  clusters: ClusterInput[];
  cleanup: CleanupItem[];
} {
  if (!c) return { clusters: [], cleanup: [] };
  const raw = Array.isArray(c) ? c : (c.clusters ?? []);
  // a hand-written or agent-written file can be malformed; skip entries without members
  const clusters = raw.filter((k) => k && Array.isArray(k.members));
  const cleanup = Array.isArray(c) ? [] : Array.isArray(c.cleanup) ? c.cleanup : [];
  return { clusters, cleanup };
}

/** A group in the left tree: a connected component, or an agent-named cluster. */
export interface Group {
  label: string;
  subtitle: string;
  members: NodeKey[];
}

/** The compact, self-contained model embedded in the page for the client app. */
/**
 * What the explorer needs to know about the source of the data. Views read the
 * normalized model; only the sidebar slot and links read the descriptor.
 */
export interface ProviderDescriptor {
  id: string;
  name: string;
  /** Inline SVG mark; uses currentColor. */
  logo: string;
  /** Web URL of a repository, from its owner/repo name. */
  repoUrl: string;
  /** Signals only this provider has, shown in the sidebar's provider slot. */
  signals: Array<{ id: string; label: string; tone: "warn" | "danger" }>;
  views?: Array<"explore" | "impact" | "swarm" | "rank">;
  metrics?: Array<"heat" | "links" | "blast" | "depth">;
  filters?: Array<"solution" | "review">;
}

export interface Model {
  notCrawled?: number;
  id?: string;
  label?: string;
  url?: string;
  openCount?: OpenItemCount;
  grouping?: "components" | "themes";
  provider: ProviderDescriptor;
  repo: string;
  seeds: NodeKey[];
  groups: Group[];
  cleanup: CleanupItem[];
  stats: Record<string, number>;
  nodes: Record<NodeKey, ClientNode>;
  coverage?: {
    complete: boolean;
    generatedAt: string;
    maxDepth: number;
    messages: string[];
    warnings?: string[];
  };
}

export interface ClientNode {
  repo: string;
  key: NodeKey;
  num: number;
  identifier?: string;
  kind: "PullRequest" | "Issue" | "Unknown";
  state: string;
  stateLabel?: string;
  stateType?: string;
  archived?: boolean;
  read?: { fetched: boolean; error?: string; coverage: ReadCoverage[] };
  attachments?: WorkLink[];
  title: string;
  url: string;
  author?: string;
  depth: number;
  seed: boolean;
  flags: string[];
  verdict?: string;
  mentionedBy: string[];
  external: string[];
  pr?: {
    draft: boolean;
    review: string;
    mergeable: string;
    updated: string;
    adds: number;
    dels: number;
    files: number;
  };
  /** Raw triage signals from prioritize(); open, fetched nodes only. */
  heat?: {
    comments: number;
    participants: number;
    reactions: number;
    daysOpen: number;
    inboundRefs: number;
  };
  out: Array<{
    to: NodeKey;
    via: string;
    by?: string;
    at?: string;
    undirected?: boolean;
    evidence?: RelationshipEvidence;
  }>;
  in: Array<{ from: NodeKey; via: string; by?: string; evidence?: RelationshipEvidence }>;
  overlaps: Array<{ with: NodeKey; shared: string[]; significant: number; sharedIssue?: NodeKey }>;
}

function shortKey(k: NodeKey): string {
  const n = k.split("#")[1];
  return n ? `#${n}` : k;
}

function buildModel(
  nodes: Map<NodeKey, GraphNode>,
  seedKeys: NodeKey[],
  repo: string,
  clusters: ClusterInput[],
  cleanup: CleanupItem[],
): Model {
  const seeds = new Set(seedKeys);

  // invert edges once
  const inbound = new Map<NodeKey, Array<{ from: NodeKey; via: string; by?: string }>>();
  for (const n of nodes.values())
    for (const e of n.edges) {
      const list = inbound.get(e.to) ?? [];
      list.push({ from: n.key, via: e.via, by: e.by });
      inbound.set(e.to, list);
    }

  // attach overlaps to both endpoints
  const overlapsBy = new Map<NodeKey, ClientNode["overlaps"]>();
  for (const o of fileOverlaps(nodes)) {
    (overlapsBy.get(o.a) ?? overlapsBy.set(o.a, []).get(o.a))?.push({
      with: o.b,
      shared: o.shared,
      significant: o.significant,
      sharedIssue: o.sharedIssue,
    });
    (overlapsBy.get(o.b) ?? overlapsBy.set(o.b, []).get(o.b))?.push({
      with: o.a,
      shared: o.shared,
      significant: o.significant,
      sharedIssue: o.sharedIssue,
    });
  }

  const heat = new Map(prioritize(nodes, new Date()).map((r) => [r.key, r]));
  const clientNodes: Record<NodeKey, ClientNode> = {};
  for (const n of nodes.values()) {
    clientNodes[n.key] = {
      key: n.key,
      num: n.number,
      identifier: n.identifier,
      repo: `${n.owner}/${n.repo}`,
      kind: n.kind,
      state: n.state,
      title: n.title,
      url: n.url,
      author: n.author,
      depth: n.depth,
      seed: seeds.has(n.key),
      flags: n.flags ?? [],
      verdict: n.verdict,
      mentionedBy: n.mentionedBy ?? [],
      external: n.externalLinks,
      pr: n.pr
        ? {
            draft: n.pr.isDraft,
            review: n.pr.reviewDecision || "none",
            mergeable: n.pr.mergeable,
            updated: n.pr.updatedAt.slice(0, 10),
            adds: n.pr.additions,
            dels: n.pr.deletions,
            files: n.pr.changedFiles,
          }
        : undefined,
      heat: (() => {
        const h = heat.get(n.key);
        return h
          ? {
              comments: h.comments,
              participants: h.participants,
              reactions: h.reactions,
              daysOpen: h.daysOpen,
              inboundRefs: h.inboundRefs,
            }
          : undefined;
      })(),
      out: n.edges.map((e) => ({
        to: e.to,
        via: e.via,
        by: e.by,
        at: e.at,
        undirected: e.undirected,
      })),
      in: inbound.get(n.key) ?? [],
      overlaps: overlapsBy.get(n.key) ?? [],
    };
  }

  // groups: agent clusters if supplied, else deterministic connected components
  let groups: Group[];
  if (clusters.length) {
    const seen = new Set<NodeKey>();
    groups = clusters.map((c) => {
      const members = c.members.map((m) => m.key).filter((k) => clientNodes[k]);
      for (const m of c.members) {
        seen.add(m.key);
        const cn = clientNodes[m.key];
        if (cn && m.verdict) cn.verdict = m.verdict; // cluster verdict wins
      }
      return { label: c.label, subtitle: c.root_cause ?? "", members };
    });
    const rest = [...nodes.keys()].filter((k) => !seen.has(k));
    if (rest.length) groups.push({ label: "Ungrouped", subtitle: "no cluster", members: rest });
  } else {
    groups = components(nodes).map((c, i) => {
      const members = c
        .map((k) => nodes.get(k))
        .filter((n): n is GraphNode => !!n)
        .sort((a, b) => a.depth - b.depth || a.key.localeCompare(b.key));
      const hub = members.slice().sort((a, b) => b.edges.length - a.edges.length)[0];
      return {
        label: `Component ${i + 1}`,
        subtitle: hub ? `hub ${hub.identifier ?? shortKey(hub.key)} — ${hub.title}` : "",
        members: members.map((m) => m.key),
      };
    });
  }

  const all = [...nodes.values()];
  const openPRs = all.filter((n) => n.state === "OPEN" && n.kind === "PullRequest");
  const stats = {
    nodes: nodes.size,
    openPRs: openPRs.length,
    openIssues: all.filter((n) => n.state === "OPEN" && n.kind === "Issue").length,
    superseded: openPRs.filter((n) => isSupersededVerdict(n.verdict)).length,
    competing: openPRs.filter((n) => n.flags?.some((f) => f.startsWith("competes"))).length,
    noClose: openPRs.filter((n) => n.flags?.some((f) => f.includes("no closing link"))).length,
    overlaps: fileOverlaps(nodes).length,
  };

  return {
    provider: GITHUB,
    repo,
    grouping: clusters.length ? "themes" : "components",
    seeds: seedKeys,
    groups,
    cleanup,
    stats,
    nodes: clientNodes,
  };
}

/** Render the graph as a self-contained, Geist-styled master–detail explorer. */
/**
 * Group a saved run by an agent's clusters without re-crawling. Same rules as
 * buildModel: members must exist in the run, a cluster verdict wins, and items
 * no cluster names land in Ungrouped. Keys the run does not contain are returned
 * so the caller can tell the agent which ones to fix.
 */
export function applyClusters(
  model: Model,
  config: ClustersConfig,
): { model: Model; unknown: NodeKey[] } {
  const { clusters, cleanup } = normalizeClusters(config);
  const nodes: Record<NodeKey, ClientNode> = {};
  for (const [k, n] of Object.entries(model.nodes)) nodes[k] = { ...n };
  const seen = new Set<NodeKey>();
  const unknown = new Set<NodeKey>();
  const groups: Group[] = clusters.map((c) => {
    for (const m of c.members) {
      seen.add(m.key);
      const n = nodes[m.key];
      if (!n) unknown.add(m.key);
      else if (m.verdict) n.verdict = m.verdict;
    }
    return {
      label: c.label,
      subtitle: c.root_cause ?? "",
      members: c.members.map((m) => m.key).filter((k) => nodes[k]),
    };
  });
  const rest = Object.keys(nodes).filter((k) => !seen.has(k));
  if (rest.length) groups.push({ label: "Ungrouped", subtitle: "no cluster", members: rest });
  for (const c of cleanup) if (c.key && !nodes[c.key]) unknown.add(c.key);
  return {
    model: {
      ...model,
      nodes,
      groups,
      grouping: "themes",
      cleanup: cleanup.filter((c) => !c.key || nodes[c.key]),
    },
    unknown: [...unknown],
  };
}

/** The explorer's data for one run, also what `dashboard` saves and reloads. */
export function dashboardModel(
  nodes: Map<NodeKey, GraphNode>,
  seedKeys: NodeKey[],
  repo: string,
  clustersConfig?: ClustersConfig,
  notCrawled = 0,
  provider?: ProviderDescriptor,
): Model {
  const { clusters, cleanup } = normalizeClusters(clustersConfig);
  return {
    ...buildModel(nodes, seedKeys, repo, clusters, cleanup),
    ...(provider ? { provider } : {}),
    notCrawled,
  };
}

export function renderHtml(
  nodes: Map<NodeKey, GraphNode>,
  seedKeys: NodeKey[],
  repo: string,
  clustersConfig?: ClustersConfig,
): string {
  return renderDashboard([dashboardModel(nodes, seedKeys, repo, clustersConfig)]);
}

/** One explorer over several runs; the first model opens unless the URL names another. */
export function renderDashboard(
  models: Model[],
  options: { weights?: Record<string, Weights> } = {},
): string {
  if (!models.length) throw new Error("renderDashboard needs at least one model");
  const repo = models[0].repo;
  // JSON is safe inside <script> once "<" is escaped (prevents </script> break-out).
  const data = JSON.stringify({ projects: models, defaults: options.weights ?? {} }).replace(
    /</g,
    "\\u003c",
  );
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>issue-graph · ${repo.replace(/</g, "&lt;")}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500&family=Geist:wght@400;500;600&display=swap" rel="stylesheet"/>
<style>${DASHBOARD_CSS}</style>
</head>
<body>
<div id="app"></div>
<script id="data" type="application/json">${data}</script>
<script>${dashboardScript()}</script>
</body>
</html>`;
}

const GITHUB_SVG =
  '<svg class="gh-mark" aria-hidden="true" viewBox="0 0 16 16"><g><path clip-rule="evenodd" d="M8 .13c-4.42 0-8 3.6-8 8.07 0 3.57 2.3 6.58 5.47 7.65.4.08.55-.17.55-.39L6 13.96c-2.23.49-2.7-.95-2.7-.95-.35-.94-.88-1.18-.88-1.18-.73-.5.05-.5.05-.5.8.06 1.23.84 1.23.84.72 1.22 1.87.88 2.33.66.07-.52.28-.88.5-1.08-1.77-.19-3.64-.88-3.64-3.98 0-.88.32-1.6.82-2.16-.07-.2-.35-1.03.08-2.14 0 0 .68-.21 2.2.83a7.7 7.7 0 0 1 4 0c1.53-1.04 2.2-.83 2.2-.83.45 1.11.17 1.94.09 2.14.52.56.82 1.28.82 2.16 0 3.1-1.87 3.78-3.66 3.98.3.26.54.74.54 1.5v2.21c0 .22.14.47.54.4A8.1 8.1 0 0 0 16 8.2 8 8 0 0 0 8 .13" fill="currentColor" fill-rule="evenodd"></path></g></svg>';

const GITHUB: ProviderDescriptor = {
  id: "github",
  name: "GitHub",
  logo: GITHUB_SVG,
  repoUrl: "https://github.com/{repo}",
  filters: ["solution", "review"],
  signals: [
    { id: "superseded", label: "Superseded", tone: "warn" },
    { id: "competing", label: "Competing", tone: "warn" },
    { id: "noClose", label: "No close link", tone: "danger" },
  ],
};
