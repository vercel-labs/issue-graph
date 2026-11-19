import type { ClientNode, Model, ProviderDescriptor } from "./html.js";
import { workClusterGroups } from "./work-clusters.js";
import type { WorkReport } from "./work-report.js";
import type { WorkEdge, WorkNode } from "./work-types.js";

export const THEMES_NOTE =
  "Themes are proposed groupings, not verified common root causes. Native relationships are unchanged.";

/** How one provider's report becomes a dashboard model. */
export interface WorkDashboardView<TNode extends WorkNode> {
  id: string;
  label: string;
  url?: string;
  openCount?: Model["openCount"];
  provider: Omit<ProviderDescriptor, "signals" | "views" | "metrics">;
  repo: string;
  /** What the provider calls a node in coverage warnings: "issues" or "items". */
  noun: string;
  /** Nodes left out of this view, such as Linear issues from another project. */
  include?(node: TNode): boolean;
  node(
    node: TNode,
  ): Pick<ClientNode, "repo" | "kind" | "state"> &
    Partial<Pick<ClientNode, "stateLabel" | "archived" | "external" | "attachments">>;
  /** Dashboard labels for an edge as seen from its source and from its target. */
  edgeLabels(edge: WorkEdge): [string, string];
  /** Extra coverage warnings, after the per-bucket counts. */
  warnings?: string[];
  /** Every coverage message: source, scope, and limitations. */
  messages: string[];
  /** Counts a dashboard node as an open issue in the stats. */
  openIssue?(node: ClientNode): boolean;
}

/** Shared relationship labels; a provider handles its own relations first. */
export function workEdgeLabels(edge: WorkEdge): [string, string] {
  if (edge.relation === "blocks") return ["blocks", "blocked by"];
  if (edge.relation === "duplicate_of") return ["duplicates", "duplicated by"];
  if (edge.relation === "parent_of") return ["parent of", "child of"];
  return [edge.nativeRelation, `${edge.nativeRelation} (incoming)`];
}

/** Builds the dashboard model for one work provider run. */
export function workDashboardModel<TNode extends WorkNode>(
  report: WorkReport<TNode>,
  view: WorkDashboardView<TNode>,
  clusters?: unknown,
): Model & { id: string } {
  const seeds = new Set(report.seeds);
  const nodes: Record<string, ClientNode> = {};
  for (const node of report.nodes) {
    if (view.include && !view.include(node)) continue;
    const shown = view.node(node);
    nodes[node.key] = {
      key: node.key,
      num: 0,
      identifier: node.identifier,
      repo: shown.repo,
      kind: shown.kind,
      state: shown.state,
      stateLabel: shown.stateLabel ?? node.state.name,
      stateType: node.state.type,
      archived: shown.archived ?? false,
      read: { fetched: node.fetched, error: node.error, coverage: node.coverage },
      title: node.title,
      url: node.url,
      depth: node.depth,
      seed: seeds.has(node.key),
      flags: [
        ...(node.hub ? ["Hub not expanded"] : []),
        ...(!node.fetched ? [`${view.noun === "items" ? "Item" : "Issue"} unavailable`] : []),
        ...(node.coverage.some((part) => !part.complete) ? ["Incomplete connections"] : []),
      ],
      mentionedBy: [],
      external: shown.external ?? node.externalLinks.map((link) => link.url),
      attachments: shown.attachments ?? node.externalLinks,
      out: [],
      in: [],
      overlaps: [],
    };
  }
  const seen = new Set<string>();
  for (const node of report.nodes) {
    for (const edge of node.edges) {
      let from = edge.direction === "incoming" ? edge.to : node.key;
      let to = edge.direction === "incoming" ? node.key : edge.to;
      const undirected = edge.direction === "undirected";
      if (undirected && from > to) [from, to] = [to, from];
      const key = JSON.stringify([from, to, edge.nativeRelation, edge.evidence]);
      if (seen.has(key)) continue;
      seen.add(key);
      const [outLabel, inLabel] = view.edgeLabels(edge);
      nodes[from]?.out.push({ to, via: outLabel, undirected, evidence: edge.evidence });
      if (undirected)
        nodes[to]?.out.push({ to: from, via: outLabel, undirected: true, evidence: edge.evidence });
      else nodes[to]?.in.push({ from, via: inLabel, evidence: edge.evidence });
    }
  }
  const warnings: string[] = [];
  for (const [keys, label] of [
    [report.coverage.failed, `${view.noun} unavailable`],
    [report.coverage.partial, `${view.noun} with incomplete connections`],
    [report.coverage.cappedOut, `known ${view.noun} omitted by the node limit`],
    [report.coverage.hubs, "hubs not expanded"],
  ] as const)
    if (keys.length) warnings.push(`${keys.length} ${label}`);
  warnings.push(...(view.warnings ?? []));
  const messages = [...view.messages];
  if (clusters !== undefined) messages.push(THEMES_NOTE);
  const all = Object.values(nodes);
  const openIssue = view.openIssue ?? ((node: ClientNode) => node.state === "OPEN");
  return {
    id: view.id,
    label: view.label,
    ...(view.url ? { url: view.url } : {}),
    ...(view.openCount !== undefined ? { openCount: view.openCount } : {}),
    grouping: clusters === undefined ? "components" : "themes",
    provider: {
      ...view.provider,
      signals: [],
      views: ["explore", "swarm"],
      metrics: ["links", "depth"],
    },
    repo: view.repo,
    seeds: report.seeds.filter((key) => nodes[key]),
    groups:
      clusters !== undefined
        ? workClusterGroups(Object.keys(nodes), clusters)
        : report.components
            .map((members, index) => ({
              label: `Component ${index + 1}`,
              subtitle:
                members.length === 1
                  ? "No explicit relationships"
                  : (report.nodes.find((node) => seeds.has(node.key) && members.includes(node.key))
                      ?.title ?? "Connected by explicit relationships"),
              members: members.filter((key) => nodes[key]),
            }))
            .filter((group) => group.members.length),
    cleanup: [],
    stats: {
      nodes: all.length,
      openIssues: all.filter((node) => openIssue(node) && !node.archived).length,
      archived: all.filter((node) => node.archived).length,
    },
    nodes,
    coverage: {
      complete: report.coverageComplete && !warnings.length,
      generatedAt: report.generatedAt,
      maxDepth: report.limits.maxDepth,
      messages,
      warnings,
    },
  };
}
