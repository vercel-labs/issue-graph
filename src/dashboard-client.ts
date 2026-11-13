import { createDashboardFilterEngine } from "./dashboard-filters.js";
import { createDashboardQueryEngine, createGraphMetrics } from "./dashboard-query.js";
import { mountDashboardView } from "./dashboard-view.js";
import type { Model } from "./html.js";
import { createScoringEngine, type Weights } from "./scoring.js";

export interface DashboardDocument {
  projects: Model[];
  defaults: Record<string, Weights>;
}

export function mountDashboard(root: HTMLElement, data: DashboardDocument): () => void {
  const filters = createDashboardFilterEngine();
  const scoring = createScoringEngine();
  return mountDashboardView(root, data, {
    FILTER_ENGINE: filters,
    SCORING: scoring,
    QUERY_ENGINE: createDashboardQueryEngine(filters, scoring),
    GRAPH_FACTORY: createGraphMetrics,
  });
}

export function dashboardScript(): string {
  return `const filters=(${createDashboardFilterEngine.toString()})();
const scoring=(${createScoringEngine.toString()})();
(${mountDashboardView.toString()})(document.getElementById('app'),JSON.parse(document.getElementById('data').textContent),{
  FILTER_ENGINE:filters,
  SCORING:scoring,
  QUERY_ENGINE:(${createDashboardQueryEngine.toString()})(filters,scoring),
  GRAPH_FACTORY:(${createGraphMetrics.toString()})
});`;
}
