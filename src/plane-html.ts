import type { ClientNode, Model } from "./html.js";
import type { PlaneReport } from "./plane.js";
import { workClusterGroups } from "./work-clusters.js";
import type { WorkEdge, WorkNode } from "./work-types.js";

const PLANE_SVG =
  '<svg class="plane-mark" width="14" height="14" role="img" aria-label="Plane" viewBox="0 0 24 24" fill="currentColor"><path d="M3 3h6v6H3zM9 9h6v6H9zM15 15h6v6h-6zM9 3h6v6H9zM15 9h6v6h-6z" opacity=".9"></path></svg>';

function state(node: WorkNode): string {
  if (!node.fetched) return "UNKNOWN";
  return ["completed", "canceled"].includes(node.state.type) ? "CLOSED" : "OPEN";
}

const DIRECTED: Record<string, [string, string]> = {
  blocks: ["blocks", "blocked by"],
  start_before: ["starts before", "starts after"],
  finish_before: ["finishes before", "finishes after"],
  implements: ["implements", "implemented by"],
  parent: ["parent of", "child of"],
};

function labels(edge: WorkEdge): [string, string] {
  if (edge.relation === "duplicate_of") return ["duplicate of", "duplicate of"];
  if (edge.relation === "related") return ["relates to", "relates to"];
  return (
    DIRECTED[edge.nativeRelation] ?? [edge.nativeRelation, `${edge.nativeRelation} (incoming)`]
  );
}

export function planeDashboardModel(
  report: PlaneReport,
  clusters?: unknown,
): Model & { id: string } {
  const seeds = new Set(report.seeds);
  const nodes: Record<string, ClientNode> = {};
  for (const node of report.nodes) {
    if (
      report.scope.issues === "project" &&
      node.fetched &&
      node.project?.id !== report.project?.id
    )
      continue;
    nodes[node.key] = {
      key: node.key,
      num: 0,
      identifier: node.identifier,
      repo: report.workspace.slug,
      kind: "Issue",
      state: state(node),
      stateLabel: node.state.name,
      stateType: node.state.type,
      archived: node.archived,
      read: { fetched: node.fetched, error: node.error, coverage: node.coverage },
      title: node.title,
      url: node.url,
      depth: node.depth,
      seed: seeds.has(node.key),
      flags: [
        ...(node.hub ? ["Hub not expanded"] : []),
        ...(!node.fetched ? ["Work item unavailable"] : []),
        ...(node.coverage.some((part) => !part.complete) ? ["Incomplete connections"] : []),
      ],
      mentionedBy: [],
      external: node.externalLinks.map((link) => link.url),
      attachments: node.externalLinks,
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
      const [outLabel, inLabel] = labels(edge);
      nodes[from]?.out.push({ to, via: outLabel, undirected, evidence: edge.evidence });
      if (undirected)
        nodes[to]?.out.push({ to: from, via: outLabel, undirected: true, evidence: edge.evidence });
      else nodes[to]?.in.push({ from, via: inLabel, evidence: edge.evidence });
    }
  }
  const warnings: string[] = [];
  for (const [keys, label] of [
    [report.coverage.failed, "work items unavailable"],
    [report.coverage.partial, "work items with incomplete connections"],
    [report.coverage.cappedOut, "known work items omitted by the node limit"],
    [report.coverage.hubs, "hubs not expanded"],
  ] as const)
    if (keys.length) warnings.push(`${keys.length} ${label}`);
  if (report.inventory && !report.inventory.complete)
    warnings.push(
      `Project work item list incomplete: ${report.inventory.reason ?? "read incomplete"}`,
    );
  const messages = [
    `Source: ${report.readSource ?? "Plane API"}.`,
    report.scope.issues === "project"
      ? "Project work items and their explicit connections."
      : `Work item neighborhood, up to ${report.limits.maxDepth} relationship steps.`,
    ...(report.scope.notes ?? []),
  ];
  if (!report.index.complete)
    messages.push(
      `Workspace index incomplete (${report.index.reason ?? "read incomplete"}); items outside it were looked up one by one.`,
    );
  if (report.coverage.depthBoundaries.length)
    messages.push(`${report.coverage.depthBoundaries.length} work items at the depth boundary`);
  messages.push(
    "Text mentions are not collected.",
    report.scope.externalLinks === "github-resolved"
      ? "GitHub links are read one hop; other link targets are listed without being fetched."
      : "Link targets are listed without being fetched.",
    "Archived work items are outside this capture.",
  );
  const omitted = report.nodes.length - Object.keys(nodes).length;
  if (omitted)
    messages.push(`${omitted} work items outside this project are omitted from this view.`);
  if (clusters !== undefined)
    messages.push(
      "Themes are proposed groupings, not verified common root causes. Native relationships are unchanged.",
    );
  const all = Object.values(nodes);
  const scopeId = report.project ? `project:${report.project.id}` : "unscoped";
  return {
    id: `plane:${report.workspace.slug}:${scopeId}`,
    label: `${report.workspace.name} / ${report.project?.name ?? "Work items"}`,
    url: report.project?.url ?? `${report.webUrl}/${report.workspace.slug}/`,
    openCount: report.openCount,
    grouping: clusters === undefined ? "components" : "themes",
    provider: {
      id: "plane",
      name: "Plane",
      logo: PLANE_SVG,
      repoUrl: `${report.webUrl}/{repo}`,
      signals: [],
      views: ["explore", "swarm"],
      metrics: ["links", "depth"],
    },
    repo: report.workspace.slug,
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
      openIssues: all.filter((node) => node.state === "OPEN" && !node.archived).length,
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
