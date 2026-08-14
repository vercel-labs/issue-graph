import type { FetchNode } from "./github.js";
import type { CrawlOptions, CrawlResult, GraphNode, NodeKey, Seed } from "./types.js";

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

/**
 * Breadth-first crawl from one or more seeds. Same-repo references recurse to
 * `maxDepth`; cross-repo references are fetched one hop and not expanded. Two
 * guards bound the crawl: a node cap, and a hub guard that fetches but does not
 * expand a high-degree non-seed node (e.g. a tracking issue) so it cannot pull
 * the whole tracker. `fetch` is injectable so the crawl can be tested offline.
 *
 * Each BFS level is fetched in parallel — the depth-2 frontier of a busy issue
 * is dozens of nodes, and fetching them one at a time is the difference
 * between a crawl that fits in a serverless function's budget and one that
 * does not. Ordering within a level is not meaningful; the node cap is applied
 * in level order so a shallower node always wins over a deeper one.
 */
export async function crawl(
  seeds: Seed[],
  opts: CrawlOptions,
  fetch: FetchNode,
): Promise<CrawlResult> {
  const { maxDepth, maxNodes, hubThreshold, primaryRepo } = opts;
  const nodes = new Map<NodeKey, GraphNode>();
  const cappedOut = new Set<NodeKey>();
  const seedKeys = new Set(seeds.map((s) => `${s.owner}/${s.repo}#${s.number}`));
  const sameRepo = (o: string, r: string) => o === primaryRepo.owner && r === primaryRepo.repo;

  let frontier: Array<Seed & { depth: number }> = seeds.map((s) => ({ ...s, depth: 0 }));

  while (frontier.length) {
    // Admit as much of this level as the cap allows, dropping the rest by name
    // so the report can say what it did not look at.
    const admitted: Array<Seed & { depth: number; key: NodeKey }> = [];
    const claimed = new Set<NodeKey>();
    for (const cur of frontier) {
      const key = `${cur.owner}/${cur.repo}#${cur.number}`;
      if (nodes.has(key) || claimed.has(key)) continue;
      if (nodes.size + admitted.length >= maxNodes) {
        cappedOut.add(key);
        continue;
      }
      claimed.add(key);
      admitted.push({ ...cur, key });
    }

    const fetched = await mapConcurrent(admitted, opts.concurrency ?? 4, (cur) =>
      fetch(cur.owner, cur.repo, cur.number, cur.depth),
    );

    const next: Array<Seed & { depth: number }> = [];
    for (let i = 0; i < admitted.length; i++) {
      const cur = admitted[i];
      const node = fetched[i];
      nodes.set(cur.key, node);
      if (cur.depth >= maxDepth) continue;

      // hub guard: fetch a high-degree non-seed node but do not expand it
      if (!seedKeys.has(cur.key) && node.edges.length > hubThreshold) {
        node.hub = true;
        continue;
      }

      for (const edge of node.edges) {
        const m = edge.to.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/);
        if (!m || nodes.has(edge.to)) continue;
        const [, o, r, n] = m;
        next.push({
          owner: o,
          repo: r,
          number: Number(n),
          depth: sameRepo(o, r) ? cur.depth + 1 : maxDepth, // cross-repo: one hop only
        });
      }
    }
    frontier = next;
  }

  return { nodes, cappedOut };
}

/** Undirected connected components over the crawled nodes, largest first. */
export function components(nodes: Map<NodeKey, GraphNode>): NodeKey[][] {
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
  for (const k of nodes.keys()) parent.set(k, k);
  for (const node of nodes.values()) {
    for (const edge of node.edges) if (nodes.has(edge.to)) union(node.key, edge.to);
  }
  const groups = new Map<NodeKey, NodeKey[]>();
  for (const k of nodes.keys()) {
    const root = find(k);
    const g = groups.get(root) ?? [];
    g.push(k);
    groups.set(root, g);
  }
  return [...groups.values()].sort((a, b) => b.length - a.length);
}
