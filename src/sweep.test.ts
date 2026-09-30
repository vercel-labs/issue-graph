import { describe, expect, test } from "vitest";
import { buildPlanReport, renderPlan } from "./plan.js";
import { prioritize } from "./priority.js";
import { buildReconcileReport } from "./reconcile.js";
import { buildSweep, missingBasePaths, sweepBasePaths } from "./sweep.js";
import type { GhTransport } from "./transport.js";
import type { GraphNode, NodeKey } from "./types.js";

const NOW = new Date("2026-09-29T00:00:00.000Z");

function issue(key: NodeKey): GraphNode {
  return base(key, "Issue");
}

function pr(
  key: NodeKey,
  opts: { closes?: NodeKey; files?: string[]; baseFiles?: string[]; size?: number } = {},
): GraphNode {
  const node = base(key, "PullRequest");
  if (opts.closes) node.edges = [{ to: opts.closes, via: "closes" }];
  node.pr = {
    isDraft: false,
    reviewDecision: "REVIEW_REQUIRED",
    mergeable: "MERGEABLE",
    createdAt: "2026-09-01T00:00:00.000Z",
    mergedAt: "",
    updatedAt: "2026-09-01T00:00:00.000Z",
    additions: opts.size ?? 10,
    deletions: 0,
    changedFiles: (opts.files ?? []).length,
    files: opts.files ?? [],
    baseFiles: opts.baseFiles ?? opts.files ?? [],
  };
  return node;
}

function base(key: NodeKey, kind: "Issue" | "PullRequest"): GraphNode {
  const [repoKey, rawNumber] = key.split("#");
  const [owner, repo] = repoKey.split("/");
  return {
    key,
    owner,
    repo,
    number: Number(rawNumber),
    kind,
    title: `${kind} ${rawNumber}`,
    state: "OPEN",
    url: `https://github.com/${repoKey}/issues/${rawNumber}`,
    depth: 0,
    edges: [],
    externalLinks: [],
    fetched: true,
    heat: { createdAt: "2026-09-01T00:00:00.000Z", comments: 0, participants: 0, reactions: 0 },
  };
}

function reconcileOf(values: GraphNode[]) {
  const nodes = new Map(values.map((value) => [value.key, value]));
  const reconcile = buildReconcileReport(nodes, {
    repo: "o/r",
    seeds: values.map((value) => value.key),
    seedLimit: 80,
    nodeCap: 80,
    cappedOut: [],
    generatedAt: NOW.toISOString(),
  });
  return { nodes, reconcile };
}

describe("buildSweep", () => {
  test("puts groups whose PRs only edit removed files before live competing work", () => {
    const { nodes } = reconcileOf([
      issue("o/r#1"),
      pr("o/r#2", { closes: "o/r#1", files: ["src/a.rs"], size: 11 }),
      pr("o/r#3", { closes: "o/r#1", files: ["src/a.rs"], size: 38 }),
      issue("o/r#10"),
      pr("o/r#11", { closes: "o/r#10", files: ["src/old.ts"] }),
      pr("o/r#12", { closes: "o/r#10", files: ["src/old.ts", "src/gone.ts"] }),
    ]);
    const groups = buildSweep(nodes, new Map([["o/r", new Set(["src/old.ts", "src/gone.ts"])]]));

    expect(groups.map((group) => group.issue)).toEqual(["o/r#10", "o/r#1"]);
    expect(groups[0].allStale).toBe(true);
    expect(groups[0].next).toBe("verify");
    expect(groups[0].resolves).toBe(3);
    expect(groups[1].next).toBe("choose");
    expect(groups[1].allStale).toBe(false);
    expect(groups[1].smallestChange).toBe(11);
  });

  test("groups PRs that change the same source files without a shared issue", () => {
    const { nodes } = reconcileOf([
      issue("o/r#1"),
      pr("o/r#2", { closes: "o/r#1", files: ["src/certs.ts", "README.md"] }),
      pr("o/r#3", { files: ["src/certs.ts", "src/certs.test.ts"] }),
      pr("o/r#4", { files: ["README.md"] }),
    ]);
    const groups = buildSweep(nodes, null);

    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe("overlap");
    expect(groups[0].next).toBe("compare");
    expect(groups[0].pullRequests.map((item) => item.key)).toEqual(["o/r#2", "o/r#3"]);
    expect(groups[0].sharedFiles).toEqual(["src/certs.ts"]);
    expect(groups[0].overlapScore).toBeGreaterThan(0);
  });

  test("ranks PRs editing the same few files above large PRs sharing one hot file", () => {
    const hot = ["src/cli.ts"];
    const { nodes } = reconcileOf([
      pr("o/r#20", { files: [...hot, "src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"] }),
      pr("o/r#21", { files: [...hot, "src/e.ts", "src/f.ts", "src/g.ts", "src/h.ts"] }),
      pr("o/r#30", { files: ["src/certs.ts", "src/certs.test.ts"] }),
      pr("o/r#31", { files: ["src/certs.ts", "src/certs.test.ts", "src/cli.ts"] }),
    ]);
    const groups = buildSweep(nodes, null);
    expect(groups[0].pullRequests.map((item) => item.key)).toEqual(["o/r#30", "o/r#31"]);
    expect(groups.every((group) => group.pullRequests.length === 2)).toBe(true);
  });

  test("does not repeat a competing pair as an overlap", () => {
    const { nodes } = reconcileOf([
      issue("o/r#1"),
      pr("o/r#2", { closes: "o/r#1", files: ["src/a.ts"] }),
      pr("o/r#3", { closes: "o/r#1", files: ["src/a.ts"] }),
    ]);
    expect(buildSweep(nodes, null).map((group) => group.kind)).toEqual(["competing"]);
  });

  test("reports stale as unknown when the base was not checked, and partial when some files remain", () => {
    const { nodes } = reconcileOf([
      issue("o/r#1"),
      pr("o/r#2", { closes: "o/r#1", files: ["src/a.ts", "src/b.ts"] }),
      pr("o/r#3", { closes: "o/r#1", files: ["src/a.ts"] }),
    ]);
    expect(buildSweep(nodes, null)[0].pullRequests[0].staleBase).toBeNull();

    const [group] = buildSweep(nodes, new Map([["o/r", new Set(["src/a.ts"])]]));
    expect(group.pullRequests[0]).toMatchObject({ staleBase: false, missingOnBase: ["src/a.ts"] });
    expect(group.pullRequests[1].staleBase).toBe(true);
    expect(group.allStale).toBe(false);
  });

  test("lists a PR whose files are all gone as its own stale group", () => {
    const { nodes } = reconcileOf([
      issue("o/r#1"),
      pr("o/r#2", { closes: "o/r#1", files: ["src/old.ts"] }),
      pr("o/r#3", { files: ["src/live.rs"] }),
    ]);
    const groups = buildSweep(nodes, new Map([["o/r", new Set(["src/old.ts"])]]));
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ kind: "stale", issue: "o/r#1", resolves: 2, allStale: true });
  });

  test("finds competing PRs from closing links, whatever reconcile decided", () => {
    const merged = pr("o/r#9", { closes: "o/r#1" });
    merged.state = "MERGED";
    const { nodes } = reconcileOf([
      issue("o/r#1"),
      merged,
      pr("o/r#2", { closes: "o/r#1", files: ["src/a.ts"] }),
      pr("o/r#3", { closes: "o/r#1", files: ["src/b.ts"] }),
    ]);
    const [group] = buildSweep(nodes, null);
    expect(group.kind).toBe("competing");
    expect(group.pullRequests.map((item) => item.key)).toEqual(["o/r#2", "o/r#3"]);
  });

  test("never marks a PR stale for files it adds", () => {
    const { nodes } = reconcileOf([
      issue("o/r#1"),
      pr("o/r#2", { closes: "o/r#1", files: ["src/new.ts"], baseFiles: [] }),
      pr("o/r#3", { closes: "o/r#1", files: ["src/new.ts"], baseFiles: [] }),
    ]);
    const [group] = buildSweep(nodes, new Map([["o/r", new Set(["src/new.ts"])]]));
    expect(group.pullRequests.map((item) => item.staleBase)).toEqual([null, null]);
  });
});

describe("missingBasePaths", () => {
  test("asks the default branch for each path and returns the absent ones", async () => {
    const { nodes } = reconcileOf([
      issue("o/r#1"),
      pr("o/r#2", { closes: "o/r#1", files: ["src/live.rs"] }),
      pr("o/r#3", { closes: "o/r#1", files: ["src/gone.ts"] }),
    ]);
    const seen: Array<Record<string, string | number>> = [];
    const transport: GhTransport = {
      async graphql(_query, variables = {}) {
        seen.push(variables);
        const repository: Record<string, unknown> = {};
        for (const [name, value] of Object.entries(variables)) {
          if (!name.startsWith("e")) continue;
          repository[`f${name.slice(1)}`] =
            value === "HEAD:src/live.rs" ? { __typename: "Blob" } : null;
        }
        return { data: { repository } };
      },
      async search() {
        return [];
      },
    };
    const missing = await missingBasePaths(transport, sweepBasePaths(nodes));
    expect([...(missing.get("o/r") ?? [])]).toEqual(["src/gone.ts"]);
    expect(seen[0]).toMatchObject({ o: "o", r: "r" });
  });

  test("leaves a repository unchecked when the query fails", async () => {
    const transport: GhTransport = {
      async graphql() {
        return { errors: [{ message: "rate limited" }] };
      },
      async search() {
        return [];
      },
    };
    const missing = await missingBasePaths(transport, new Map([["o/r", new Set(["src/a.ts"])]]));
    expect(missing.has("o/r")).toBe(false);
  });
});

describe("plan sweep lane", () => {
  test("renders the sweep groups in the plan", () => {
    const { nodes, reconcile } = reconcileOf([
      issue("o/r#1"),
      pr("o/r#2", { closes: "o/r#1", files: ["src/old.ts"] }),
      pr("o/r#3", { closes: "o/r#1", files: ["src/old.ts"] }),
    ]);
    const sweep = buildSweep(nodes, new Map([["o/r", new Set(["src/old.ts"])]]));
    const plan = buildPlanReport(reconcile, nodes, prioritize(nodes, NOW), sweep);
    expect(plan.sweep).toHaveLength(1);
    const text = renderPlan(plan);
    expect(text).toContain("## Sweep");
    expect(text).toContain("[verify] o/r#1 + o/r#2, o/r#3 · resolves 3 · stale base");
  });
});
