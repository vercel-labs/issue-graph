import type { ClientNode, Model } from "./html.js";
import type { JiraReport } from "./jira.js";
import { workClusterGroups } from "./work-clusters.js";
import type { WorkEdge } from "./work-types.js";

const JIRA_SVG =
  '<svg class="jira-mark" width="14" height="14" role="img" aria-label="Jira" viewBox="0 0 24 24" fill="currentColor"><path d="M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.758a1.001 1.001 0 0 0-1.001-1.001zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24 12.483V1.005A1.001 1.001 0 0 0 23.013 0Z"></path></svg>';

function labels(edge: WorkEdge): [string, string] {
  if (edge.relation === "blocks") return ["blocks", "blocked by"];
  if (edge.relation === "duplicate_of") return ["duplicates", "duplicated by"];
  if (edge.relation === "parent_of") return ["parent of", "child of"];
  return [edge.nativeRelation, `${edge.nativeRelation} (incoming)`];
}

/** The dashboard model for one Jira run, saved per site and seed project. */
export function jiraDashboardModel(report: JiraReport, clusters?: unknown): Model & { id: string } {
  const seeds = new Set(report.seeds);
  const seed = report.nodes.find((node) => seeds.has(node.key));
  const project = seed?.projectKey ?? "";
  const nodes: Record<string, ClientNode> = {};
  for (const node of report.nodes) {
    nodes[node.key] = {
      key: node.key,
      num: 0,
      identifier: node.identifier,
      repo: report.site,
      kind: "Issue",
      state: !node.fetched ? "UNKNOWN" : node.state.type === "done" ? "CLOSED" : "OPEN",
      stateLabel: node.state.name,
      stateType: node.state.type,
      archived: false,
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
        nodes[to]?.out.push({ to: from, via: outLabel, undirected: true, evidence: edge.evidence });
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
  const messages = [
    `Source: ${report.readSource ?? "twg"}.`,
    `Issue neighborhood, up to ${report.limits.maxDepth} link steps within ${project}; other projects one hop.`,
  ];
  if (report.coverage.depthBoundaries.length)
    messages.push(`${report.coverage.depthBoundaries.length} issues not expanded`);
  messages.push(
    "Text mentions are not collected.",
    "Remote link targets are listed without being fetched.",
  );
  if (clusters !== undefined)
    messages.push(
      "Themes are proposed groupings, not verified common root causes. Native relationships are unchanged.",
    );
  const all = Object.values(nodes);
  const siteUrl = report.site.includes(".") ? `https://${report.site}` : undefined;
  return {
    id: `jira:${report.site}:project:${project}`,
    label: `${report.site} / ${project}`,
    ...(siteUrl ? { url: `${siteUrl}/browse/${seed?.identifier ?? ""}` } : {}),
    grouping: clusters === undefined ? "components" : "themes",
    provider: {
      id: "jira",
      name: "Jira",
      logo: JIRA_SVG,
      repoUrl: "https://{repo}",
      signals: [],
      views: ["explore", "swarm"],
      metrics: ["links", "depth"],
    },
    repo: report.site,
    seeds: report.seeds,
    groups:
      clusters !== undefined
        ? workClusterGroups(Object.keys(nodes), clusters)
        : report.components.map((members, index) => ({
            label: `Component ${index + 1}`,
            subtitle:
              members.length === 1
                ? "No explicit relationships"
                : (report.nodes.find((node) => seeds.has(node.key) && members.includes(node.key))
                    ?.title ?? "Connected by explicit relationships"),
            members,
          })),
    cleanup: [],
    stats: {
      nodes: all.length,
      openIssues: all.filter((node) => node.state === "OPEN").length,
      archived: 0,
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
