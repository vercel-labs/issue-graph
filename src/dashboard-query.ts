import { createDashboardFilterEngine, type DashboardFilters } from "./dashboard-filters.js";
import type { ClientNode, Model } from "./html.js";
import { createScoringEngine, type Weights } from "./scoring.js";
import type { NodeKey } from "./types.js";

export interface DashboardQuery {
  filters: DashboardFilters;
  weights: Weights;
  view: "explore" | "impact" | "swarm" | "rank";
  select: string | null;
  group: "cluster" | "state" | "kind" | "all";
  metric: "heat" | "links" | "blast" | "depth";
  cluster: number | null;
}

export type DashboardQueryInput = Partial<Omit<DashboardQuery, "filters" | "weights">> & {
  filters?: Partial<DashboardFilters>;
  weights?: Partial<Weights>;
};

export function createDashboardQueryEngine(
  filters: ReturnType<typeof createDashboardFilterEngine>,
  scoring: ReturnType<typeof createScoringEngine>,
) {
  const scope = (model: Model) => {
    const id = model.id || model.repo;
    return id.startsWith(`${model.provider.id}:`) ? id.slice(model.provider.id.length + 1) : id;
  };
  const identity = (model: Model) => `${model.provider.id}:${scope(model)}`;
  function normalize(model: Model, input: DashboardQueryInput = {}): DashboardQuery {
    const views = model.provider.views ?? ["explore", "impact", "swarm", "rank"];
    const metrics = model.provider.metrics ?? ["heat", "links", "blast", "depth"];
    const view = input.view ?? (views.includes("rank") ? "rank" : (views[0] ?? "explore"));
    const metric = input.metric ?? (metrics.includes("heat") ? "heat" : (metrics[0] ?? "links"));
    const group = input.group ?? "cluster";
    if (!views.includes(view))
      throw new Error(`view ${view} is unavailable for ${identity(model)}`);
    if (!metrics.includes(metric))
      throw new Error(`metric ${metric} is unavailable for ${identity(model)}`);
    if (!["cluster", "state", "kind", "all"].includes(group)) throw new Error("invalid group");
    const requested = input.filters ?? {};
    if (typeof requested !== "object" || Array.isArray(requested))
      throw new Error("filters must be an object");
    const normalized = filters.normalize(requested, model);
    for (const [key, value] of Object.entries(requested)) {
      if (!(key in normalized)) throw new Error(`unknown filter: ${key}`);
      const actual = normalized[key as keyof DashboardFilters];
      const same =
        key === "clusters" && Array.isArray(value)
          ? value.every((v) => (normalized.clusters as unknown[]).includes(v))
          : actual === value;
      if (!same) throw new Error(`invalid or unsupported filter ${key}: ${JSON.stringify(value)}`);
    }
    const select = input.select ?? null;
    if (select !== null && !Object.hasOwn(model.nodes, select))
      throw new Error(`selected item is absent from capture: ${select}`);
    const cluster = input.cluster ?? null;
    if (
      cluster !== null &&
      (!Number.isInteger(cluster) || cluster < 0 || cluster >= model.groups.length)
    )
      throw new Error(`unknown cluster: ${cluster}`);
    if (cluster !== null && view !== "explore")
      throw new Error("--focus-cluster requires --view explore");
    if (cluster !== null && select !== null)
      throw new Error("choose either --select or --focus-cluster");
    if (select !== null && !["explore", "impact"].includes(view))
      throw new Error("--select requires --view explore or impact");
    return {
      filters: normalized,
      weights: { ...scoring.defaults, ...scoring.validate(input.weights ?? {}) },
      view,
      metric,
      group,
      select,
      cluster,
    };
  }
  function rank(model: Model, matches: Set<string>, weights: Weights) {
    return Object.values(model.nodes)
      .filter(
        (n): n is ClientNode & { heat: NonNullable<ClientNode["heat"]> } =>
          Boolean(n.heat) && filters.stateOf(n) === "open" && matches.has(n.key),
      )
      .map((n) => ({
        n,
        parts: scoring.parts(n.heat, weights),
        score: scoring.score(n.heat, weights),
      }))
      .sort((a, b) => b.score - a.score || a.n.key.localeCompare(b.n.key));
  }
  function hash(query: DashboardQuery): string {
    if (query.select)
      return query.view === "impact"
        ? `impact:${encodeURIComponent(query.select)}`
        : encodeURIComponent(query.select);
    if (query.view === "rank") return `rank:${scoring.keys.map((k) => query.weights[k]).join(",")}`;
    if (query.view === "swarm") return `swarm:${query.group}:${query.metric}`;
    if (query.view === "explore" && query.cluster !== null) return `explore:${query.cluster}`;
    return query.view;
  }
  function url(base: string, model: Model, query: DashboardQuery): string {
    const out = new URL(base);
    out.searchParams.set("project", identity(model));
    out.searchParams.set("filters", JSON.stringify(query.filters));
    out.searchParams.set("weights", scoring.keys.map((k) => query.weights[k]).join(","));
    out.searchParams.set("group", query.group);
    out.searchParams.set("metric", query.metric);
    out.hash = hash(query);
    return out.href;
  }
  function evaluate(model: Model, query: DashboardQuery) {
    const result = filters.evaluate(model, query.filters, (n) =>
      n.heat ? scoring.score(n.heat, query.weights) : 0,
    );
    return { ...result, ranking: rank(model, result.matches, query.weights) };
  }
  function fromUrl(model: Model, href: string, defaults: Partial<Weights> = {}) {
    const location = new URL(href);
    const raw = decodeURIComponent(location.hash.slice(1));
    const input: DashboardQueryInput = { view: "explore", weights: defaults };
    if (location.searchParams.has("group"))
      input.group = location.searchParams.get("group") as DashboardQuery["group"];
    if (location.searchParams.has("metric"))
      input.metric = location.searchParams.get("metric") as DashboardQuery["metric"];
    const parseWeights = (text: string) => {
      const values = text.split(",");
      if (values.length !== scoring.keys.length || values.some((v) => !v.trim()))
        throw new Error("expected five weights");
      return scoring.fromArray(values.map(Number));
    };
    const weights = location.searchParams.get("weights");
    if (weights !== null) input.weights = parseWeights(weights);
    const requested = location.searchParams.get("filters");
    if (requested !== null) input.filters = JSON.parse(requested);
    if (raw.startsWith("rank:")) {
      input.view = "rank";
      input.weights = parseWeights(raw.slice(5));
    } else if (raw.startsWith("swarm:")) {
      const [, group, metric] = raw.split(":");
      input.view = "swarm";
      input.group = group as DashboardQuery["group"];
      input.metric = metric as DashboardQuery["metric"];
    } else if (raw.startsWith("explore:")) input.cluster = Number(raw.slice(8));
    else if (raw.startsWith("impact:")) {
      input.view = "impact";
      input.select = raw.slice(7);
    } else if (["explore", "impact", "swarm", "rank"].includes(raw))
      input.view = raw as DashboardQuery["view"];
    else if (raw) input.select = raw;
    return normalize(model, input);
  }
  return { identity, scope, normalize, rank, hash, url, evaluate, fromUrl };
}

export function createGraphMetrics(model: Model) {
  const nodes = model.nodes;
  const buckets = ["resolves", "prs", "overlaps", "followups", "related"] as const;
  const active = (n?: ClientNode) =>
    n?.state === "OPEN" && !n.archived && n.read?.fetched !== false;
  function neighbors(k: string) {
    const n = nodes[k as NodeKey],
      out = new Set<NodeKey>();
    if (!n) return out;
    for (const e of n.out) if (nodes[e.to]) out.add(e.to);
    for (const e of n.in) if (nodes[e.from]) out.add(e.from);
    for (const o of n.overlaps) if (nodes[o.with]) out.add(o.with);
    return out;
  }
  function blastRadius(k: string) {
    const n = nodes[k as NodeKey];
    const raw = {
      resolves: new Set<NodeKey>(),
      prs: new Set<NodeKey>(),
      overlaps: new Set<NodeKey>(),
      followups: new Set<NodeKey>(),
      related: new Set<NodeKey>(),
    };
    if (!n) return { ...raw, keys: [], total: 0, issues: 0, prCount: 0 };
    if (n.kind === "PullRequest") {
      for (const e of n.out) {
        if (e.via !== "closes" || !nodes[e.to]) continue;
        raw.resolves.add(e.to);
        for (const incoming of nodes[e.to].in)
          if (incoming.via === "closes" && incoming.from !== k && active(nodes[incoming.from]))
            raw.prs.add(incoming.from);
      }
      for (const o of n.overlaps) if (active(nodes[o.with])) raw.overlaps.add(o.with);
    } else if (n.kind === "Issue") {
      for (const incoming of n.in)
        if (incoming.via === "closes" && active(nodes[incoming.from])) raw.prs.add(incoming.from);
      for (const pr of raw.prs)
        for (const o of nodes[pr].overlaps) if (active(nodes[o.with])) raw.overlaps.add(o.with);
    }
    for (const linked of neighbors(k)) {
      const target = nodes[linked];
      if (!active(target)) continue;
      if (target.kind === "Issue") raw.followups.add(linked);
      else if (
        target.kind === "PullRequest" &&
        /^POSSIBLY SUPERSEDED|^SUPERSEDED/.test(target.verdict || "")
      )
        raw.prs.add(linked);
      else raw.related.add(linked);
    }
    const seen = new Set<string>([k]);
    for (const bucket of buckets)
      for (const key of raw[bucket]) {
        if (seen.has(key)) raw[bucket].delete(key);
        else seen.add(key);
      }
    const keys = [...seen].filter((key) => key !== k) as NodeKey[];
    return {
      ...raw,
      keys,
      total: keys.length,
      issues: keys.filter((key) => nodes[key].kind === "Issue").length,
      prCount: keys.filter((key) => nodes[key].kind === "PullRequest").length,
    };
  }
  const srcFiles = (o: ClientNode["overlaps"][number]) => o.shared.slice(0, o.significant);
  let reachCache: Map<string, number> | undefined;
  function reach() {
    if (reachCache) return reachCache;
    const by = new Map<string, Set<string>>();
    for (const n of Object.values(nodes))
      for (const o of n.overlaps)
        for (const f of srcFiles(o)) {
          const s = by.get(f) ?? new Set();
          s.add(n.key);
          s.add(o.with);
          by.set(f, s);
        }
    reachCache = new Map([...by].map(([f, s]) => [f, s.size]));
    return reachCache;
  }
  function overlapWith(k: string, x: string) {
    const n = nodes[k as NodeKey];
    const own = n.overlaps.find((o) => o.with === x);
    if (own || n.kind === "PullRequest") return own;
    let best: ClientNode["overlaps"][number] | undefined;
    for (const e of n.in) {
      if (e.via !== "closes" || !active(nodes[e.from])) continue;
      const o = nodes[e.from].overlaps.find((o) => o.with === x);
      if (o && (!best || o.significant > best.significant)) best = o;
    }
    return best;
  }
  function rarest(k: string, x: string) {
    const o = overlapWith(k, x);
    return o
      ? srcFiles(o).sort((a, b) => (reach().get(a) || 0) - (reach().get(b) || 0))[0]
      : undefined;
  }
  function impactParts(k: string, b: ReturnType<typeof blastRadius>) {
    return Object.fromEntries(
      buckets.map((id) => [
        id,
        id === "overlaps"
          ? [...b.overlaps].reduce((sum, x) => {
              const f = rarest(k, x);
              return sum + (f ? Math.min(1, 2 / (reach().get(f) || 2)) : 0);
            }, 0)
          : b[id].size,
      ]),
    ) as Record<(typeof buckets)[number], number>;
  }
  function impactRows(matches: Set<string>) {
    return Object.values(nodes)
      .filter((n) => active(n) && matches.has(n.key))
      .map((n) => {
        const b = blastRadius(n.key),
          parts = impactParts(n.key, b);
        return { k: n.key, b, parts, score: Object.values(parts).reduce((a, v) => a + v, 0) };
      })
      .filter((r) => r.b.total > 0)
      .sort(
        (a, b) =>
          b.score - a.score || b.b.resolves.size - a.b.resolves.size || a.k.localeCompare(b.k),
      );
  }
  return { neighbors, blastRadius, srcFiles, reach, overlapWith, rarest, impactParts, impactRows };
}

export const dashboardQuery = createDashboardQueryEngine(
  createDashboardFilterEngine(),
  createScoringEngine(),
);
