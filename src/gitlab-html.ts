import type { GitLabReport } from "./gitlab.js";
import type { ClientNode, Model } from "./html.js";
import { workClusterGroups } from "./work-clusters.js";
import type { WorkEdge } from "./work-types.js";

const GITLAB_SVG =
  '<svg class="gitlab-mark" width="14" height="14" role="img" aria-label="GitLab" viewBox="0 0 24 24" fill="currentColor"><path d="m23.6 9.593-.033-.086L20.3.98a.851.851 0 0 0-.336-.405.875.875 0 0 0-1 .054.875.875 0 0 0-.29.44L16.47 7.818H7.537L5.332 1.07a.857.857 0 0 0-.29-.441.875.875 0 0 0-1-.054.859.859 0 0 0-.336.405L.433 9.502.4 9.588a6.066 6.066 0 0 0 2.012 7.01l.011.009.03.021 4.976 3.727 2.462 1.863 1.5 1.132a1.009 1.009 0 0 0 1.22 0l1.499-1.132 2.462-1.863 5.006-3.749.012-.01a6.068 6.068 0 0 0 2.01-7.003z"></path></svg>';

const STATES: Record<string, string> = { opened: "OPEN", closed: "CLOSED", merged: "MERGED" };

function labels(edge: WorkEdge): [string, string] {
  if (edge.nativeRelation === "closes") return ["closes", "closes"];
  if (edge.relation === "blocks") return ["blocks", "blocked by"];
  if (edge.nativeRelation === "mentions") return ["mentions", "mentioned by"];
  if (edge.relation === "related") return ["relates to", "relates to"];
  return [edge.nativeRelation, `${edge.nativeRelation} (incoming)`];
}

/** The dashboard model for one GitLab run, saved per host and seed project. */
export function gitlabDashboardModel(
  report: GitLabReport,
  clusters?: unknown,
): Model & { id: string } {
  const seeds = new Set(report.seeds);
  const seed = report.nodes.find((node) => seeds.has(node.key));
  const project = seed?.projectPath ?? "";
  const nodes: Record<string, ClientNode> = {};
  for (const node of report.nodes) {
    nodes[node.key] = {
      key: node.key,
      num: 0,
      identifier: node.identifier,
      repo: node.projectPath,
      kind: node.kind === "pull-request" ? "PullRequest" : "Issue",
      state: !node.fetched ? "UNKNOWN" : (STATES[node.state.name] ?? "CLOSED"),
      stateLabel: node.draft ? `${node.state.name} · draft` : node.state.name,
      stateType: node.state.type,
      archived: false,
      read: { fetched: node.fetched, error: node.error, coverage: node.coverage },
      title: node.title,
      url: node.url,
      depth: node.depth,
      seed: seeds.has(node.key),
      flags: [
        ...(node.hub ? ["Hub not expanded"] : []),
        ...(!node.fetched ? ["Item unavailable"] : []),
        ...(node.coverage.some((part) => !part.complete) ? ["Incomplete connections"] : []),
      ],
      mentionedBy: [],
      external: [],
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
    [report.coverage.failed, "items unavailable"],
    [report.coverage.partial, "items with incomplete connections"],
    [report.coverage.cappedOut, "known items omitted by the node limit"],
    [report.coverage.hubs, "hubs not expanded"],
  ] as const)
    if (keys.length) warnings.push(`${keys.length} ${label}`);
  const messages = [
    `Source: ${report.readSource ?? "glab"}.`,
    `Issue and merge request neighborhood, up to ${report.limits.maxDepth} reference steps within ${project}; other projects one hop.`,
  ];
  if (report.coverage.depthBoundaries.length)
    messages.push(`${report.coverage.depthBoundaries.length} items not expanded`);
  if (report.coverage.groupWorkItems.length)
    messages.push(`${report.coverage.groupWorkItems.length} linked group work items not read`);
  messages.push(
    "Mentions come from system notes on the mentioned item; outgoing text references are not parsed.",
  );
  if (clusters !== undefined)
    messages.push(
      "Themes are proposed groupings, not verified common root causes. Native relationships are unchanged.",
    );
  const all = Object.values(nodes);
  return {
    id: `gitlab:${report.host}:project:${project.toLowerCase()}`,
    label: `${report.host} / ${project}`,
    ...(seed ? { url: seed.url } : {}),
    grouping: clusters === undefined ? "components" : "themes",
    provider: {
      id: "gitlab",
      name: "GitLab",
      logo: GITLAB_SVG,
      repoUrl: `https://${report.host}/{repo}`,
      signals: [],
      views: ["explore", "swarm"],
      metrics: ["links", "depth"],
    },
    repo: project,
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
      openIssues: all.filter((node) => node.state === "OPEN" && node.kind === "Issue").length,
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
