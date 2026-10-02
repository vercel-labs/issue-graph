import { scoring, type Weights } from "./scoring.js";
import type { GraphNode, NodeKey } from "./types.js";

/** One ranked row: the raw signals plus the composite score. */
export interface PriorityRow {
  key: NodeKey;
  kind: string;
  title: string;
  url: string;
  comments: number;
  participants: number;
  reactions: number;
  /** Whole days since the node was opened (0 when createdAt is missing). */
  daysOpen: number;
  /** Distinct nodes in the graph that reference this one. */
  inboundRefs: number;
  score: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Composite triage score, tuned for "most discussion and/or obvious
 * frustration first" (not inbox zero):
 *
 *   comments × 3      — discussion depth
 *   participants × 2  — discussion breadth (many voices > one long thread)
 *   reactions × 2     — frustration signal
 *   inbound refs × 2  — other issues/PRs keep pointing here
 *   + 1 per 30 days open, capped at 12 (a year) — old + still open
 *
 * Linear and transparent on purpose: the raw signals are shown next to the
 * score so a human can override the ranking.
 */
export function score(r: Omit<PriorityRow, "score">, weights: Weights = scoring.defaults): number {
  return scoring.score(r, weights);
}

/** Rank every OPEN node by discussion heat, highest score first. */
export function prioritize(
  nodes: Map<NodeKey, GraphNode>,
  now: Date,
  weights: Weights = scoring.defaults,
): PriorityRow[] {
  // distinct referencing nodes per target; a sub-issue link is hierarchy, not
  // a reference, so a parent with many children does not gain heat from them
  const inbound = new Map<NodeKey, number>();
  for (const n of nodes.values())
    for (const e of n.edges)
      if (e.via !== "sub-issue") inbound.set(e.to, (inbound.get(e.to) ?? 0) + 1);

  const rows: PriorityRow[] = [];
  for (const n of nodes.values()) {
    if (n.state !== "OPEN" || !n.fetched) continue;
    const createdAt = n.heat?.createdAt || n.pr?.createdAt || "";
    const opened = createdAt ? Date.parse(createdAt) : Number.NaN;
    const partial = {
      key: n.key,
      kind: n.kind,
      title: n.title,
      url: n.url,
      comments: n.heat?.comments ?? 0,
      participants: n.heat?.participants ?? 0,
      reactions: n.heat?.reactions ?? 0,
      daysOpen: Number.isNaN(opened)
        ? 0
        : Math.max(0, Math.floor((now.getTime() - opened) / DAY_MS)),
      inboundRefs: inbound.get(n.key) ?? 0,
    };
    rows.push({ ...partial, score: score(partial, weights) });
  }
  return rows.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
}

/** Render the ranked list as a markdown section. */
export function renderPriority(rows: PriorityRow[], weights: Weights = scoring.defaults): string {
  const out: string[] = ["\n## Triage priority (open nodes, most discussion/frustration first)\n"];
  if (!rows.length) {
    out.push("- (no open nodes)");
    return `${out.join("\n")}\n`;
  }
  rows.forEach((r, i) => {
    const kind = r.kind === "PullRequest" ? "PR" : "issue";
    out.push(`${i + 1}. **${r.key}** ${kind} — ${r.title || "(no title)"}  _(score ${r.score})_`);
    out.push(
      `    - ${r.comments} comments · ${r.participants} participants · ${r.reactions} reactions · ${r.inboundRefs} inbound refs · open ${r.daysOpen}d`,
    );
  });
  out.push(
    `\n_score = comments×${weights.comments} + participants×${weights.participants} + reactions×${weights.reactions} + inbound×${weights.inboundRefs} + min(12, daysOpen/30)×${weights.age}_`,
  );
  return `${out.join("\n")}\n`;
}
