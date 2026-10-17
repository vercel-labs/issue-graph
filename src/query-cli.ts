import { parseArgs } from "node:util";
import { configPath, readConfig, resolveWeights, setWeights } from "./config.js";
import type { DashboardFilters } from "./dashboard-filters.js";
import { createGraphMetrics, type DashboardQueryInput, dashboardQuery } from "./dashboard-query.js";
import type { ClientNode } from "./html.js";
import { readLocal } from "./local-store.js";
import { parseModel, readCapture, readQuery, saveCapture, saveQuery } from "./query-store.js";
import { scoring, type Weights } from "./scoring.js";
import { readDashboardModels } from "./snapshot.js";

export class QueryUsageError extends Error {}

const HELP = `usage: issue-graph query [provider:scope] [options]
       issue-graph config show [--provider ID [--scope ID]]
       issue-graph config set --weights NAME=VALUE[,NAME=VALUE] [--provider ID [--scope ID]]

Query saved captures without provider requests. Scopes are model IDs within a provider.
Bare owner/repo selects GitHub. Omit scope only when exactly one saved model exists.

  --input PATH             import one normalized dashboard model
  --capture ID             query an immutable full capture
  --history ID             replay a saved query with its frozen parameters
  --view V                 explore, impact, swarm, rank (default rank where supported)
  --state S                all, open, closed, merged, archived, unavailable
  --kind K                 all, Issue, PullRequest, Unknown
  --cluster N              intersect with these cluster indices (repeatable, union)
  --heat-min N             inclusive Heat threshold
  --heat-top N             top 10 or 25 percent, including ties
  --solution S             all, with, without
  --review R               all, pending, approved, changes, draft, conflicts
  --search TEXT            key, identifier, title or author
  --filters JSON           dashboard filter object; individual flags override it
  --weights NAME=VALUE     comments, participants, reactions, inboundRefs, age (0..10)
  --select KEY             inspect an item in Explore or Impact, including context
  --focus-cluster N        focus one Explore cluster
  --group G                Swarm: cluster, state, kind, all
  --metric M               Swarm: heat, links, blast, depth
  --open, --no-open        open the exact view (default only in a terminal)
  --json                   structured stdout (also the default when piped)
  --format human|json      choose output mode

Config precedence: built-in → global → provider → scope → command.
Files live under ISSUE_GRAPH_HOME (default ~/.issue-graph).
Dashboard edits are session-local. Only config set changes persistent defaults.
Query saves immutable captures and view history; no network or provider writes.`;

function weights(raw?: string): Partial<Weights> {
  if (raw === undefined) return {};
  const pairs = raw.split(",").map((part) => part.split("="));
  if (pairs.some((pair) => pair.length !== 2 || !pair[1].trim()))
    throw new QueryUsageError("weights use name=value pairs, such as comments=3,age=1");
  if (new Set(pairs.map(([key]) => key)).size !== pairs.length)
    throw new QueryUsageError("duplicate weight");
  return scoring.validate(Object.fromEntries(pairs.map(([key, value]) => [key, Number(value)])));
}

export async function runQueryCli(argv: string[], open: (url: string) => void): Promise<void> {
  const command = argv[0];
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv.slice(1), command === "config");
  } catch (error) {
    throw new QueryUsageError(error instanceof Error ? error.message : String(error));
  }
  const { values: v, positionals } = parsed;
  if (v.help) {
    console.log(HELP);
    return;
  }
  if (v.format && !["human", "json"].includes(v.format))
    throw new QueryUsageError("--format must be human or json");
  const machine = v.json || v.format === "json" || (!v.format && !process.stdout.isTTY);
  let overrides: Partial<Weights>;
  try {
    overrides = weights(v.weights);
  } catch (error) {
    throw new QueryUsageError(error instanceof Error ? error.message : String(error));
  }
  const output = (result: object, human: string) =>
    process.stdout.write(machine ? `${JSON.stringify(result, null, 2)}\n` : `${human}\n`);
  if (command === "config") {
    const [operation = "show", extra] = positionals;
    if (extra || !["show", "set"].includes(operation))
      throw new QueryUsageError("use config show or config set");
    if (v.scope !== undefined && !v.provider)
      throw new QueryUsageError("--scope requires --provider");
    if (operation === "set" && !v.weights)
      throw new QueryUsageError("config set requires --weights");
    if (operation === "show" && v.weights)
      throw new QueryUsageError("--weights requires config set");
    const config = operation === "set" ? setWeights(overrides, v.provider, v.scope) : readConfig();
    const effective = resolveWeights(config, v.provider, v.scope);
    output(
      {
        schemaVersion: 1,
        command: "config",
        operation,
        path: configPath(),
        config,
        effective,
        nextSteps: ["issue-graph query --help"],
      },
      `${operation === "set" ? "Saved" : "Config"} ${configPath()}\n${v.provider || "global"}${v.scope ? `:${v.scope}` : ""} · ${Object.entries(
        effective,
      )
        .map(([k, n]) => `${k}=${n}`)
        .join(" · ")}`,
    );
    return;
  }
  if (v.open && v["no-open"]) throw new QueryUsageError("--open conflicts with --no-open");
  if (
    v.history &&
    Object.keys(v).some((key) => !["history", "open", "no-open", "json", "format"].includes(key))
  )
    throw new QueryUsageError("--history replays an exact query; omit scope and query overrides");
  if (v.history && positionals.length)
    throw new QueryUsageError("--history already selects its scope");
  const replay = v.history ? readQuery(v.history) : undefined;
  if (v.input && v.capture) throw new QueryUsageError("use either --input or --capture");
  if (positionals.length > 1) throw new QueryUsageError("query takes one provider:scope");
  const scope = positionals[0];
  const qualified = scope?.includes(":") ? scope : scope ? `github:${scope}` : undefined;
  const models = replay
    ? [replay.model]
    : v.input
      ? [parseModel(JSON.parse(readLocal(v.input)))]
      : v.capture
        ? [readCapture(v.capture)]
        : readDashboardModels<unknown>().map(parseModel);
  const candidates = models.filter((m) => !qualified || dashboardQuery.identity(m) === qualified);
  if (candidates.length !== 1)
    throw new QueryUsageError(
      candidates.length
        ? "select a provider:scope; more than one saved model matches"
        : "no matching capture; use a saved run or --input model.json",
    );
  const model = candidates[0];
  let input: DashboardQueryInput;
  try {
    const filters: Partial<DashboardFilters> = v.filters ? JSON.parse(v.filters) : {};
    if (!filters || typeof filters !== "object" || Array.isArray(filters))
      throw new Error("--filters must be an object");
    const fields = ["state", "kind", "solution", "review"] as const;
    for (const key of fields) if (v[key] !== undefined) filters[key] = v[key];
    if (v.search !== undefined) filters.query = v.search;
    if (v.cluster) {
      if (v.cluster.some((n) => !/^\d+$/.test(n)))
        throw new Error("--cluster needs a nonnegative integer");
      filters.clusters = v.cluster.map(Number);
    }
    if (v["focus-cluster"] !== undefined && !/^\d+$/.test(v["focus-cluster"]))
      throw new Error("--focus-cluster needs a nonnegative integer");
    if (v["heat-min"] !== undefined && v["heat-top"] !== undefined)
      throw new Error("--heat-min conflicts with --heat-top");
    if (v["heat-min"] !== undefined) {
      if (!v["heat-min"].trim()) throw new Error("--heat-min needs a number");
      filters.heatMode = "min";
      filters.heatMin = Number(v["heat-min"]);
    }
    if (v["heat-top"] !== undefined) {
      if (!["10", "25"].includes(v["heat-top"])) throw new Error("--heat-top must be 10 or 25");
      filters.heatMode = `top${v["heat-top"]}`;
      filters.heatMin = 0;
    }
    input = {
      filters,
      weights:
        replay?.query.weights ??
        resolveWeights(readConfig(), model.provider.id, dashboardQuery.scope(model), overrides),
      view: v.view as DashboardQueryInput["view"],
      select: v.select,
      group: v.group as DashboardQueryInput["group"],
      metric: v.metric as DashboardQueryInput["metric"],
      cluster: v["focus-cluster"] === undefined ? null : Number(v["focus-cluster"]),
    };
    input = replay?.query ?? dashboardQuery.normalize(model, input);
  } catch (error) {
    throw new QueryUsageError(error instanceof Error ? error.message : String(error));
  }
  const query = dashboardQuery.normalize(model, input);
  if ((v.group || v.metric) && query.view !== "swarm")
    throw new QueryUsageError("--group and --metric require --view swarm");
  const evaluated = dashboardQuery.evaluate(model, query);
  const graph = createGraphMetrics(model);
  const impacts = query.view === "impact" ? graph.impactRows(evaluated.matches) : [];
  if (query.view === "impact" && query.select && !impacts.some((r) => r.k === query.select))
    throw new QueryUsageError(
      "selected item is outside the Impact results; use --view explore to inspect its context",
    );
  const metric = (n: ClientNode) =>
    query.metric === "heat"
      ? n.heat
        ? scoring.score(n.heat, query.weights)
        : null
      : query.metric === "links"
        ? graph.neighbors(n.key).size
        : query.metric === "blast"
          ? graph.blastRadius(n.key).total
          : n.depth;
  const matched = Object.values(model.nodes).filter((n) => evaluated.matches.has(n.key));
  const grouped = new Set(model.groups.flatMap((g) => g.members));
  const clusterMembers = new Set(query.cluster === null ? [] : model.groups[query.cluster].members);
  const visible =
    query.view === "rank"
      ? evaluated.ranking.map((r) => r.n)
      : query.view === "impact"
        ? impacts.map((r) => model.nodes[r.k])
        : matched.filter((n) =>
            query.view === "swarm"
              ? metric(n) !== null && (query.group !== "cluster" || grouped.has(n.key))
              : query.cluster === null
                ? grouped.has(n.key)
                : clusterMembers.has(n.key),
          );
  const captureId = replay?.captureId || v.capture || saveCapture(model);
  const history = replay ?? saveQuery(model, captureId, query);
  const opened = Boolean(
    v.open ||
      (!v["no-open"] && !machine && process.stdin.isTTY && process.stdout.isTTY && !process.env.CI),
  );
  if (opened) open(history.viewUrl);
  output(
    {
      schemaVersion: 1,
      command: "query",
      scoringVersion: scoring.version,
      provider: model.provider.id,
      scope: dashboardQuery.scope(model),
      captureId,
      historyId: history.id,
      query,
      capabilities: {
        ...evaluated.capabilities,
        views: model.provider.views ?? ["explore", "impact", "swarm", "rank"],
        metrics: model.provider.metrics ?? ["heat", "links", "blast", "depth"],
      },
      counts: {
        captured: Object.keys(model.nodes).length,
        matched: matched.length,
        visible: visible.length,
        ranked: evaluated.ranking.length,
      },
      heat: { threshold: evaluated.threshold, baselineCount: evaluated.baselineCount },
      items: visible.map((n) => ({
        ...n,
        score: n.heat ? scoring.score(n.heat, query.weights) : null,
        metric: query.view === "swarm" ? metric(n) : null,
      })),
      ranking: evaluated.ranking.map((r) => ({
        key: r.n.key,
        score: r.score,
        signals: r.n.heat,
        parts: r.parts,
      })),
      impact: impacts.map((r) => ({
        key: r.k,
        score: r.score,
        parts: r.parts,
        affected: r.b.keys,
      })),
      selection: query.select
        ? {
            item: model.nodes[query.select as keyof typeof model.nodes],
            matches: evaluated.matches.has(query.select),
            neighbors: [...graph.neighbors(query.select)],
            affected: graph.blastRadius(query.select).keys,
          }
        : null,
      groups: model.groups.map((g, index) => ({
        ...g,
        index,
        matched: g.members.filter((k) => evaluated.matches.has(k)),
      })),
      coverage: model.coverage ?? {
        complete: false,
        messages: ["This saved model did not record collection coverage."],
      },
      viewUrl: history.viewUrl,
      opened,
      nextSteps: [{ command: "issue-graph query", args: ["--history", history.id, "--open"] }],
    },
    `${(model.label || model.repo).replace(/\p{C}/gu, "")} · ${visible.length} items · ${query.view}\n${opened ? "Opened" : "View"} ${history.viewUrl}`,
  );
}

function parse(args: string[], config: boolean) {
  const string = { type: "string" } as const;
  const boolean = { type: "boolean" } as const;
  const common = {
    weights: string,
    json: boolean,
    format: string,
    help: { ...boolean, short: "h" },
  };
  const result = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      ...common,
      provider: string,
      scope: string,
      input: string,
      capture: string,
      history: string,
      view: string,
      state: string,
      kind: string,
      cluster: { ...string, multiple: true },
      "heat-min": string,
      "heat-top": string,
      solution: string,
      review: string,
      search: string,
      filters: string,
      select: string,
      "focus-cluster": string,
      group: string,
      metric: string,
      open: boolean,
      "no-open": boolean,
    },
  });
  for (const key of Object.keys(result.values)) {
    const configOnly = ["provider", "scope"].includes(key);
    const shared = Object.hasOwn(common, key);
    if (!shared && (config ? !configOnly : configOnly))
      throw new Error(`--${key} is not supported by ${config ? "config" : "query"}`);
  }
  return result;
}
