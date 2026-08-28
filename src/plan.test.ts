import { describe, expect, test } from "bun:test";
import { buildPlanReport, renderPlan } from "./plan.js";
import { prioritize } from "./priority.js";
import { buildReconcileReport } from "./reconcile.js";
import type { GraphNode, NodeKey } from "./types.js";

const NOW = new Date("2026-08-27T00:00:00.000Z");

function node(
  key: NodeKey,
  kind: "Issue" | "PullRequest",
  state = "OPEN",
  edges: GraphNode["edges"] = [],
): GraphNode {
  const [repoKey, rawNumber] = key.split("#");
  const [owner, repo] = repoKey.split("/");
  return {
    key,
    owner,
    repo,
    number: Number(rawNumber),
    kind,
    title: `${kind} ${rawNumber}`,
    state,
    url: `https://github.com/${repoKey}/issues/${rawNumber}`,
    depth: 0,
    edges,
    externalLinks: [],
    fetched: true,
    heat: {
      createdAt: "2026-08-01T00:00:00.000Z",
      comments: 0,
      participants: 0,
      reactions: 0,
    },
  };
}

function report(values: GraphNode[], cappedOut: NodeKey[] = []) {
  const nodes = new Map(values.map((value) => [value.key, value]));
  const reconcile = buildReconcileReport(nodes, {
    repo: "o/r",
    seeds: values.filter((value) => value.state === "OPEN").map((value) => value.key),
    seedLimit: 80,
    nodeCap: 80,
    cappedOut,
    generatedAt: NOW.toISOString(),
  });
  return buildPlanReport(reconcile, nodes, prioritize(nodes, NOW));
}

describe("buildPlanReport", () => {
  test("puts deterministic cleanup before ready pull request review", () => {
    const issue = node("o/r#1", "Issue", "CLOSED");
    const open = node("o/r#2", "PullRequest", "OPEN", [{ to: issue.key, via: "closes" }]);
    const merged = node("o/r#3", "PullRequest", "MERGED", [{ to: issue.key, via: "closes" }]);
    const review = node("o/r#4", "PullRequest");
    review.pr = {
      isDraft: false,
      reviewDecision: "APPROVED",
      mergeable: "MERGEABLE",
      createdAt: "2026-08-01T00:00:00.000Z",
      mergedAt: "",
      updatedAt: "2026-08-27T00:00:00.000Z",
      additions: 1,
      deletions: 0,
      changedFiles: 1,
      files: ["src/a.ts"],
    };
    const result = report([issue, open, merged, review]);
    expect(result.queue.map((item) => item.key)).toEqual(["o/r#2", "o/r#4"]);
    expect(result.next?.key).toBe("o/r#2");
  });

  test("blocks draft, conflicting, and linked work", () => {
    const draft = node("o/r#1", "PullRequest");
    draft.pr = {
      isDraft: true,
      reviewDecision: "",
      mergeable: "MERGEABLE",
      createdAt: "",
      mergedAt: "",
      updatedAt: "",
      additions: 0,
      deletions: 0,
      changedFiles: 0,
      files: [],
    };
    const conflict = node("o/r#2", "PullRequest");
    conflict.pr = { ...draft.pr, isDraft: false, mergeable: "CONFLICTING" };
    const issue = node("o/r#3", "Issue", "OPEN", [{ to: draft.key, via: "cross-ref" }]);
    const result = report([draft, conflict, issue]);
    expect(result.blocked.map((item) => item.key)).toEqual(["o/r#1", "o/r#2", "o/r#3"]);
    expect(result.blocked.find((item) => item.key === "o/r#3")?.blockedBy).toEqual(["o/r#1"]);
  });

  test("keeps untracked issues in an investigation queue", () => {
    const issue = node("o/r#1", "Issue");
    issue.heat = {
      createdAt: "2026-08-01T00:00:00.000Z",
      comments: 5,
      participants: 2,
      reactions: 0,
    };
    const result = report([issue]);
    expect(result.investigation[0]).toMatchObject({
      key: "o/r#1",
      lane: "investigate",
      status: "needs-investigation",
    });
    expect(result.next).toBeNull();
  });

  test("suppresses the next recommendation when coverage is incomplete", () => {
    const pr = node("o/r#1", "PullRequest");
    const result = report([pr], ["o/r#2"]);
    expect(result.provisional).toBe(true);
    expect(result.recommendationSafe).toBe(false);
    expect(result.queue).toHaveLength(1);
    expect(result.next).toBeNull();
    expect(result.coverage.cappedOut).toEqual(["o/r#2"]);
    expect(result.guardrails[0]).toContain("provisional");
  });

  test("quarantines an unresolved neighbor without freezing unrelated work", () => {
    const first = node("o/r#1", "PullRequest");
    const second = node("o/r#2", "PullRequest", "OPEN", [{ to: "external/repo#9", via: "text" }]);
    const failed = node("external/repo#9", "Issue", "FETCH_ERROR");
    failed.fetched = false;
    const result = report([first, second, failed]);
    expect(result.coverageComplete).toBe(false);
    expect(result.recommendationSafe).toBe(true);
    expect(result.next?.key).toBe("o/r#1");
    expect(result.blocked.find((item) => item.key === "o/r#2")?.blockedBy).toEqual([
      "external/repo#9",
    ]);
  });

  test("orders competing PR review from readiness signals without choosing a winner", () => {
    const issue = node("o/r#1", "Issue");
    const first = node("o/r#2", "PullRequest", "OPEN", [{ to: issue.key, via: "closes" }]);
    const second = node("o/r#3", "PullRequest", "OPEN", [{ to: issue.key, via: "closes" }]);
    first.pr = {
      isDraft: false,
      reviewDecision: "APPROVED",
      mergeable: "MERGEABLE",
      createdAt: "2026-08-01T00:00:00.000Z",
      mergedAt: "",
      updatedAt: "2026-08-27T00:00:00.000Z",
      additions: 100,
      deletions: 10,
      changedFiles: 4,
      files: ["src/a.ts"],
    };
    second.pr = {
      ...first.pr,
      reviewDecision: "",
      mergeable: "UNKNOWN",
      updatedAt: "2026-08-28T00:00:00.000Z",
      additions: 20,
      deletions: 5,
      changedFiles: 2,
    };
    const result = report([issue, first, second]);
    expect(result.decision).toMatchObject({
      kind: "compare-pull-requests",
      focalKey: "o/r#1",
      reviewFirst: "o/r#2",
    });
    expect(result.decision?.summary).toContain("Review o/r#2 first");
    expect(result.decision?.caveat).toContain("does not choose the winning implementation");
    expect(result.queue.find((item) => item.key === "o/r#2")?.pullRequest).toMatchObject({
      reviewDecision: "APPROVED",
      mergeable: "MERGEABLE",
      changedFiles: 4,
    });
  });

  test("compares both implementations when a competing PR is the next item", () => {
    const first = node("o/r#1", "PullRequest");
    const second = node("o/r#2", "PullRequest");
    first.flags = ["competes with o/r#2"];
    second.flags = ["competes with o/r#1"];
    first.pr = {
      isDraft: false,
      reviewDecision: "APPROVED",
      mergeable: "MERGEABLE",
      createdAt: "2026-08-01T00:00:00.000Z",
      mergedAt: "",
      updatedAt: "2026-08-27T00:00:00.000Z",
      additions: 10,
      deletions: 0,
      changedFiles: 1,
      files: ["src/a.ts"],
    };
    second.pr = {
      ...first.pr,
      reviewDecision: "",
      mergeable: "CONFLICTING",
      updatedAt: "2026-08-28T00:00:00.000Z",
    };
    const result = report([first, second]);
    expect(result.next?.key).toBe("o/r#1");
    expect(result.decision).toMatchObject({
      kind: "compare-pull-requests",
      focalKey: "o/r#1",
      reviewFirst: "o/r#1",
    });
  });
});

describe("renderPlan", () => {
  test("renders the next action and all queues", () => {
    const pr = node("o/r#1", "PullRequest");
    const issue = node("o/r#2", "Issue");
    const markdown = renderPlan(report([pr, issue]));
    expect(markdown).toContain("# Backlog plan: o/r");
    expect(markdown).toContain("## Next");
    expect(markdown).toContain("## Execution queue");
    expect(markdown).toContain("## Investigation queue");
    expect(markdown).toContain("## Blocked");
  });

  test("renders exact coverage gaps for provisional plans", () => {
    const markdown = renderPlan(report([node("o/r#1", "PullRequest")], ["o/r#2"]));
    expect(markdown).toContain("## Coverage gaps");
    expect(markdown).toContain("Capped out: o/r#2");
  });
});
