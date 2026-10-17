import type { ClientNode, Model } from "./html.js";

export interface DashboardFilters {
  state: string;
  kind: string;
  clusters: number[];
  heatMode: string;
  heatMin: number;
  solution: string;
  review: string;
  query: string;
}

export function createDashboardFilterEngine() {
  const defaults = (): DashboardFilters => ({
    state: "all",
    kind: "all",
    clusters: [],
    heatMode: "all",
    heatMin: 0,
    solution: "all",
    review: "all",
    query: "",
  });
  const stateOf = (n: ClientNode) =>
    n.read?.fetched === false || ["UNKNOWN", "FETCH_ERROR"].includes(n.state)
      ? "unavailable"
      : n.archived
        ? "archived"
        : n.state === "OPEN"
          ? "open"
          : n.state === "MERGED"
            ? "merged"
            : "closed";
  function capabilities(model: Model) {
    const nodes = Object.values(model.nodes);
    const supported =
      model.provider.filters ?? (nodes.some((n) => n.pr) ? ["solution", "review"] : []);
    return {
      heat: (model.provider.metrics ?? ["heat"]).includes("heat") && nodes.some((n) => n.heat),
      solution: supported.includes("solution"),
      review: supported.includes("review"),
      kinds: [...new Set(nodes.map((n) => n.kind))],
      states: [...new Set(nodes.map(stateOf))],
    };
  }
  function normalize(input: unknown, model: Model): DashboardFilters {
    const f = input && typeof input === "object" ? (input as Partial<DashboardFilters>) : {};
    const caps = capabilities(model);
    const choose = (value: unknown, values: string[]) =>
      typeof value === "string" && values.includes(value) ? value : "all";
    const kind = choose(f.kind, ["Issue", "PullRequest", "Unknown"]);
    return {
      state: choose(f.state, ["open", "closed", "merged", "archived", "unavailable"]),
      kind,
      clusters: Array.isArray(f.clusters)
        ? [
            ...new Set(
              f.clusters.filter((i) => Number.isInteger(i) && i >= 0 && i < model.groups.length),
            ),
          ].sort((a, b) => a - b)
        : [],
      heatMode: caps.heat ? choose(f.heatMode, ["min", "top10", "top25"]) : "all",
      heatMin:
        caps.heat &&
        f.heatMode === "min" &&
        typeof f.heatMin === "number" &&
        Number.isFinite(f.heatMin) &&
        f.heatMin >= 0
          ? f.heatMin
          : 0,
      solution:
        caps.solution && kind !== "PullRequest" ? choose(f.solution, ["with", "without"]) : "all",
      review:
        caps.review && kind !== "Issue"
          ? choose(f.review, ["pending", "approved", "changes", "draft", "conflicts"])
          : "all",
      query: typeof f.query === "string" ? f.query.slice(0, 512) : "",
    };
  }
  function evaluate(model: Model, input: unknown, score: (node: ClientNode) => number) {
    const filters = normalize(input, model);
    const nodes = Object.values(model.nodes);
    const solutionKeys = new Set<string>();
    for (const n of nodes) {
      if (n.kind !== "PullRequest" || !["open", "merged"].includes(stateOf(n))) continue;
      for (const edge of n.out) if (edge.via === "closes") solutionKeys.add(edge.to);
    }
    for (const n of nodes)
      for (const edge of n.in) {
        const pr = model.nodes[edge.from];
        if (
          edge.via === "closes" &&
          pr?.kind === "PullRequest" &&
          ["open", "merged"].includes(stateOf(pr))
        )
          solutionKeys.add(n.key);
      }
    const heat = new Map(
      nodes.filter((n) => n.heat && stateOf(n) === "open").map((n) => [n.key, score(n)]),
    );
    const baseline = nodes
      .filter((n) => n.repo === model.repo && (filters.kind === "all" || n.kind === filters.kind))
      .map((n) => heat.get(n.key))
      .filter((v): v is number => v !== undefined && Number.isFinite(v))
      .sort((a, b) => b - a);
    const percentile = filters.heatMode === "top10" ? 0.1 : 0.25;
    const threshold =
      filters.heatMode === "all"
        ? null
        : filters.heatMode === "min"
          ? filters.heatMin
          : (baseline[Math.ceil(baseline.length * percentile) - 1] ?? null);
    const clusterKeys = new Set(filters.clusters.flatMap((i) => model.groups[i].members));
    const query = filters.query.trim().toLowerCase();
    const matches = new Set(
      nodes
        .filter((n) => {
          if (filters.state !== "all" && stateOf(n) !== filters.state) return false;
          if (filters.kind !== "all" && n.kind !== filters.kind) return false;
          if (filters.clusters.length && !clusterKeys.has(n.key)) return false;
          if (
            query &&
            ![n.key, n.identifier, n.title, n.author]
              .filter(Boolean)
              .join(" ")
              .toLowerCase()
              .includes(query)
          )
            return false;
          if (filters.heatMode !== "all") {
            const value = heat.get(n.key);
            if (
              threshold === null ||
              value === undefined ||
              !Number.isFinite(value) ||
              value < threshold
            )
              return false;
          }
          if (
            filters.solution !== "all" &&
            (n.kind !== "Issue" || solutionKeys.has(n.key) !== (filters.solution === "with"))
          )
            return false;
          if (filters.review !== "all") {
            const p = n.pr;
            if (n.kind !== "PullRequest" || stateOf(n) !== "open" || !p) return false;
            if (
              filters.review === "pending" &&
              (p.draft || !["", "none", "REVIEW_REQUIRED"].includes(p.review))
            )
              return false;
            if (filters.review === "approved" && (p.draft || p.review !== "APPROVED")) return false;
            if (filters.review === "changes" && p.review !== "CHANGES_REQUESTED") return false;
            if (filters.review === "draft" && !p.draft) return false;
            if (filters.review === "conflicts" && p.mergeable !== "CONFLICTING") return false;
          }
          return true;
        })
        .map((n) => n.key),
    );
    return {
      filters,
      matches,
      threshold,
      baselineCount: baseline.length,
      capabilities: capabilities(model),
    };
  }
  return { defaults, normalize, evaluate, stateOf };
}
