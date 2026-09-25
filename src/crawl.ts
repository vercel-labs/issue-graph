import type { FetchNode } from "./github.js";
import type {
  CrawlEdge,
  CrawlNode,
  CrawlOptions,
  CrawlResult,
  GraphCrawlOptions,
  GraphCrawlResult,
  GraphFetchNode,
  GraphNode,
  GraphSeed,
  NodeKey,
  Seed,
} from "./types.js";

export async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const limit = Math.max(1, Math.floor(concurrency) || 1);
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await mapper(values[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function targetDepth(
  opts: GraphCrawlOptions,
  sourceKey: NodeKey,
  edge: CrawlEdge,
  sourceDepth: number,
): number | null {
  const depth = opts.depthForEdge?.({ sourceKey, edge, sourceDepth, maxDepth: opts.maxDepth });
  const resolved = depth === undefined ? sourceDepth + 1 : depth;
  if (resolved === null) return null;
  if (!Number.isInteger(resolved) || resolved <= sourceDepth || resolved > opts.maxDepth) {
    throw new RangeError(
      `depthForEdge must return an integer from ${sourceDepth + 1} to ${opts.maxDepth}, or null; received ${String(resolved)} for ${sourceKey} -> ${edge.to}`,
    );
  }
  return resolved;
}

/**
 * Source-neutral breadth-first crawl from canonical node keys. The caller owns
 * key syntax, node hydration, and edge-depth policy; this function owns the
 * concurrency, node cap, cycle deduplication, and hub guard.
 *
 * By default every edge advances one level. A `depthForEdge` policy can return
 * `maxDepth` to fetch a boundary node without expanding it, or null to leave an
 * edge unfetched. Nodes retain their collector-specific fields in the result.
 */
export async function crawlGraph<TNode extends CrawlNode>(
  seeds: GraphSeed[],
  opts: GraphCrawlOptions,
  fetch: GraphFetchNode<TNode>,
): Promise<GraphCrawlResult<TNode>> {
  const nodes = new Map<NodeKey, TNode>();
  const cappedOut = new Set<NodeKey>();
  const seedKeys = new Set(seeds.map((seed) => seed.key));
  let frontier = seeds.map((seed) => ({ key: seed.key, depth: 0 }));

  while (frontier.length) {
    // Admit as much of this level as the cap allows, dropping the rest by key
    // so the caller can report what it did not inspect.
    const admitted: Array<{ key: NodeKey; depth: number }> = [];
    const claimed = new Set<NodeKey>();
    for (const current of frontier) {
      if (nodes.has(current.key) || claimed.has(current.key)) continue;
      if (nodes.size + admitted.length >= opts.maxNodes) {
        cappedOut.add(current.key);
        continue;
      }
      claimed.add(current.key);
      admitted.push(current);
    }

    const fetched = await mapConcurrent(admitted, opts.concurrency ?? 4, (current) =>
      fetch(current.key, current.depth),
    );

    const next: Array<{ key: NodeKey; depth: number }> = [];
    for (let index = 0; index < admitted.length; index++) {
      const current = admitted[index];
      const node = fetched[index];
      if (node.key !== current.key) {
        throw new Error(
          `Graph fetch returned ${JSON.stringify(node.key)} for requested key ${JSON.stringify(current.key)}`,
        );
      }
      nodes.set(current.key, node);
      if (current.depth >= opts.maxDepth) continue;

      // Fetch a high-degree non-seed node but do not expand it.
      if (!seedKeys.has(current.key) && node.edges.length > opts.hubThreshold) {
        node.hub = true;
        continue;
      }

      for (const edge of node.edges) {
        if (nodes.has(edge.to)) continue;
        const depth = targetDepth(opts, current.key, edge, current.depth);
        if (depth !== null) next.push({ key: edge.to, depth });
      }
    }
    frontier = next;
  }

  return { nodes, cappedOut };
}

const GITHUB_NODE_KEY = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;

function githubSeedKey(seed: Seed): NodeKey {
  return `${seed.owner}/${seed.repo}#${seed.number}`;
}

function parseGitHubNodeKey(key: NodeKey): Seed | null {
  const match = key.match(GITHUB_NODE_KEY);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

/**
 * GitHub-compatible crawl retained for existing CLI and library callers.
 * Same-repository references recurse to `maxDepth`; cross-repository references
 * are fetched one hop and not expanded. Non-GitHub edge keys are ignored.
 */
export async function crawl(
  seeds: Seed[],
  opts: CrawlOptions,
  fetch: FetchNode,
): Promise<CrawlResult> {
  return crawlGraph<GraphNode>(
    seeds.map((seed) => ({ key: githubSeedKey(seed) })),
    {
      maxDepth: opts.maxDepth,
      maxNodes: opts.maxNodes,
      hubThreshold: opts.hubThreshold,
      concurrency: opts.concurrency,
      depthForEdge: ({ edge, sourceDepth, maxDepth }) => {
        const target = parseGitHubNodeKey(edge.to);
        if (!target) return null;
        const sameRepo =
          target.owner === opts.primaryRepo.owner && target.repo === opts.primaryRepo.repo;
        return sameRepo ? sourceDepth + 1 : maxDepth;
      },
    },
    async (key, depth) => {
      const seed = parseGitHubNodeKey(key);
      if (!seed) throw new Error(`Invalid GitHub node key: ${key}`);
      return fetch(seed.owner, seed.repo, seed.number, depth);
    },
  );
}

/** Undirected connected components over the crawled nodes, largest first. */
export function components<TNode extends CrawlNode>(nodes: Map<NodeKey, TNode>): NodeKey[][] {
  const parent = new Map<NodeKey, NodeKey>();
  const find = (x: NodeKey): NodeKey => {
    let root = x;
    while (parent.get(root) !== root) {
      const p = parent.get(root);
      if (p === undefined) break;
      parent.set(root, parent.get(p) ?? p);
      root = parent.get(root) ?? root;
    }
    return root;
  };
  const union = (a: NodeKey, b: NodeKey) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const key of nodes.keys()) parent.set(key, key);
  for (const node of nodes.values()) {
    for (const edge of node.edges) if (nodes.has(edge.to)) union(node.key, edge.to);
  }
  const groups = new Map<NodeKey, NodeKey[]>();
  for (const key of nodes.keys()) {
    const root = find(key);
    const group = groups.get(root) ?? [];
    group.push(key);
    groups.set(root, group);
  }
  return [...groups.values()].sort((a, b) => b.length - a.length);
}
