import type { GitLabReport } from "./gitlab.js";
import type { Model } from "./html.js";
import { contentId } from "./local-store.js";
import { workDashboardModel, workEdgeLabels } from "./work-dashboard.js";
import type { WorkEdge } from "./work-types.js";

const GITLAB_SVG =
  '<svg class="gitlab-mark" width="14" height="14" role="img" aria-label="GitLab" viewBox="0 0 24 24" fill="currentColor"><path d="m23.6 9.593-.033-.086L20.3.98a.851.851 0 0 0-.336-.405.875.875 0 0 0-1 .054.875.875 0 0 0-.29.44L16.47 7.818H7.537L5.332 1.07a.857.857 0 0 0-.29-.441.875.875 0 0 0-1-.054.859.859 0 0 0-.336.405L.433 9.502.4 9.588a6.066 6.066 0 0 0 2.012 7.01l.011.009.03.021 4.976 3.727 2.462 1.863 1.5 1.132a1.009 1.009 0 0 0 1.22 0l1.499-1.132 2.462-1.863 5.006-3.749.012-.01a6.068 6.068 0 0 0 2.01-7.003z"></path></svg>';

const STATES: Record<string, string> = { opened: "OPEN", closed: "CLOSED", merged: "MERGED" };

function edgeLabels(edge: WorkEdge): [string, string] {
  if (edge.nativeRelation === "closes") return ["closes", "closes"];
  if (edge.nativeRelation === "mentions") return ["mentions", "mentioned by"];
  if (edge.relation === "related") return ["relates to", "relates to"];
  return workEdgeLabels(edge);
}

/** The dashboard model for one GitLab run, saved per host and seed project set. */
export function gitlabDashboardModel(
  report: GitLabReport,
  clusters?: unknown,
): Model & { id: string } {
  const seeds = new Set(report.seeds);
  const seed = report.nodes.find((node) => seeds.has(node.key));
  const prefix = `gitlab:${report.host}:`;
  const projects = [
    ...new Set(report.seeds.map((key) => key.slice(prefix.length).replace(/[#!]\d+$/, ""))),
  ].sort();
  const project = seed?.projectPath ?? projects[0] ?? "";
  const multiple = projects.length > 1;
  const scope = multiple
    ? `projects:${contentId(projects.join(","))}`
    : `project:${project.toLowerCase()}`;
  return workDashboardModel(
    report,
    {
      id: `${prefix}${scope}`,
      label: `${report.host} / ${multiple ? projects.join(", ") : project}`,
      ...(seed ? { url: seed.url } : {}),
      provider: {
        id: "gitlab",
        name: "GitLab",
        logo: GITLAB_SVG,
        repoUrl: `https://${report.host}/{repo}`,
      },
      repo: project,
      noun: "items",
      node: (node) => ({
        repo: node.projectPath,
        kind: node.kind === "pull-request" ? "PullRequest" : "Issue",
        state: !node.fetched ? "UNKNOWN" : (STATES[node.state.name] ?? "CLOSED"),
        stateLabel: node.draft ? `${node.state.name} · draft` : node.state.name,
      }),
      edgeLabels,
      openIssue: (node) => node.state === "OPEN" && node.kind === "Issue",
      messages: [
        `Source: ${report.readSource ?? "glab"}.`,
        `Issue and merge request neighborhood, up to ${report.limits.maxDepth} reference steps within ${multiple ? "seed projects" : project}; other projects one hop.`,
        ...(report.coverage.depthBoundaries.length
          ? [`${report.coverage.depthBoundaries.length} items not expanded`]
          : []),
        ...(report.coverage.groupWorkItems.length
          ? [`${report.coverage.groupWorkItems.length} linked group work items not read`]
          : []),
        "Mentions come from system notes on the mentioned item; outgoing text references are not parsed.",
      ],
    },
    clusters,
  );
}
