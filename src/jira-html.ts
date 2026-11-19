import type { Model } from "./html.js";
import type { JiraReport } from "./jira.js";
import { workDashboardModel, workEdgeLabels } from "./work-dashboard.js";

const JIRA_SVG =
  '<svg class="jira-mark" width="14" height="14" role="img" aria-label="Jira" viewBox="0 0 24 24" fill="currentColor"><path d="M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.758a1.001 1.001 0 0 0-1.001-1.001zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24 12.483V1.005A1.001 1.001 0 0 0 23.013 0Z"></path></svg>';

/** The dashboard model for one Jira run, saved per site and seed project. */
export function jiraDashboardModel(report: JiraReport, clusters?: unknown): Model & { id: string } {
  const seeds = new Set(report.seeds);
  const seed = report.nodes.find((node) => seeds.has(node.key));
  const project = seed?.projectKey ?? "";
  const siteUrl = report.site.includes(".") ? `https://${report.site}` : undefined;
  return workDashboardModel(
    report,
    {
      id: `jira:${report.site}:project:${project}`,
      label: `${report.site} / ${project}`,
      ...(siteUrl ? { url: `${siteUrl}/browse/${seed?.identifier ?? ""}` } : {}),
      provider: { id: "jira", name: "Jira", logo: JIRA_SVG, repoUrl: "https://{repo}" },
      repo: report.site,
      noun: "issues",
      node: (node) => ({
        repo: report.site,
        kind: "Issue",
        state: !node.fetched ? "UNKNOWN" : node.state.type === "done" ? "CLOSED" : "OPEN",
      }),
      edgeLabels: workEdgeLabels,
      messages: [
        `Source: ${report.readSource ?? "twg"}.`,
        `Issue neighborhood, up to ${report.limits.maxDepth} link steps within ${project}; other projects one hop.`,
        ...(report.coverage.depthBoundaries.length
          ? [`${report.coverage.depthBoundaries.length} issues not expanded`]
          : []),
        "Text mentions are not collected.",
        "Remote link targets are listed without being fetched.",
      ],
    },
    clusters,
  );
}
