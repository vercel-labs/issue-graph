import type { GraphNode, NodeKey } from "./types.js";

/**
 * Files whose overlap is incidental, not evidence of duplicated work: docs,
 * changelogs, and lockfiles. Two PRs both editing `README.md` or `pnpm-lock.yaml`
 * tells you nothing; two PRs both editing `src/cli.ts` is the real signal.
 */
const INCIDENTAL =
  /(?:^|\/)(?:README|CHANGELOG|LICENSE|CONTRIBUTING)[^/]*$|\.mdx?$|(?:^|\/)(?:[^/]+\.lock|package-lock\.json|pnpm-lock\.yaml)$/i;

export const isSignificant = (file: string): boolean => !INCIDENTAL.test(file);

/** Two open PRs that touch at least one significant (source) file in common. */
export interface Overlap {
  a: NodeKey;
  b: NodeKey;
  /** Files both PRs touch, sorted. Significant (source) files first. */
  shared: string[];
  /** Count of shared files that are source, not docs/lockfiles. */
  significant: number;
  /** An issue both PRs structurally close, if any — a strong duplicate signal. */
  sharedIssue?: NodeKey;
}

/**
 * Find pairs of OPEN PRs whose changed-file sets intersect. Overlapping files
 * are the objective signal that two PRs do the same work or will conflict —
 * far stronger than matching titles or issue references. When both PRs also
 * close the same issue, that's a near-certain duplicate.
 *
 * Deterministic: PRs are ordered by key, pairs by (a, b), shared files sorted.
 */
export function fileOverlaps(nodes: Map<NodeKey, GraphNode>): Overlap[] {
  const prs = [...nodes.values()]
    .filter((n) => n.kind === "PullRequest" && n.state === "OPEN" && (n.pr?.files?.length ?? 0) > 0)
    .sort((a, b) => a.key.localeCompare(b.key));

  const closedIssues = (n: GraphNode): Set<NodeKey> =>
    new Set(n.edges.filter((e) => e.via === "closes").map((e) => e.to));

  const out: Overlap[] = [];
  for (let i = 0; i < prs.length; i++) {
    const a = prs[i];
    const aFiles = new Set(a.pr?.files ?? []);
    const aCloses = closedIssues(a);
    for (let j = i + 1; j < prs.length; j++) {
      const b = prs[j];
      const shared = (b.pr?.files ?? [])
        .filter((f) => aFiles.has(f))
        .sort((x, y) => Number(isSignificant(y)) - Number(isSignificant(x)) || x.localeCompare(y));
      const significant = shared.filter(isSignificant).length;
      // an overlap in docs/lockfiles alone is incidental — skip it
      if (significant === 0) continue;
      const sharedIssue = [...closedIssues(b)].find((k) => aCloses.has(k));
      out.push({ a: a.key, b: b.key, shared, significant, sharedIssue });
    }
  }

  // Most source-file overlap first; same-issue duplicates float up as a tiebreak.
  return out.sort(
    (x, y) =>
      y.significant - x.significant ||
      y.shared.length - x.shared.length ||
      Number(!!y.sharedIssue) - Number(!!x.sharedIssue) ||
      x.a.localeCompare(y.a) ||
      x.b.localeCompare(y.b),
  );
}
