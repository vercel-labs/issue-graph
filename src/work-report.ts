import type { NodeKey } from "./types.js";
import type { WorkNode } from "./work-types.js";

/** Which nodes of a run were not read in full, by reason. */
export interface WorkCoverage {
  /** Nodes whose read failed: kept as unavailable nodes with an error code. */
  failed: NodeKey[];
  /** Read nodes with at least one incomplete connection listing. */
  partial: NodeKey[];
  /** Known nodes never read because the node cap was reached. */
  cappedOut: NodeKey[];
  /** High-degree nodes read but not expanded. */
  hubs: NodeKey[];
  /** Read nodes with connections that the requested depth or scope left unread. */
  depthBoundaries: NodeKey[];
}

/**
 * Sorts a run's nodes into coverage buckets. A run is complete within its scope when nothing
 * failed, nothing is partial, nothing was capped out, and no hub was left unexpanded; depth
 * boundaries are the requested scope, so they do not make a run incomplete.
 */
export function workCoverage(
  nodes: Map<NodeKey, WorkNode>,
  cappedOut: Iterable<NodeKey>,
  isBoundary: (node: WorkNode) => boolean,
): { coverage: WorkCoverage; coverageComplete: boolean } {
  const values = [...nodes.values()];
  const coverage: WorkCoverage = {
    failed: values.filter((node) => !node.fetched).map((node) => node.key),
    partial: values
      .filter((node) => node.coverage.some((part) => !part.complete))
      .map((node) => node.key),
    cappedOut: [...cappedOut].sort(),
    hubs: values.filter((node) => node.hub).map((node) => node.key),
    depthBoundaries: values.filter(isBoundary).map((node) => node.key),
  };
  return {
    coverage,
    coverageComplete:
      !coverage.failed.length &&
      !coverage.partial.length &&
      !coverage.cappedOut.length &&
      !coverage.hubs.length,
  };
}

/** True when a node has connections to nodes that were not read. */
export const hasUnreadEdges = (node: WorkNode, nodes: Map<NodeKey, WorkNode>): boolean =>
  node.edges.some((edge) => !nodes.has(edge.to));

export interface WorkLimits {
  maxDepth: number;
  maxNodes: number;
  hubThreshold: number;
  concurrency?: number;
}

/** Rejects limits outside the ranges every work provider accepts. */
export function validateWorkLimits(
  options: WorkLimits,
  maxConcurrency: number,
  extra: ReadonlyArray<readonly [string, number, number, number]> = [],
): void {
  for (const [name, value, minimum, maximum] of [
    ["maxDepth", options.maxDepth, 0, 8],
    ["maxNodes", options.maxNodes, 1, 1000],
    ["hubThreshold", options.hubThreshold, 1, 1000],
    ["concurrency", options.concurrency ?? 4, 1, maxConcurrency],
    ...extra,
  ] as const) {
    if (!Number.isInteger(value) || value < minimum || value > maximum)
      throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
}

/** The fields every work provider report shares. */
export interface WorkReport<TNode extends WorkNode = WorkNode> {
  schemaVersion: 1;
  generatedAt: string;
  readSource?: string;
  seeds: NodeKey[];
  limits: { maxDepth: number };
  coverageComplete: boolean;
  coverage: WorkCoverage;
  nodes: TNode[];
  components: NodeKey[][];
}

/** Escapes text for a Markdown line, including heading markers. */
export function markdownText(value: string): string {
  return value.replace(/\p{Cc}/gu, " ").replace(/[\\`*_[\]<>|#]/g, "\\$&");
}

export interface WorkMarkdown<TNode extends WorkNode> {
  title: string;
  /** Scope sentence printed under the coverage line. */
  scope: string;
  /** Text after the state name on the status line, such as ` · Bug`. */
  status?(node: TNode): string;
  /** Lines after the node's edges, such as remote links. */
  links?(node: TNode): string[];
  /** Summary lines after the node-cap and depth-boundary counts. */
  footer?: string[];
}

const arrow = (direction: string) =>
  direction === "incoming" ? "←" : direction === "undirected" ? "↔" : "→";

/** Renders a work provider report as Markdown, one section per node. */
export function renderWorkMarkdown<TNode extends WorkNode>(
  report: WorkReport<TNode>,
  view: WorkMarkdown<TNode>,
): string {
  const lines = [
    `# ${markdownText(view.title)}`,
    "",
    `Coverage: ${report.coverageComplete ? "complete within requested scope" : "partial"} · ${report.nodes.length} nodes · depth ${report.limits.maxDepth}`,
    "",
    view.scope,
    "",
  ];
  const labels = new Map(report.nodes.map((node) => [node.key, node.identifier]));
  for (const node of report.nodes) {
    lines.push(
      `## ${markdownText(node.identifier)} · ${markdownText(node.title)}`,
      "",
      `Status: ${markdownText(node.state.name)}${view.status?.(node) ?? ""}${node.hub ? " · hub not expanded" : ""}`,
      "",
    );
    if (node.url) lines.push(markdownText(node.url), "");
    if (!node.fetched) lines.push(`Read failed: ${node.error ?? "READ_FAILED"}`, "");
    for (const edge of node.edges)
      lines.push(
        `- ${arrow(edge.direction)} ${markdownText(edge.nativeRelation)}: ${markdownText(labels.get(edge.to) ?? edge.to.slice(edge.to.lastIndexOf(":") + 1))}`,
      );
    lines.push(...(view.links?.(node) ?? []));
    for (const part of node.coverage.filter((part) => !part.complete))
      lines.push(`- Incomplete ${part.source}: ${part.reason ?? "not read"}`);
    lines.push("");
  }
  if (report.coverage.cappedOut.length)
    lines.push(`Node cap: ${report.coverage.cappedOut.length} known nodes not fetched.`, "");
  if (report.coverage.depthBoundaries.length)
    lines.push(`Depth boundary: ${report.coverage.depthBoundaries.length} nodes not expanded.`, "");
  for (const line of view.footer ?? []) lines.push(line, "");
  return `${lines.join("\n")}\n`;
}
