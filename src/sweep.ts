import { fileOverlaps, isSignificant } from "./overlaps.js";
import type { GhTransport } from "./transport.js";
import type { GraphNode, NodeKey } from "./types.js";

/**
 * Groups of open work that one decision can resolve together:
 *
 * - `competing`: an open issue with two or more open closing PRs;
 * - `stale`: an open PR whose modified files are all gone from the base
 *   branch, with the issue it closes;
 * - `overlap`: each open PR paired with the PR it shares the most weighted
 *   source files with, when they close no common issue.
 *
 * Groups where every PR is stale come first, since they need verification on
 * the current release rather than new code.
 */

export interface SweepPullRequest {
  key: NodeKey;
  title: string;
  url: string;
  isDraft: boolean;
  mergeable: string;
  additions: number;
  deletions: number;
  /**
   * True when every file the PR modifies or deletes is gone from the base
   * branch, false when some remain, null when that could not be checked.
   */
  staleBase: boolean | null;
  missingOnBase: string[];
}

/**
 * What a group needs before anyone acts on it:
 *
 * - `verify`: run the issue's repro on the current release; every PR edits
 *   files the base branch no longer has, so the fix may already be there;
 * - `choose`: pick one implementation among open PRs that close one issue;
 * - `compare`: read two PRs that share files to decide whether they overlap.
 */
export type SweepNext = "verify" | "choose" | "compare";

export interface SweepGroup {
  kind: "competing" | "stale" | "overlap";
  next: SweepNext;
  /** The open issue the PRs close, when there is one. */
  issue: NodeKey | null;
  pullRequests: SweepPullRequest[];
  /** Source files the PRs share, for overlap groups. */
  sharedFiles: string[];
  /**
   * For overlap pairs, the summed weight of the shared source files, where a
   * file weighs less the more open PRs touch it (log of open PRs over PRs
   * touching it). Null for other kinds.
   */
  overlapScore: number | null;
  /** Open items one decision resolves: the issue plus every PR. */
  resolves: number;
  /** Every PR only edits files the base branch no longer has. */
  allStale: boolean;
  /** Smallest additions + deletions among PRs that are not stale, if any. */
  smallestChange: number | null;
  summary: string;
}

const NEXT_ORDER: Record<SweepNext, number> = { verify: 0, choose: 1, compare: 2 };

function significantFiles(node: GraphNode): string[] {
  return (node.pr?.files ?? []).filter(isSignificant);
}

function isOpen(node: GraphNode | undefined, kind: GraphNode["kind"]): node is GraphNode {
  return node?.kind === kind && node.state === "OPEN";
}

function sweepPullRequest(
  node: GraphNode,
  missing: Map<string, Set<string>> | null,
): SweepPullRequest {
  const baseFiles = node.pr?.baseFiles;
  const gone = missing?.get(`${node.owner}/${node.repo}`);
  const missingOnBase = baseFiles && gone ? baseFiles.filter((file) => gone.has(file)) : [];
  const staleBase = baseFiles?.length && gone ? missingOnBase.length === baseFiles.length : null;
  return {
    key: node.key,
    title: node.title,
    url: node.url,
    isDraft: node.pr?.isDraft ?? false,
    mergeable: node.pr?.mergeable ?? "UNKNOWN",
    additions: node.pr?.additions ?? 0,
    deletions: node.pr?.deletions ?? 0,
    staleBase,
    missingOnBase,
  };
}

function finishGroup(
  kind: SweepGroup["kind"],
  issue: NodeKey | null,
  pullRequests: SweepPullRequest[],
  sharedFiles: string[] = [],
  overlapScore: number | null = null,
): SweepGroup {
  const allStale = pullRequests.every((pr) => pr.staleBase === true);
  const live = pullRequests.filter((pr) => pr.staleBase !== true && !pr.isDraft);
  const smallestChange = live.length
    ? Math.min(...live.map((pr) => pr.additions + pr.deletions))
    : null;
  const keys = pullRequests.map((pr) => pr.key).join(", ");
  const summary =
    kind === "overlap"
      ? `Both PRs change ${sharedFiles.slice(0, 3).join(", ")} without a shared closing issue.`
      : allStale
        ? `Every PR edits files the base branch no longer has (${keys}). Verify on the current release before closing.`
        : `${pullRequests.length} open PRs close ${issue}. One fix resolves ${pullRequests.length + 1} items.`;
  return {
    kind,
    next: kind === "overlap" ? "compare" : allStale ? "verify" : "choose",
    issue,
    pullRequests,
    sharedFiles,
    overlapScore,
    resolves: pullRequests.length + (issue ? 1 : 0),
    allStale,
    smallestChange,
    summary,
  };
}

function bySweepOrder(a: SweepGroup, b: SweepGroup): number {
  return (
    NEXT_ORDER[a.next] - NEXT_ORDER[b.next] ||
    b.resolves - a.resolves ||
    (b.overlapScore ?? 0) - (a.overlapScore ?? 0) ||
    (a.smallestChange ?? Number.POSITIVE_INFINITY) -
      (b.smallestChange ?? Number.POSITIVE_INFINITY) ||
    (a.issue ?? a.pullRequests[0].key).localeCompare(b.issue ?? b.pullRequests[0].key)
  );
}

function closedIssues(node: GraphNode, nodes: Map<NodeKey, GraphNode>): NodeKey[] {
  return node.edges
    .filter((edge) => edge.via === "closes" && isOpen(nodes.get(edge.to), "Issue"))
    .map((edge) => edge.to);
}

/**
 * Build sweep groups. `missing` maps `owner/repo` to base-branch paths that
 * do not exist; pass null when the base branch was not checked.
 */
export function buildSweep(
  nodes: Map<NodeKey, GraphNode>,
  missing: Map<string, Set<string>> | null,
): SweepGroup[] {
  const openPrs = [...nodes.values()]
    .filter((node) => isOpen(node, "PullRequest"))
    .sort((a, b) => a.key.localeCompare(b.key));
  const groups: SweepGroup[] = [];
  const grouped = new Set<NodeKey>();

  const closers = new Map<NodeKey, GraphNode[]>();
  for (const pr of openPrs) {
    for (const issue of closedIssues(pr, nodes)) {
      closers.set(issue, [...(closers.get(issue) ?? []), pr]);
    }
  }
  for (const [issue, prs] of [...closers].sort(([a], [b]) => a.localeCompare(b))) {
    if (prs.length < 2) continue;
    for (const pr of prs) grouped.add(pr.key);
    groups.push(
      finishGroup(
        "competing",
        issue,
        prs.map((node) => sweepPullRequest(node, missing)),
      ),
    );
  }

  const stale = new Set<NodeKey>();
  for (const pr of openPrs) {
    const entry = sweepPullRequest(pr, missing);
    if (entry.staleBase !== true) continue;
    stale.add(pr.key);
    if (grouped.has(pr.key)) continue;
    groups.push(finishGroup("stale", closedIssues(pr, nodes)[0] ?? null, [entry]));
  }

  const touching = new Map<string, number>();
  for (const node of openPrs) {
    for (const file of new Set(significantFiles(node))) {
      touching.set(file, (touching.get(file) ?? 0) + 1);
    }
  }
  const weight = (file: string): number =>
    Math.log((openPrs.length + 1) / (touching.get(file) ?? 1));

  // Keep each PR's strongest partner only. Every overlapping pair would grow
  // quadratically with the backlog; the strongest one is the lead worth reading.
  const best = new Map<NodeKey, { score: number; other: NodeKey; shared: string[] }>();
  for (const overlap of fileOverlaps(nodes)) {
    if (overlap.sharedIssue || stale.has(overlap.a) || stale.has(overlap.b)) continue;
    if (grouped.has(overlap.a) && grouped.has(overlap.b)) continue;
    const shared = overlap.shared.slice(0, overlap.significant);
    const score = shared.reduce((total, file) => total + weight(file), 0);
    for (const [self, other] of [
      [overlap.a, overlap.b],
      [overlap.b, overlap.a],
    ]) {
      const current = best.get(self);
      if (!current || score > current.score) best.set(self, { score, other, shared });
    }
  }
  const emitted = new Set<string>();
  for (const [self, { score, other, shared }] of [...best].sort(([a], [b]) => a.localeCompare(b))) {
    const [a, b] = [self, other].sort();
    if (emitted.has(`${a} ${b}`)) continue;
    emitted.add(`${a} ${b}`);
    const pair = [nodes.get(a), nodes.get(b)].filter((node): node is GraphNode => !!node);
    groups.push(
      finishGroup(
        "overlap",
        null,
        pair.map((node) => sweepPullRequest(node, missing)),
        shared,
        score,
      ),
    );
  }

  return groups.sort(bySweepOrder);
}

/** Paths each repository's open PRs expect on the base branch. */
export function sweepBasePaths(nodes: Map<NodeKey, GraphNode>): Map<string, Set<string>> {
  const paths = new Map<string, Set<string>>();
  for (const node of nodes.values()) {
    if (!isOpen(node, "PullRequest") || !node.pr?.baseFiles?.length) continue;
    const repo = `${node.owner}/${node.repo}`;
    const set = paths.get(repo) ?? new Set<string>();
    for (const file of node.pr.baseFiles) set.add(file);
    paths.set(repo, set);
  }
  return paths;
}

const PATHS_PER_QUERY = 50;

/**
 * Return the paths that do not exist on each repository's default branch.
 * A repository whose check fails is left out, so its PRs report unknown.
 */
export async function missingBasePaths(
  transport: GhTransport,
  paths: Map<string, Set<string>>,
): Promise<Map<string, Set<string>>> {
  const missing = new Map<string, Set<string>>();
  for (const [repo, set] of paths) {
    const [owner, name] = repo.split("/");
    const files = [...set].sort();
    const gone = new Set<string>();
    try {
      for (let start = 0; start < files.length; start += PATHS_PER_QUERY) {
        const chunk = files.slice(start, start + PATHS_PER_QUERY);
        const params = chunk.map((_, i) => `$e${i}:String!`).join(",");
        const fields = chunk.map((_, i) => `f${i}: object(expression:$e${i}){ __typename }`);
        const query = `query($o:String!,$r:String!,${params}){ repository(owner:$o,name:$r){ ${fields.join(" ")} } }`;
        const variables: Record<string, string> = { o: owner, r: name };
        chunk.forEach((file, i) => {
          variables[`e${i}`] = `HEAD:${file}`;
        });
        const result = (await transport.graphql(query, variables)) as {
          data?: { repository?: Record<string, unknown> | null };
          errors?: unknown[];
        };
        const found = result.data?.repository;
        if (!found || result.errors?.length) throw new Error("base check failed");
        chunk.forEach((file, i) => {
          if (found[`f${i}`] == null) gone.add(file);
        });
      }
      missing.set(repo, gone);
    } catch {
      // Unknown beats a false "stale": leave this repository unchecked.
    }
  }
  return missing;
}

export function renderSweep(groups: SweepGroup[], limit = 10): string[] {
  const out = ["## Sweep", ""];
  if (!groups.length) {
    out.push("- No issue with competing PRs and no PRs sharing source files.");
    return out;
  }
  for (const [index, group] of groups.slice(0, limit).entries()) {
    const head = group.issue ? `${group.issue} + ` : "";
    out.push(
      `${index + 1}. [${group.next}] ${head}${group.pullRequests.map((pr) => pr.key).join(", ")} · resolves ${group.resolves}${group.allStale ? " · stale base" : ""}`,
      `   - ${group.summary}`,
    );
    for (const pr of group.pullRequests) {
      const flags = [
        `+${pr.additions}/-${pr.deletions}`,
        pr.mergeable,
        pr.isDraft ? "draft" : "",
        pr.staleBase === true
          ? "stale base"
          : pr.missingOnBase.length
            ? `missing on base: ${pr.missingOnBase.slice(0, 3).join(", ")}`
            : "",
      ].filter(Boolean);
      out.push(`   - ${pr.key} ${flags.join(" · ")}`);
    }
  }
  if (groups.length > limit) out.push(`- ${groups.length - limit} more in --format json.`);
  return out;
}
