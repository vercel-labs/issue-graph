import { describe, expect, test } from "bun:test";
import { buildReconcileReport, renderReconcile } from "./reconcile.js";
import type { GraphNode, NodeKey } from "./types.js";

function node(
  key: NodeKey,
  kind: "Issue" | "PullRequest",
  state: string,
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
  };
}

function report(values: GraphNode[]) {
  return buildReconcileReport(new Map(values.map((value) => [value.key, value])), {
    repo: "o/r",
    seeds: ["o/r#1"],
    seedLimit: 80,
    nodeCap: 80,
    cappedOut: [],
    generatedAt: "2026-08-14T00:00:00.000Z",
  });
}

describe("buildReconcileReport", () => {
  test("nominates an issue with merged closing work for behavioral verification", () => {
    const result = report([
      node("o/r#1", "Issue", "OPEN"),
      node("o/r#2", "PullRequest", "MERGED", [{ to: "o/r#1", via: "closes" }]),
    ]);
    expect(result.items[0]).toMatchObject({
      key: "o/r#1",
      action: "verify-completed",
      confidence: "medium",
      evidence: [
        {
          code: "merged-closing-work",
          related: ["o/r#2"],
        },
      ],
    });
    expect(result.nextSteps).toEqual([
      "Verify nominated actions against current main, acceptance criteria, and live behavior before changing GitHub state.",
    ]);
  });

  test("finds an open PR superseded by merged work on the same issue", () => {
    const result = report([
      node("o/r#1", "Issue", "CLOSED"),
      node("o/r#2", "PullRequest", "OPEN", [{ to: "o/r#1", via: "closes" }]),
      node("o/r#3", "PullRequest", "MERGED", [{ to: "o/r#1", via: "closes" }]),
    ]);
    expect(result.items[0]).toMatchObject({
      key: "o/r#2",
      action: "close-superseded",
      confidence: "high",
    });
  });

  test("finds possible supersession even when the open PR is a seed", () => {
    const issue = node("o/r#1", "Issue", "CLOSED", [{ to: "o/r#2", via: "cross-ref" }]);
    const open = node("o/r#2", "PullRequest", "OPEN");
    open.pr = {
      isDraft: false,
      reviewDecision: "",
      mergeable: "MERGEABLE",
      createdAt: "2026-01-01T00:00:00.000Z",
      mergedAt: "",
      updatedAt: "2026-01-01T00:00:00.000Z",
      additions: 1,
      deletions: 0,
      changedFiles: 1,
      files: ["src/a.ts"],
    };
    const merged = node("o/r#3", "PullRequest", "MERGED", [{ to: issue.key, via: "closes" }]);
    merged.pr = {
      ...open.pr,
      createdAt: "2026-01-02T00:00:00.000Z",
      mergedAt: "2026-01-03T00:00:00.000Z",
    };
    const result = report([issue, open, merged]);
    expect(result.items[0]).toMatchObject({
      key: "o/r#2",
      action: "verify-superseded",
      confidence: "medium",
    });
  });

  test("keeps unlinked issues explicit instead of declaring them stale", () => {
    const result = report([node("o/r#1", "Issue", "OPEN")]);
    expect(result.items[0]).toMatchObject({
      action: "keep-untracked",
      confidence: "high",
      evidence: [{ code: "no-related-pr", related: [] }],
    });
    expect(result.nextSteps).toEqual([
      "Reproduce or inspect untracked issues before prioritizing or closing them.",
    ]);
  });

  test("reports competing PRs and deterministic counts", () => {
    const issue = node("o/r#1", "Issue", "OPEN");
    const first = node("o/r#2", "PullRequest", "OPEN", [{ to: issue.key, via: "closes" }]);
    const second = node("o/r#3", "PullRequest", "OPEN", [{ to: issue.key, via: "closes" }]);
    first.flags = ["competes with o/r#3 to close o/r#1"];
    second.flags = ["competes with o/r#2 to close o/r#1"];
    const result = report([issue, first, second]);
    expect(result.counts.byAction["resolve-competing"]).toBe(3);
    expect(result.items.map((item) => item.key)).toEqual(["o/r#1", "o/r#2", "o/r#3"]);
    expect(result.items.map((item) => item.evidence[0])).toMatchObject([
      { code: "multiple-open-closing-prs", related: ["o/r#2", "o/r#3"] },
      { code: "competing-open-pr", related: ["o/r#1", "o/r#3"] },
      { code: "competing-open-pr", related: ["o/r#1", "o/r#2"] },
    ]);
  });

  test("reports node fetch failures as incomplete evidence", () => {
    const failed = node("o/r#1", "Issue", "FETCH_ERROR");
    failed.fetched = false;
    const result = report([failed]);
    expect(result.limits.fetchFailures).toEqual(["o/r#1"]);
    expect(result.counts.openIssues).toBe(0);
    expect(result.nextSteps).toEqual([
      "Retry failed graph nodes before acting on their absence from this report.",
    ]);
  });

  test("gives an empty backlog only the discovery next step", () => {
    const result = buildReconcileReport(new Map(), {
      repo: "o/r",
      seeds: [],
      seedLimit: 80,
      nodeCap: 80,
      cappedOut: [],
      generatedAt: "2026-08-14T00:00:00.000Z",
    });
    expect(result.items).toEqual([]);
    expect(result.nextSteps).toEqual([
      "Dogfood the product and inspect repository intent before proposing the next direction.",
    ]);
  });

  test("puts incomplete coverage before item-specific actions", () => {
    const result = buildReconcileReport(
      new Map([["o/r#1", node("o/r#1", "PullRequest", "OPEN")]]),
      {
        repo: "o/r",
        seeds: ["o/r#1"],
        seedLimit: 1,
        nodeCap: 1,
        cappedOut: ["o/r#2"],
        generatedAt: "2026-08-14T00:00:00.000Z",
      },
    );
    expect(result.nextSteps).toEqual([
      "Increase --max-nodes or re-seed omitted neighborhoods before claiming full backlog coverage.",
      "Run the repository review gate on every PR selected for merge.",
    ]);
  });
});

describe("renderReconcile", () => {
  test("renders limits and verification guardrails", () => {
    const result = report([node("o/r#1", "Issue", "OPEN")]);
    const markdown = renderReconcile(result);
    expect(markdown).toContain("# Backlog reconciliation: o/r");
    expect(markdown).toContain("## Untracked open issues");
    expect(markdown).toContain("Evidence [no-related-pr]");
    expect(markdown).toContain("Reproduce or inspect untracked issues");
  });
});
