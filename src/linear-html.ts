import type { ClientNode, Model } from "./html.js";
import type { LinearReport } from "./linear.js";
import { workClusterGroups } from "./work-clusters.js";
import type { WorkEdge, WorkNode } from "./work-types.js";

const LINEAR_SVG =
  '<svg class="linear-mark" width="14" height="14" role="img" aria-label="Linear" viewBox="0 0 100 100" fill="currentColor"><path d="M12.927 16.371a1.47 1.47 0 0 0 .061 2.027l68.595 68.594c.555.555 1.446.59 2.026.062 10.058-9.152 16.372-22.348 16.372-37.018C99.98 22.402 77.579 0 49.945 0c-14.67 0-27.866 6.313-37.018 16.371M4.353 29.39a1.47 1.47 0 0 0 .309 1.648L68.943 95.32c.434.434 1.09.562 1.648.308a50 50 0 0 0 4.335-2.227c.834-.482.962-1.62.28-2.3L8.882 24.773c-.68-.68-1.818-.553-2.3.281a50 50 0 0 0-2.228 4.334m-3.9 18.407a1.48 1.48 0 0 1-.432-1.14q.2-2.986.74-5.866c.215-1.15 1.62-1.55 2.448-.722l56.703 56.704c.828.827.429 2.233-.722 2.448a50 50 0 0 1-5.865.74 1.48 1.48 0 0 1-1.14-.433zm3.48 13.963c-1.033-1.033-2.7-.143-2.322 1.268C6.221 80.22 19.761 93.76 36.954 98.37c1.41.379 2.3-1.289 1.268-2.322z"></path></svg>';

function state(node: WorkNode): string {
  if (!node.fetched) return "UNKNOWN";
  return ["completed", "canceled", "duplicate"].includes(node.state.type) ? "CLOSED" : "OPEN";
}

function labels(edge: WorkEdge): [string, string] {
  if (edge.relation === "blocks") return ["blocks", "blocked by"];
  if (edge.relation === "duplicate_of") return ["duplicate of", "has duplicate"];
  if (edge.relation === "parent_of") return ["parent of", "child of"];
  return [edge.nativeRelation, `${edge.nativeRelation} (incoming)`];
}

export function linearDashboardModel(
  report: LinearReport,
  clusters?: unknown,
): Model & { id: string } {
  const seeds = new Set(report.seeds);
  const nodes: Record<string, ClientNode> = {};
  for (const node of report.nodes) {
    if (
      report.project !== undefined &&
      node.fetched &&
      (report.project
        ? node.project?.id !== report.project.id
        : node.project !== null || node.team?.id !== report.team?.id)
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
        ...(!node.fetched ? ["Issue unavailable"] : []),
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
        nodes[to]?.out.push({
          to: from,
          via: outLabel,
          undirected: true,
          evidence: edge.evidence,
        });
      else nodes[to]?.in.push({ from, via: inLabel, evidence: edge.evidence });
    }
  }
  const warnings: string[] = [];
  for (const [keys, label] of [
    [report.coverage.failed, "issues unavailable"],
    [report.coverage.partial, "issues with incomplete connections"],
    [report.coverage.cappedOut, "known issues omitted by the node limit"],
    [report.coverage.hubs, "hubs not expanded"],
  ] as const)
    if (keys.length) warnings.push(`${keys.length} ${label}`);
  if (report.inventory && !report.inventory.complete)
    warnings.push(`Project issue list incomplete: ${report.inventory.reason ?? "read incomplete"}`);
  const messages = [
    `Source: ${report.readSource ?? "Linear API"}.`,
    report.scope.issues === "project"
      ? "Project issues and their explicit connections."
      : `Issue neighborhood, up to ${report.limits.maxDepth} relationship steps.`,
    ...(report.scope.notes ?? []),
  ];
  if (report.coverage.depthBoundaries.length)
    messages.push(`${report.coverage.depthBoundaries.length} issues at the depth boundary`);
  messages.push(
    "Text mentions are not collected.",
    "Attachment targets are listed without being fetched.",
    report.scope.archived === "excluded"
      ? "Archived issues are outside this capture."
      : "Archived issues are included; archived relations and attachments are excluded.",
  );
  const omitted = report.nodes.length - Object.keys(nodes).length;
  if (omitted) messages.push(`${omitted} issues outside this project are omitted from this view.`);
  if (clusters !== undefined)
    messages.push(
      "Themes are proposed groupings, not verified common root causes. Native relationships are unchanged.",
    );
  const all = Object.values(nodes);
  const scopeId = report.project
    ? `project:${report.project.id}`
    : report.project === null && report.team
      ? `team:${report.team.id}:no-project`
      : "unscoped";
  const scopeName =
    report.project?.name ??
    (report.project === null
      ? `${report.team?.name ?? "Issues"} / No project`
      : "Unscoped capture");
  return {
    id: `linear:${report.workspace.id}:${scopeId}`,
    label: `${report.workspace.name} / ${scopeName}`,
    url: report.project?.url ?? `https://linear.app/${report.workspace.slug}`,
    openCount: report.openCount,
    grouping: clusters === undefined ? "components" : "themes",
    provider: {
      id: "linear",
      name: "Linear",
      logo: LINEAR_SVG,
      repoUrl: "https://linear.app/{repo}",
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
                report.nodes.find((node) => seeds.has(node.key) && members.includes(node.key))
                  ?.title ?? "Connected by explicit relationships",
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
