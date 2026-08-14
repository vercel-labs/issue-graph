import { extractClosingRefs, extractRefs } from "./refs.js";
import type { GhTransport } from "./transport.js";
import type { Edge, GraphNode, NodeKey, Via } from "./types.js";

/** One call: node state + title + body + comments + structural edges. */
export const NODE_QUERY = `query($owner:String!,$repo:String!,$n:Int!){
  repository(owner:$owner,name:$repo){
    issueOrPullRequest(number:$n){
      __typename
      ... on Issue {
        title state url body author{login} createdAt
        reactions{ totalCount }
        participants(first:1){ totalCount }
        comments(first:100){ totalCount nodes{ body author{login} } }
        timelineItems(first:100, itemTypes:[CROSS_REFERENCED_EVENT,CONNECTED_EVENT]){ nodes{ __typename
          ... on CrossReferencedEvent{ createdAt actor{login} source{ __typename ... on Issue{number repository{owner{login} name}} ... on PullRequest{number repository{owner{login} name}} } }
          ... on ConnectedEvent{ createdAt actor{login} subject{ __typename ... on Issue{number repository{owner{login} name}} ... on PullRequest{number repository{owner{login} name}} } }
        }}
      }
      ... on PullRequest {
        title state url body author{login}
        isDraft reviewDecision mergeable createdAt mergedAt updatedAt additions deletions changedFiles
        reactions{ totalCount }
        participants(first:1){ totalCount }
        files(first:100){ nodes{ path } }
        comments(first:100){ totalCount nodes{ body author{login} } }
        closingIssuesReferences(first:50){ nodes{ number repository{owner{login} name} } }
        timelineItems(first:100, itemTypes:[CROSS_REFERENCED_EVENT,CONNECTED_EVENT]){ nodes{ __typename
          ... on CrossReferencedEvent{ createdAt actor{login} source{ __typename ... on Issue{number repository{owner{login} name}} ... on PullRequest{number repository{owner{login} name}} } }
        }}
      }
    }
  }
}`;

interface RefNode {
  number?: number;
  repository?: { owner: { login: string }; name: string };
}

/** The subset of the GraphQL node payload the parser reads. */
export interface RawNodeItem {
  __typename: string;
  title?: string;
  state?: string;
  url?: string;
  body?: string;
  author?: { login?: string };
  isDraft?: boolean;
  reviewDecision?: string | null;
  mergeable?: string;
  createdAt?: string;
  mergedAt?: string | null;
  updatedAt?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  files?: { nodes?: Array<{ path?: string }> };
  reactions?: { totalCount?: number };
  participants?: { totalCount?: number };
  comments?: { totalCount?: number; nodes?: Array<{ body?: string; author?: { login?: string } }> };
  closingIssuesReferences?: { nodes?: RefNode[] };
  timelineItems?: {
    nodes?: Array<{
      createdAt?: string;
      actor?: { login?: string };
      source?: RefNode;
      subject?: RefNode;
    }>;
  };
}

/** Build a NodeKey from a GraphQL Issue/PR reference, or null if incomplete. */
export function refKey(o: RefNode | null | undefined): NodeKey | null {
  if (!o || o.number == null || !o.repository) return null;
  return `${o.repository.owner.login}/${o.repository.name}#${o.number}`;
}

/** An unfetched placeholder, used for every failure mode so the crawl can
 * carry on with a node whose state says what went wrong. */
function blankNode(owner: string, repo: string, number: number, depth: number): GraphNode {
  return {
    key: `${owner}/${repo}#${number}`,
    owner,
    repo,
    number,
    kind: "Unknown",
    title: "",
    state: "UNKNOWN",
    url: `https://github.com/${owner}/${repo}/issues/${number}`,
    depth,
    edges: [],
    externalLinks: [],
    fetched: false,
  };
}

/**
 * Turn one GraphQL node payload into a GraphNode. Pure — no I/O, no transport,
 * so the parsing is testable against a fixture and shared by every transport.
 */
export function parseNodeResponse(
  item: RawNodeItem | null | undefined,
  owner: string,
  repo: string,
  number: number,
  depth: number,
): GraphNode {
  const node = blankNode(owner, repo, number, depth);
  if (!item) {
    node.state = "NOT_FOUND";
    return node;
  }

  node.fetched = true;
  node.kind = item.__typename as GraphNode["kind"];
  node.title = item.title ?? "";
  node.state = item.state ?? "UNKNOWN";
  node.url = item.url ?? node.url;
  node.author = item.author?.login;
  node.heat = {
    createdAt: item.createdAt ?? "",
    comments: item.comments?.totalCount ?? 0,
    participants: item.participants?.totalCount ?? 0,
    reactions: item.reactions?.totalCount ?? 0,
  };

  if (node.kind === "PullRequest") {
    node.pr = {
      isDraft: item.isDraft ?? false,
      reviewDecision: item.reviewDecision ?? "",
      mergeable: item.mergeable ?? "UNKNOWN",
      createdAt: item.createdAt ?? "",
      mergedAt: item.mergedAt ?? "",
      updatedAt: item.updatedAt ?? "",
      additions: item.additions ?? 0,
      deletions: item.deletions ?? 0,
      changedFiles: item.changedFiles ?? 0,
      files: (item.files?.nodes ?? [])
        .map((f) => f.path ?? "")
        .filter((p): p is string => p.length > 0),
    };
    // A closing keyword only auto-closes from the PR body — a "fixes #N" in the
    // title (a common mistake) does not. Scan both so we can flag the title-only
    // claims that silently fail to auto-close.
    node.claimsClose = extractClosingRefs(`${item.title ?? ""}\n${item.body ?? ""}`, owner, repo);
  }

  const edgeMap = new Map<NodeKey, Edge>();
  const addEdge = (to: NodeKey | null, via: Via, by?: string, at?: string) => {
    if (!to || to === node.key || edgeMap.has(to)) return; // first edge to a target wins
    edgeMap.set(to, { to, via, by, at });
  };

  // structural edges, attributed to the actor who made the reference
  for (const n of item.closingIssuesReferences?.nodes ?? [])
    addEdge(refKey(n), "closes", node.author);
  for (const tl of item.timelineItems?.nodes ?? []) {
    if (tl.source) addEdge(refKey(tl.source), "cross-ref", tl.actor?.login, tl.createdAt);
    if (tl.subject) addEdge(refKey(tl.subject), "connected", tl.actor?.login, tl.createdAt);
  }

  // text edges, attributed to whoever wrote the body/comment
  const external = new Set<string>();
  const bodies: Array<{ text: string; by?: string }> = [
    { text: item.body ?? "", by: node.author },
    ...(item.comments?.nodes ?? []).map((c) => ({ text: c.body ?? "", by: c.author?.login })),
  ];
  for (const b of bodies) {
    const { refs, external: ext } = extractRefs(b.text, owner, repo);
    for (const r of refs) addEdge(r, "text", b.by);
    for (const e of ext) external.add(e);
  }

  node.edges = [...edgeMap.values()];
  node.externalLinks = [...external];
  return node;
}

/** How the crawl fetches one node. Injectable so the crawl can be tested offline. */
export type FetchNode = (
  owner: string,
  repo: string,
  number: number,
  depth: number,
) => Promise<GraphNode>;

/**
 * Bind a transport into a node fetcher.
 *
 * A transport-level throw is deliberately *not* swallowed here: if GitHub is
 * rate limiting or the token is wrong, every node would come back empty and
 * the resulting graph would look like a real, quiet backlog. Only a payload
 * that GitHub answered — including a GraphQL error for a single node, which is
 * how a deleted or private node reports itself — degrades to a placeholder.
 */
export function makeFetchNode(transport: GhTransport): FetchNode {
  return async (owner, repo, number, depth) => {
    const data = (await transport.graphql(NODE_QUERY, { owner, repo, n: number })) as {
      data?: { repository?: { issueOrPullRequest?: RawNodeItem } };
      errors?: Array<{ message?: string }>;
    };
    const item = data?.data?.repository?.issueOrPullRequest;
    if (!item && data?.errors?.length) {
      const node = blankNode(owner, repo, number, depth);
      node.state = "FETCH_ERROR";
      return node;
    }
    return parseNodeResponse(item, owner, repo, number, depth);
  };
}

/** Resolve seed issue numbers from a repo label. */
export async function labelSeeds(
  transport: GhTransport,
  repo: string,
  label: string,
  limit = 100,
): Promise<number[]> {
  const hits = await transport.search(`repo:${repo} label:"${label}" is:open`, limit);
  return hits.map((h) => h.number);
}

export async function openBacklogSeeds(
  transport: GhTransport,
  repo: string,
  limit = 100,
): Promise<number[]> {
  const hits = await transport.search(`repo:${repo} is:open`, limit);
  return hits.map((hit) => hit.number);
}
