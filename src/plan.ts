import type { PriorityRow } from "./priority.js";
import type { ReconcileAction, ReconcileItem, ReconcileReport } from "./reconcile.js";
import type { GraphNode, NodeKey } from "./types.js";

export const PLAN_SCHEMA_VERSION = 1 as const;

export type PlanLane = "cleanup" | "review" | "investigate" | "blocked";
export type PlanStatus = "ready" | "needs-investigation" | "blocked";

export interface PlanReason {
  code: string;
  summary: string;
  related: NodeKey[];
}

export interface PlanPullRequest {
  isDraft: boolean;
  reviewDecision: string;
  mergeable: string;
  createdAt: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
}

export interface PlanItem {
  key: NodeKey;
  kind: "Issue" | "PullRequest";
  title: string;
  url: string;
  action: ReconcileAction;
  lane: PlanLane;
  status: PlanStatus;
  score: number;
  heatScore: number;
  visibleImpact: number;
  blockedBy: NodeKey[];
  reasons: PlanReason[];
  recommendedAction: string;
  pullRequest?: PlanPullRequest;
}

export interface PlanDecision {
  kind: "compare-pull-requests" | "inspect-related-work" | "independent";
  focalKey: NodeKey;
  related: Array<{
    key: NodeKey;
    relation: string;
  }>;
  reviewFirst: NodeKey | null;
  summary: string;
  basis: string[];
  caveat: string;
}

export interface PlanReport {
  schemaVersion: typeof PLAN_SCHEMA_VERSION;
  repo: string;
  generatedAt: string;
  coverageComplete: boolean;
  recommendationSafe: boolean;
  provisional: boolean;
  coverage: ReconcileReport["limits"];
  counts: {
    openItems: number;
    ready: number;
    needsInvestigation: number;
    blocked: number;
  };
  next: PlanItem | null;
  decision: PlanDecision | null;
  queue: PlanItem[];
  investigation: PlanItem[];
  blocked: PlanItem[];
  guardrails: string[];
}

const CLEANUP_ACTIONS = new Set<ReconcileAction>([
  "close-superseded",
  "verify-superseded",
  "resolve-competing",
  "repair-closing-link",
  "verify-completed",
]);

const ACTION_WEIGHT: Record<ReconcileAction, number> = {
  "close-superseded": 900,
  "verify-superseded": 850,
  "resolve-competing": 800,
  "repair-closing-link": 750,
  "verify-completed": 700,
  "review-open-pr": 500,
  "keep-linked": 100,
  "keep-untracked": 200,
};

function nodeReason(code: string, summary: string, related: NodeKey[] = []): PlanReason {
  return { code, summary, related: [...new Set(related)].sort() };
}

function priorityMap(priorities: PriorityRow[]): Map<NodeKey, PriorityRow> {
  return new Map(priorities.map((priority) => [priority.key, priority]));
}

function planItem(
  item: ReconcileItem,
  nodes: Map<NodeKey, GraphNode>,
  priorities: Map<NodeKey, PriorityRow>,
  unresolved: Set<NodeKey>,
): PlanItem {
  const node = nodes.get(item.key);
  const priority = priorities.get(item.key);
  const heatScore = priority?.score ?? 0;
  const visibleImpact = priority?.inboundRefs ?? 0;
  const reasons: PlanReason[] = item.evidence.map((entry) => ({
    code: entry.code,
    summary: entry.summary,
    related: entry.related,
  }));
  let lane: PlanLane = "investigate";
  let status: PlanStatus = "needs-investigation";
  let blockedBy: NodeKey[] = [];
  let readiness = 0;

  if (CLEANUP_ACTIONS.has(item.action)) {
    lane = "cleanup";
    status = "ready";
    readiness = 80;
  } else if (item.action === "review-open-pr") {
    lane = "review";
    status = "ready";
    readiness = 50;
    if (node?.pr?.isDraft) {
      lane = "blocked";
      status = "blocked";
      readiness = 0;
      reasons.push(nodeReason("draft-pr", "The pull request is still a draft."));
    } else if (node?.pr?.mergeable === "CONFLICTING") {
      lane = "blocked";
      status = "blocked";
      readiness = 0;
      reasons.push(
        nodeReason("merge-conflict", "The pull request currently conflicts with its base."),
      );
    } else if (node?.pr?.reviewDecision === "APPROVED") {
      readiness = 100;
      reasons.push(nodeReason("approved", "The pull request is approved."));
    } else if (node?.pr?.mergeable === "MERGEABLE") {
      readiness = 70;
      reasons.push(
        nodeReason("mergeable", "GitHub currently reports the pull request as mergeable."),
      );
    }
  } else if (item.action === "keep-linked") {
    lane = "blocked";
    status = "blocked";
    blockedBy = item.evidence.flatMap((entry) => entry.related).sort();
    reasons.push(
      nodeReason(
        "active-related-work",
        "Resolve the active related pull request before scheduling this issue.",
        blockedBy,
      ),
    );
  }
  const unresolvedReferences = (node?.edges ?? [])
    .map((edge) => edge.to)
    .filter((key) => unresolved.has(key))
    .sort();
  if (unresolvedReferences.length) {
    lane = "blocked";
    status = "blocked";
    readiness = 0;
    blockedBy = [...new Set([...blockedBy, ...unresolvedReferences])].sort();
    reasons.push(
      nodeReason(
        "unresolved-reference",
        "One or more referenced graph nodes could not be resolved.",
        unresolvedReferences,
      ),
    );
  }

  return {
    key: item.key,
    kind: item.kind,
    title: item.title,
    url: item.url,
    action: item.action,
    lane,
    status,
    score: ACTION_WEIGHT[item.action] + readiness + heatScore + visibleImpact * 10,
    heatScore,
    visibleImpact,
    blockedBy,
    reasons,
    recommendedAction: item.recommendedAction,
    pullRequest: node?.pr
      ? {
          isDraft: node.pr.isDraft,
          reviewDecision: node.pr.reviewDecision,
          mergeable: node.pr.mergeable,
          createdAt: node.pr.createdAt,
          updatedAt: node.pr.updatedAt,
          additions: node.pr.additions,
          deletions: node.pr.deletions,
          changedFiles: node.pr.changedFiles,
        }
      : undefined,
  };
}

function byPlanOrder(a: PlanItem, b: PlanItem): number {
  return b.score - a.score || a.key.localeCompare(b.key);
}

function relationLabel(code: string): string {
  if (code === "multiple-open-closing-prs") return "closes and competes";
  if (code === "competing-open-pr") return "competes with";
  if (code === "merged-closing-work") return "closed by";
  if (code === "merged-related-work") return "related merged work";
  if (code === "open-related-work") return "active related work";
  if (code === "merged-pr-same-closing-target") return "same closing target";
  if (code === "merged-pr-closed-related-issue") return "possibly superseded by";
  if (code === "missing-closing-link") return "missing closing link";
  if (code === "active-related-work") return "blocked by";
  if (code === "unresolved-reference") return "unresolved reference";
  return "related";
}

function readiness(item: PlanItem): number {
  const pr = item.pullRequest;
  if (!pr) return -100;
  if (pr.isDraft) return -80;
  if (pr.mergeable === "CONFLICTING") return -60;
  if (pr.reviewDecision === "CHANGES_REQUESTED") return -40;
  if (pr.reviewDecision === "APPROVED") return 40;
  if (pr.mergeable === "MERGEABLE") return 20;
  return 0;
}

function buildDecision(next: PlanItem | null, items: PlanItem[]): PlanDecision | null {
  if (!next) return null;
  const relations = new Map<NodeKey, string>();
  for (const reason of next.reasons) {
    for (const key of reason.related) {
      if (key !== next.key && !relations.has(key)) relations.set(key, relationLabel(reason.code));
    }
  }
  for (const key of next.blockedBy) {
    if (key !== next.key && !relations.has(key)) relations.set(key, "blocked by");
  }
  const related = [...relations].map(([key, relation]) => ({ key, relation }));
  const candidates = [
    ...(next.kind === "PullRequest" && next.pullRequest ? [next] : []),
    ...related
      .map(({ key }) => items.find((item) => item.key === key))
      .filter((item): item is PlanItem => item?.kind === "PullRequest" && !!item.pullRequest),
  ];

  if (next.action === "resolve-competing" && candidates.length > 1) {
    const ranked = [...candidates].sort((a, b) => {
      const readinessDelta = readiness(b) - readiness(a);
      if (readinessDelta) return readinessDelta;
      const updatedDelta =
        Date.parse(b.pullRequest?.updatedAt ?? "") - Date.parse(a.pullRequest?.updatedAt ?? "");
      return updatedDelta || a.key.localeCompare(b.key);
    });
    const first = ranked[0];
    const second = ranked[1];
    const firstReadiness = readiness(first);
    const secondReadiness = readiness(second);
    const basis: string[] = [];
    if (first.pullRequest?.reviewDecision === "APPROVED") {
      basis.push("GitHub reports it approved.");
    }
    if (first.pullRequest?.mergeable === "MERGEABLE") {
      basis.push("GitHub reports it mergeable.");
    }
    if (!first.pullRequest?.isDraft) basis.push("It is open for review, not a draft.");
    const firstUpdated = Date.parse(first.pullRequest?.updatedAt ?? "");
    const secondUpdated = Date.parse(second.pullRequest?.updatedAt ?? "");
    if (
      firstReadiness === secondReadiness &&
      Number.isFinite(firstUpdated) &&
      Number.isFinite(secondUpdated) &&
      firstUpdated > secondUpdated
    ) {
      basis.push("It was updated more recently than the other competing PR.");
    }
    const reviewFirst =
      firstReadiness > secondReadiness || firstUpdated > secondUpdated ? first.key : null;
    return {
      kind: "compare-pull-requests",
      focalKey: next.key,
      related,
      reviewFirst,
      summary: reviewFirst
        ? `Review ${reviewFirst} first, then compare its behavior and scope with the other implementation.`
        : "No competing PR is clearly ahead from the observed GitHub readiness signals.",
      basis,
      caveat:
        "This orders the review. It does not choose the winning implementation or prove acceptance criteria.",
    };
  }

  return {
    kind: related.length ? "inspect-related-work" : "independent",
    focalKey: next.key,
    related,
    reviewFirst: null,
    summary: related.length
      ? "Inspect the directly related work before acting on the focal item."
      : "The next action is independent in the observed graph.",
    basis: [],
    caveat: "Validate repository-specific behavior before mutating GitHub.",
  };
}

export function buildPlanReport(
  reconcile: ReconcileReport,
  nodes: Map<NodeKey, GraphNode>,
  priorities: PriorityRow[],
): PlanReport {
  const ranked = priorityMap(priorities);
  const unresolved = new Set([...reconcile.limits.fetchFailures, ...reconcile.limits.cappedOut]);
  const items = reconcile.items.map((item) => planItem(item, nodes, ranked, unresolved));
  const queue = items.filter((item) => item.status === "ready").sort(byPlanOrder);
  const investigation = items
    .filter((item) => item.status === "needs-investigation")
    .sort(byPlanOrder);
  const blocked = items.filter((item) => item.status === "blocked").sort(byPlanOrder);
  const coverageComplete =
    !reconcile.limits.seedLimitReached &&
    reconcile.limits.cappedOut.length === 0 &&
    reconcile.limits.fetchFailures.length === 0;
  const failedSeeds = reconcile.seeds.filter((key) => reconcile.limits.fetchFailures.includes(key));
  const recommendationSafe =
    !reconcile.limits.seedLimitReached &&
    failedSeeds.length === 0 &&
    reconcile.limits.cappedOut.length === 0;
  const guardrails = [...reconcile.nextSteps];
  if (!recommendationSafe) {
    guardrails.unshift(
      "The queue is provisional. Complete backlog coverage before acting on the recommended next item.",
    );
  } else if (!coverageComplete) {
    guardrails.unshift(
      "Unresolved neighbor references were quarantined to their affected items. The recommended next item does not depend on them.",
    );
  }

  const next = recommendationSafe ? (queue[0] ?? null) : null;
  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    repo: reconcile.repo,
    generatedAt: reconcile.generatedAt,
    coverageComplete,
    recommendationSafe,
    provisional: !recommendationSafe,
    coverage: reconcile.limits,
    counts: {
      openItems: items.length,
      ready: queue.length,
      needsInvestigation: investigation.length,
      blocked: blocked.length,
    },
    next,
    decision: buildDecision(next, items),
    queue,
    investigation,
    blocked,
    guardrails,
  };
}

function renderItem(item: PlanItem, index?: number): string[] {
  const prefix = index == null ? "-" : `${index}.`;
  const out = [
    `${prefix} [${item.key}](${item.url}) ${item.title}`,
    `   - ${item.action} · score ${Math.round(item.score * 10) / 10} · heat ${item.heatScore} · visible impact ${item.visibleImpact}`,
    `   - Next: ${item.recommendedAction}`,
  ];
  if (item.blockedBy.length) out.push(`   - Blocked by: ${item.blockedBy.join(", ")}`);
  return out;
}

function renderDecision(decision: PlanDecision): string[] {
  const out = ["## Decision", "", `- ${decision.summary}`];
  for (const related of decision.related) {
    out.push(`- ${related.key}: ${related.relation}`);
  }
  if (decision.basis.length) {
    out.push("- Basis:");
    for (const basis of decision.basis) out.push(`  - ${basis}`);
  }
  out.push(`- Caveat: ${decision.caveat}`);
  return out;
}

export function renderPlan(report: PlanReport): string {
  const out = [
    `# Backlog plan: ${report.repo}`,
    "",
    `- Open items: ${report.counts.openItems}`,
    `- Ready actions: ${report.counts.ready}`,
    `- Needs investigation: ${report.counts.needsInvestigation}`,
    `- Blocked: ${report.counts.blocked}`,
    `- Coverage: ${report.coverageComplete ? "complete" : "incomplete"}`,
    `- Recommendation: ${report.recommendationSafe ? "safe from observed coverage gaps" : "withheld, queue is provisional"}`,
    "",
    "## Next",
    "",
  ];
  if (report.next) {
    out.push(...renderItem(report.next));
  } else if (!report.recommendationSafe) {
    out.push("- No recommendation until backlog coverage is complete.");
  } else {
    out.push("- No ready action. Investigate or unblock the remaining items.");
  }
  if (report.decision) out.push("", ...renderDecision(report.decision));
  if (!report.coverageComplete) {
    out.push(
      "",
      "## Coverage gaps",
      "",
      `- Seed limit reached: ${report.coverage.seedLimitReached ? "yes" : "no"}`,
      `- Fetch failures: ${report.coverage.fetchFailures.length ? report.coverage.fetchFailures.join(", ") : "none"}`,
      `- Capped out: ${report.coverage.cappedOut.length ? report.coverage.cappedOut.join(", ") : "none"}`,
    );
  }
  out.push("", "## Execution queue", "");
  if (report.queue.length) {
    for (const [index, item] of report.queue.entries()) {
      out.push(...renderItem(item, index + 1));
    }
  } else {
    out.push("- No ready actions.");
  }
  out.push("", "## Investigation queue", "");
  if (report.investigation.length) {
    for (const [index, item] of report.investigation.entries()) {
      out.push(...renderItem(item, index + 1));
    }
  } else {
    out.push("- No items awaiting investigation.");
  }
  out.push("", "## Blocked", "");
  if (report.blocked.length) {
    for (const item of report.blocked) {
      out.push(...renderItem(item));
    }
  } else {
    out.push("- No blocked items.");
  }
  out.push("", "## Guardrails", "", ...report.guardrails.map((guardrail) => `- ${guardrail}`));
  return `${out.join("\n")}\n`;
}
