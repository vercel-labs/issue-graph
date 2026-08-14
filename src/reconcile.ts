import type { GraphNode, NodeKey } from "./types.js";

export const RECONCILE_SCHEMA_VERSION = 1 as const;

export type ReconcileAction =
  | "close-superseded"
  | "verify-superseded"
  | "resolve-competing"
  | "repair-closing-link"
  | "verify-completed"
  | "review-open-pr"
  | "keep-linked"
  | "keep-untracked";

export type ReconcileConfidence = "high" | "medium" | "low";

export interface ReconcileItem {
  key: NodeKey;
  kind: "Issue" | "PullRequest";
  title: string;
  url: string;
  action: ReconcileAction;
  confidence: ReconcileConfidence;
  evidence: string[];
  recommendedAction: string;
}

export interface ReconcileReport {
  schemaVersion: typeof RECONCILE_SCHEMA_VERSION;
  repo: string;
  generatedAt: string;
  seeds: NodeKey[];
  counts: {
    openIssues: number;
    openPullRequests: number;
    byAction: Record<ReconcileAction, number>;
  };
  items: ReconcileItem[];
  limits: {
    seedLimit: number;
    seedLimitReached: boolean;
    nodeCap: number;
    nodesObserved: number;
    fetchFailures: NodeKey[];
    cappedOut: NodeKey[];
  };
  nextSteps: string[];
}

export interface ReconcileOptions {
  repo: string;
  seeds: NodeKey[];
  seedLimit: number;
  nodeCap: number;
  cappedOut: Iterable<NodeKey>;
  generatedAt?: string;
}

const ACTION_ORDER: ReconcileAction[] = [
  "close-superseded",
  "verify-superseded",
  "resolve-competing",
  "repair-closing-link",
  "verify-completed",
  "review-open-pr",
  "keep-linked",
  "keep-untracked",
];

const ACTION_TITLES: Record<ReconcileAction, string> = {
  "close-superseded": "Close superseded PRs",
  "verify-superseded": "Verify possibly superseded PRs",
  "resolve-competing": "Resolve competing work",
  "repair-closing-link": "Repair missing closing links",
  "verify-completed": "Verify completed issues",
  "review-open-pr": "Review open PRs",
  "keep-linked": "Keep linked issues",
  "keep-untracked": "Untracked open issues",
};

function relatedPrs(issue: GraphNode, nodes: Map<NodeKey, GraphNode>): GraphNode[] {
  return [...nodes.values()].filter(
    (node) =>
      node.kind === "PullRequest" &&
      (node.edges.some((edge) => edge.to === issue.key) ||
        issue.edges.some((edge) => edge.to === node.key)),
  );
}

function closingPrs(issue: GraphNode, nodes: Map<NodeKey, GraphNode>): GraphNode[] {
  return [...nodes.values()].filter(
    (node) =>
      node.kind === "PullRequest" &&
      node.edges.some((edge) => edge.to === issue.key && edge.via === "closes"),
  );
}

function issueItem(issue: GraphNode, nodes: Map<NodeKey, GraphNode>): ReconcileItem {
  const related = relatedPrs(issue, nodes);
  const closers = closingPrs(issue, nodes);
  const mergedClosers = closers.filter((node) => node.state === "MERGED");
  const mergedRelated = related.filter((node) => node.state === "MERGED");
  const openRelated = related.filter((node) => node.state === "OPEN");
  const openClosers = closers.filter((node) => node.state === "OPEN");

  if (mergedClosers.length) {
    return {
      key: issue.key,
      kind: "Issue",
      title: issue.title,
      url: issue.url,
      action: "verify-completed",
      confidence: "medium",
      evidence: [`Merged closing work: ${mergedClosers.map((node) => node.key).join(", ")}`],
      recommendedAction:
        "Verify acceptance criteria against main and live behavior, then close if satisfied.",
    };
  }
  if (mergedRelated.length) {
    return {
      key: issue.key,
      kind: "Issue",
      title: issue.title,
      url: issue.url,
      action: "verify-completed",
      confidence: "low",
      evidence: [`Merged related work: ${mergedRelated.map((node) => node.key).join(", ")}`],
      recommendedAction:
        "Compare the issue scope with the merged work before deciding whether to close it.",
    };
  }
  if (openClosers.length > 1) {
    return {
      key: issue.key,
      kind: "Issue",
      title: issue.title,
      url: issue.url,
      action: "resolve-competing",
      confidence: "high",
      evidence: [`Open closing PRs: ${openClosers.map((node) => node.key).join(", ")}`],
      recommendedAction:
        "Choose one implementation path and respond to every contributor before closing duplicates.",
    };
  }
  if (openRelated.length) {
    const structural = openClosers.length > 0;
    return {
      key: issue.key,
      kind: "Issue",
      title: issue.title,
      url: issue.url,
      action: "keep-linked",
      confidence: structural ? "high" : "medium",
      evidence: [`Open related work: ${openRelated.map((node) => node.key).join(", ")}`],
      recommendedAction: structural
        ? "Keep the issue open until the linked PR is resolved."
        : "Confirm that the related PR covers the issue and add an explicit closing link if appropriate.",
    };
  }
  return {
    key: issue.key,
    kind: "Issue",
    title: issue.title,
    url: issue.url,
    action: "keep-untracked",
    confidence: "high",
    evidence: ["No open or merged PR relationship was found in the crawled graph."],
    recommendedAction:
      "Reproduce or inspect the issue before prioritizing, closing, or shaping work from it.",
  };
}

function pullRequestItem(pr: GraphNode, nodes: Map<NodeKey, GraphNode>): ReconcileItem {
  const targets = pr.edges.filter((edge) => edge.via === "closes").map((edge) => edge.to);
  const superseders = [...nodes.values()].filter(
    (node) =>
      node.kind === "PullRequest" &&
      node.key !== pr.key &&
      node.state === "MERGED" &&
      node.edges.some((edge) => edge.via === "closes" && targets.includes(edge.to)),
  );
  if (superseders.length) {
    return {
      key: pr.key,
      kind: "PullRequest",
      title: pr.title,
      url: pr.url,
      action: "close-superseded",
      confidence: "high",
      evidence: [
        `Merged PRs close the same issue: ${superseders.map((node) => node.key).join(", ")}`,
      ],
      recommendedAction:
        "Verify scope parity, credit the contributor, and close if the merged work fully supersedes it.",
    };
  }
  const possible = possiblySupersededBy(pr, nodes);
  if (possible) {
    return {
      key: pr.key,
      kind: "PullRequest",
      title: pr.title,
      url: pr.url,
      action: "verify-superseded",
      confidence: "medium",
      evidence: [`Merged ${possible.pr} closed related ${possible.issue} after this PR opened.`],
      recommendedAction:
        "Compare the diff and intended behavior before deciding whether to close it.",
    };
  }
  const missing = (pr.flags ?? []).filter((flag) => flag.includes("no closing link"));
  if (missing.length) {
    return {
      key: pr.key,
      kind: "PullRequest",
      title: pr.title,
      url: pr.url,
      action: "repair-closing-link",
      confidence: "high",
      evidence: missing,
      recommendedAction: "Add or correct the GitHub closing reference before merge.",
    };
  }
  const competing = (pr.flags ?? []).filter((flag) => flag.startsWith("competes with"));
  if (competing.length) {
    return {
      key: pr.key,
      kind: "PullRequest",
      title: pr.title,
      url: pr.url,
      action: "resolve-competing",
      confidence: "high",
      evidence: competing,
      recommendedAction:
        "Choose the preferred implementation and respond to all affected contributors.",
    };
  }
  return {
    key: pr.key,
    kind: "PullRequest",
    title: pr.title,
    url: pr.url,
    action: "review-open-pr",
    confidence: "high",
    evidence: ["The PR is open and was not classified as superseded or competing."],
    recommendedAction: "Run the repository review gate on the exact latest SHA.",
  };
}

function possiblySupersededBy(
  pr: GraphNode,
  nodes: Map<NodeKey, GraphNode>,
): { pr: NodeKey; issue: NodeKey } | undefined {
  const openedAt = Date.parse(pr.pr?.createdAt ?? "");
  if (!Number.isFinite(openedAt)) return undefined;
  const relatedIssues = [...nodes.values()].filter(
    (node) =>
      node.kind === "Issue" &&
      node.state === "CLOSED" &&
      (pr.edges.some(
        (edge) => edge.to === node.key && (edge.via === "cross-ref" || edge.via === "connected"),
      ) ||
        node.edges.some(
          (edge) => edge.to === pr.key && (edge.via === "cross-ref" || edge.via === "connected"),
        )),
  );
  for (const issue of relatedIssues.sort((a, b) => a.key.localeCompare(b.key))) {
    const merged = [...nodes.values()]
      .filter(
        (node) =>
          node.kind === "PullRequest" &&
          node.key !== pr.key &&
          node.state === "MERGED" &&
          Number.isFinite(Date.parse(node.pr?.mergedAt ?? "")) &&
          Date.parse(node.pr?.mergedAt ?? "") >= openedAt &&
          node.edges.some((edge) => edge.to === issue.key && edge.via === "closes"),
      )
      .sort((a, b) => a.key.localeCompare(b.key))[0];
    if (merged) return { pr: merged.key, issue: issue.key };
  }
  return undefined;
}

export function buildReconcileReport(
  nodes: Map<NodeKey, GraphNode>,
  options: ReconcileOptions,
): ReconcileReport {
  const open = [...nodes.values()].filter(
    (node) => `${node.owner}/${node.repo}` === options.repo && node.state === "OPEN",
  );
  const items = open
    .filter((node): node is GraphNode & { kind: "Issue" | "PullRequest" } =>
      ["Issue", "PullRequest"].includes(node.kind),
    )
    .map((node) => (node.kind === "Issue" ? issueItem(node, nodes) : pullRequestItem(node, nodes)))
    .sort((a, b) => {
      const action = ACTION_ORDER.indexOf(a.action) - ACTION_ORDER.indexOf(b.action);
      return action || a.key.localeCompare(b.key);
    });
  const byAction = Object.fromEntries(ACTION_ORDER.map((action) => [action, 0])) as Record<
    ReconcileAction,
    number
  >;
  for (const item of items) byAction[item.action]++;
  return {
    schemaVersion: RECONCILE_SCHEMA_VERSION,
    repo: options.repo,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    seeds: options.seeds,
    counts: {
      openIssues: items.filter((item) => item.kind === "Issue").length,
      openPullRequests: items.filter((item) => item.kind === "PullRequest").length,
      byAction,
    },
    items,
    limits: {
      seedLimit: options.seedLimit,
      seedLimitReached: options.seeds.length >= options.seedLimit,
      nodeCap: options.nodeCap,
      nodesObserved: nodes.size,
      fetchFailures: [...nodes.values()]
        .filter((node) => !node.fetched)
        .map((node) => node.key)
        .sort(),
      cappedOut: [...options.cappedOut].sort(),
    },
    nextSteps: [
      "Verify candidates against current main, acceptance criteria, and live behavior before changing GitHub state.",
      "Run the repository review gate on every PR selected for merge.",
      "If no actionable work remains, dogfood the product and inspect the codebase before proposing a direction.",
    ],
  };
}

export function renderReconcile(report: ReconcileReport): string {
  const out = [
    `# Backlog reconciliation: ${report.repo}`,
    "",
    `- Open issues: ${report.counts.openIssues}`,
    `- Open PRs: ${report.counts.openPullRequests}`,
    `- Graph nodes observed: ${report.limits.nodesObserved}/${report.limits.nodeCap}`,
  ];
  if (report.limits.seedLimitReached)
    out.push(`- Seed search reached its ${report.limits.seedLimit} item limit`);
  if (report.limits.cappedOut.length)
    out.push(`- Node cap omitted ${report.limits.cappedOut.length} referenced items`);
  if (report.limits.fetchFailures.length)
    out.push(`- GitHub could not return ${report.limits.fetchFailures.length} graph nodes`);
  for (const action of ACTION_ORDER) {
    const items = report.items.filter((item) => item.action === action);
    if (!items.length) continue;
    out.push("", `## ${ACTION_TITLES[action]}`, "");
    for (const item of items) {
      out.push(`- [${item.key}](${item.url}) ${item.title}`);
      out.push(`  - Confidence: ${item.confidence}`);
      for (const evidence of item.evidence) out.push(`  - Evidence: ${evidence}`);
      out.push(`  - Next: ${item.recommendedAction}`);
    }
  }
  out.push("", "## Guardrail", "", ...report.nextSteps.map((step) => `- ${step}`));
  return `${out.join("\n")}\n`;
}
