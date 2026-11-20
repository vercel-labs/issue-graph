import type { Model } from "./html.js";
import { workDashboardModel, workEdgeLabels } from "./work-dashboard.js";
import type { YouTrackReport } from "./youtrack.js";

const YOUTRACK_SVG =
  '<svg class="youtrack-mark" width="14" height="14" role="img" aria-label="YouTrack" viewBox="0 0 128 128" fill="currentColor"><path d="M67.209.009a26.46 26.46 0 0 0-16.538 6.134L27.759 25.24h-2.535v2.111L.88 47.643c-1.031.855-1.18 2.44-.316 3.468l16.253 19.405L2.575 99.854a2.475 2.475 0 0 0 .755 3.052l33.292 24.63c.886.655 2.278.62 3.137-.177c2.048-1.913 15.957-14.486 37.26-24.576h25.748v-9.75c12.216-3.623 20.96-4.864 23.08-5.132c1.412-.177 2.404-1.604 2.097-2.982v-.008l-10.288-45.722c-.308-1.353-1.743-2.205-3.075-1.82l-11.814 3.392V25.24h-8.67A26.42 26.42 0 0 0 83.94 5.596A26.48 26.48 0 0 0 67.209.01Zm.07 3.938A22.54 22.54 0 0 1 81.52 8.709a22.43 22.43 0 0 1 8.631 16.53H33.925L53.199 9.18a22.54 22.54 0 0 1 14.08-5.232ZM25.223 32.492v70.29H68.22c-16.789 8.96-27.462 18.424-30.156 20.9L6.66 100.472l14.827-30.526L4.548 49.723Zm7.714 2.427h6.112l6.58 11.614l.772 1.665l.77-1.688l6.42-11.59h6.003L49.122 53.06v10.944H43.58V53.099Zm27.736 0h23.335v5.11H75.2v23.975h-5.672V40.029h-8.855zm53.483 6.682l9.602 42.694c-2.94.401-10.502 1.57-20.992 4.608V44.868ZM34.919 87.269h31.018v5.819H34.92Z"></path></svg>';

/** The dashboard model for one YouTrack run, saved per base URL and seed project. */
export function youTrackDashboardModel(
  report: YouTrackReport,
  clusters?: unknown,
): Model & { id: string } {
  const seeds = new Set(report.seeds);
  const seed = report.nodes.find((node) => seeds.has(node.key));
  const project = seed?.projectKey ?? "";
  return workDashboardModel(
    report,
    {
      id: `youtrack:${report.authority}:project:${project}`,
      label: `${report.authority} / ${project}`,
      ...(seed ? { url: seed.url } : {}),
      provider: {
        id: "youtrack",
        name: "YouTrack",
        logo: YOUTRACK_SVG,
        repoUrl: report.baseUrl,
      },
      repo: report.authority,
      noun: "issues",
      node: (node) => ({
        repo: report.authority,
        kind: "Issue",
        state: !node.fetched ? "UNKNOWN" : node.state.type === "done" ? "CLOSED" : "OPEN",
      }),
      edgeLabels: (edge) =>
        edge.relation === "related" ? ["relates to", "relates to"] : workEdgeLabels(edge),
      messages: [
        `Source: ${report.readSource ?? "YouTrack REST API"}.`,
        `Issue neighborhood, up to ${report.limits.maxDepth} link steps within ${project}; other projects one hop.`,
        ...(report.coverage.depthBoundaries.length
          ? [`${report.coverage.depthBoundaries.length} issues not expanded`]
          : []),
        "Text mentions are not collected.",
        "Linked pull request and commit URLs are listed without being fetched.",
      ],
    },
    clusters,
  );
}
