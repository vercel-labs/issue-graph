import type { Model } from "./html.js";
import type { LinearReport } from "./linear.js";
import { workDashboardModel, workEdgeLabels } from "./work-dashboard.js";
import type { WorkEdge, WorkNode } from "./work-types.js";

const LINEAR_SVG =
  '<svg class="linear-mark" width="14" height="14" role="img" aria-label="Linear" viewBox="0 0 100 100" fill="currentColor"><path d="M12.927 16.371a1.47 1.47 0 0 0 .061 2.027l68.595 68.594c.555.555 1.446.59 2.026.062 10.058-9.152 16.372-22.348 16.372-37.018C99.98 22.402 77.579 0 49.945 0c-14.67 0-27.866 6.313-37.018 16.371M4.353 29.39a1.47 1.47 0 0 0 .309 1.648L68.943 95.32c.434.434 1.09.562 1.648.308a50 50 0 0 0 4.335-2.227c.834-.482.962-1.62.28-2.3L8.882 24.773c-.68-.68-1.818-.553-2.3.281a50 50 0 0 0-2.228 4.334m-3.9 18.407a1.48 1.48 0 0 1-.432-1.14q.2-2.986.74-5.866c.215-1.15 1.62-1.55 2.448-.722l56.703 56.704c.828.827.429 2.233-.722 2.448a50 50 0 0 1-5.865.74 1.48 1.48 0 0 1-1.14-.433zm3.48 13.963c-1.033-1.033-2.7-.143-2.322 1.268C6.221 80.22 19.761 93.76 36.954 98.37c1.41.379 2.3-1.289 1.268-2.322z"></path></svg>';

function state(node: WorkNode): string {
  if (!node.fetched) return "UNKNOWN";
  return ["completed", "canceled", "duplicate"].includes(node.state.type) ? "CLOSED" : "OPEN";
}

function labels(edge: WorkEdge): [string, string] {
  if (edge.relation === "duplicate_of") return ["duplicate of", "has duplicate"];
  return workEdgeLabels(edge);
}

export function linearDashboardModel(
  report: LinearReport,
  clusters?: unknown,
): Model & { id: string } {
  const include = (node: WorkNode) =>
    report.project === undefined ||
    !node.fetched ||
    (report.project
      ? node.project?.id === report.project.id
      : node.project === null && node.team?.id === report.team?.id);
  const omitted = report.nodes.filter((node) => !include(node)).length;
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
  return workDashboardModel(
    report,
    {
      id: `linear:${report.workspace.id}:${scopeId}`,
      label: `${report.workspace.name} / ${scopeName}`,
      url: report.project?.url ?? `https://linear.app/${report.workspace.slug}`,
      openCount: report.openCount,
      provider: {
        id: "linear",
        name: "Linear",
        logo: LINEAR_SVG,
        repoUrl: "https://linear.app/{repo}",
      },
      repo: report.workspace.slug,
      noun: "issues",
      include,
      node: (node) => ({
        repo: report.workspace.slug,
        kind: "Issue",
        state: state(node),
        archived: node.archived,
      }),
      edgeLabels: labels,
      warnings:
        report.inventory && !report.inventory.complete
          ? [`Project issue list incomplete: ${report.inventory.reason ?? "read incomplete"}`]
          : [],
      messages: [
        `Source: ${report.readSource ?? "Linear API"}.`,
        report.scope.issues === "project"
          ? "Project issues and their explicit connections."
          : `Issue neighborhood, up to ${report.limits.maxDepth} relationship steps.`,
        ...(report.scope.notes ?? []),
        ...(report.coverage.depthBoundaries.length
          ? [`${report.coverage.depthBoundaries.length} issues at the depth boundary`]
          : []),
        "Text mentions are not collected.",
        "Attachment targets are listed without being fetched.",
        report.scope.archived === "excluded"
          ? "Archived issues are outside this capture."
          : "Archived issues are included; archived relations and attachments are excluded.",
        ...(omitted ? [`${omitted} issues outside this project are omitted from this view.`] : []),
      ],
    },
    clusters,
  );
}
