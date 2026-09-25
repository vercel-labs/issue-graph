/** What a node is. `Unknown` covers a node that could not be fetched. */
export type Kind = "Issue" | "PullRequest" | "Unknown";

/** Collector-defined canonical identity. GitHub collectors use `owner/repo#number`. */
export type NodeKey = string;

/** The minimum directed edge shape required by the source-neutral crawler. */
export interface CrawlEdge {
  to: NodeKey;
}

/** How one GitHub node came to reference another. */
export type Via = "text" | "cross-ref" | "connected" | "closes";

/** A GitHub reference edge with attribution. */
export interface Edge extends CrawlEdge {
  via: Via;
  /** Account that created the reference (comment/timeline actor, or PR author). */
  by?: string;
  /** ISO timestamp of the reference, when the source provides one. */
  at?: string;
}

/**
 * The minimum node shape required by the source-neutral graph crawler.
 * Collectors may add any source-specific fields; the crawler preserves them.
 */
export interface CrawlNode {
  key: NodeKey;
  /** BFS distance from the nearest seed. */
  depth: number;
  edges: CrawlEdge[];
  /** High-degree node: fetched but not expanded, to bound the crawl. */
  hub?: boolean;
}

/** A source-neutral seed identified by its collector-defined canonical key. */
export interface GraphSeed {
  key: NodeKey;
}

/** Context passed to a source adapter when choosing how far an edge may recurse. */
export interface EdgeDepthContext {
  sourceKey: NodeKey;
  edge: CrawlEdge;
  sourceDepth: number;
  maxDepth: number;
}

/** Bounds and traversal policy for the source-neutral graph crawler. */
export interface GraphCrawlOptions {
  maxDepth: number;
  maxNodes: number;
  hubThreshold: number;
  concurrency?: number;
  /**
   * Return the target depth for an edge, or null to leave it unfetched.
   * The default is sourceDepth + 1. Returning maxDepth fetches a boundary
   * node without expanding it, which is useful for cross-source references.
   */
  depthForEdge?: (context: EdgeDepthContext) => number | null;
}

/** Fetch one node by its source-defined canonical key. */
export type GraphFetchNode<TNode extends CrawlNode = CrawlNode> = (
  key: NodeKey,
  depth: number,
) => Promise<TNode>;

/** Result of a source-neutral crawl, preserving the collector's node type. */
export interface GraphCrawlResult<TNode extends CrawlNode = CrawlNode> {
  nodes: Map<NodeKey, TNode>;
  cappedOut: Set<NodeKey>;
}

/** PR-only triage metadata, fetched in the same node query (no extra request). */
export interface PullRequestMeta {
  /** Draft PRs are not ready for review. */
  isDraft: boolean;
  /** APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | "" (none requested). */
  reviewDecision: string;
  /** MERGEABLE | CONFLICTING | UNKNOWN (GitHub computes this asynchronously). */
  mergeable: string;
  /** ISO timestamp the PR was opened. */
  createdAt: string;
  mergedAt: string;
  /** ISO timestamp of the last update — the staleness signal. */
  updatedAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  /** Repo-relative paths the PR touches (first 100). Drives overlap detection. */
  files: string[];
}

/** Discussion-heat signals, fetched in the same node query (no extra request). */
export interface HeatMeta {
  /** ISO timestamp the node was opened — drives the time-open signal. */
  createdAt: string;
  /** Total comments (true count, even past the 100 fetched for edge extraction). */
  comments: number;
  /** Distinct accounts that participated in the thread. */
  participants: number;
  /** Reactions on the body — the frustration signal. */
  reactions: number;
}

/** A crawled issue or PR and everything it points to. */
export interface GraphNode extends CrawlNode {
  owner: string;
  repo: string;
  number: number;
  kind: Kind;
  title: string;
  /** OPEN | CLOSED | MERGED | UNKNOWN | NOT_FOUND | FETCH_ERROR. */
  state: string;
  url: string;
  edges: Edge[];
  /** Non-GitHub URLs mentioned, with noise (loopback/example/CI) filtered out. */
  externalLinks: string[];
  fetched: boolean;
  /** Login that opened the node. */
  author?: string;
  /** Accounts that referenced this node (filled after the crawl). */
  mentionedBy?: string[];
  /** Classification verdict (filled by classify). */
  verdict?: string;
  /** Derived triage annotations: competing PRs, claims-close-no-link, etc. */
  flags?: string[];
  /** PR-only triage metadata; present when `kind === "PullRequest"`. */
  pr?: PullRequestMeta;
  /** Discussion-heat signals; present when the node was fetched. */
  heat?: HeatMeta;
  /**
   * Issues this PR's body claims to close via a closing keyword
   * (`fixes #N`, `closes owner/repo#N`). Compared against structural closing
   * links to catch the silent "says it fixes X but won't auto-close" gotcha.
   */
  claimsClose?: NodeKey[];
}

/** A single seed to start crawling from. */
export interface Seed {
  owner: string;
  repo: string;
  number: number;
}

/** Crawl tuning. */
export interface CrawlOptions {
  maxDepth: number;
  maxNodes: number;
  hubThreshold: number;
  concurrency?: number;
  /** The seeds' repo; same-repo refs recurse, cross-repo refs are one hop. */
  primaryRepo: { owner: string; repo: string };
}

/** A crawl result: the node map plus keys dropped when the node cap was hit. */
export interface CrawlResult {
  nodes: Map<NodeKey, GraphNode>;
  cappedOut: Set<NodeKey>;
}

/** A point-in-time capture, persisted for later diffing. */
export interface Snapshot {
  ts: string;
  nodes: Array<Pick<GraphNode, "key" | "kind" | "state" | "title" | "edges">>;
}

/** One entry in the compact payload handed to the clustering agent. */
export interface ClusterNode {
  key: NodeKey;
  kind: string;
  state: string;
  title: string;
  verdict?: string;
  /** Compact adjacency (`closes o/r#1`, `mentions o/r#2`) so the agent can
   * cluster by shared structure, not just title keywords. */
  edges: string[];
}
