import { describe, expect, test } from "bun:test";
import type { ReconcileSnapshot } from "./snapshot.js";
import { diffReconcileSnapshots, diffSnapshots, reconcileSnapshotDir } from "./snapshot.js";
import type { Snapshot } from "./types.js";

const snap = (ts: string, nodes: Snapshot["nodes"]): Snapshot => ({ ts, nodes });

describe("diffSnapshots", () => {
  test("reports no changes for identical snapshots", () => {
    const a = snap("t0", [{ key: "o/r#1", kind: "Issue", state: "OPEN", title: "x", edges: [] }]);
    const b = snap("t1", [{ key: "o/r#1", kind: "Issue", state: "OPEN", title: "x", edges: [] }]);
    expect(diffSnapshots(a, b)).toContain("no changes");
  });

  test("detects new nodes, state changes, and new edges with attribution", () => {
    const prev = snap("t0", [
      { key: "o/r#1", kind: "PullRequest", state: "OPEN", title: "pr", edges: [] },
    ]);
    const now = snap("t1", [
      {
        key: "o/r#1",
        kind: "PullRequest",
        state: "MERGED",
        title: "pr",
        edges: [{ to: "o/r#2", via: "closes", by: "railly" }],
      },
      { key: "o/r#2", kind: "Issue", state: "CLOSED", title: "issue", edges: [] },
    ]);
    const out = diffSnapshots(prev, now);
    expect(out).toContain("o/r#1: OPEN → MERGED");
    expect(out).toContain("### New nodes");
    expect(out).toContain("o/r#2");
    expect(out).toContain("o/r#1 —closes→ o/r#2 (by @railly)");
  });

  test("reports removed nodes", () => {
    const prev = snap("t0", [
      { key: "o/r#9", kind: "Issue", state: "OPEN", title: "gone", edges: [] },
    ]);
    const now = snap("t1", []);
    expect(diffSnapshots(prev, now)).toContain("No longer referenced");
  });
});

describe("reconcile history", () => {
  test("uses a stable repository directory independent of seeds", () => {
    expect(reconcileSnapshotDir("o", "r")).toEndWith("/.issue-graph/reconcile-o-r");
  });

  test("reports safe deltas and suppresses resolved items when coverage regresses", () => {
    const prev: ReconcileSnapshot = {
      schemaVersion: 1,
      generatedAt: "2026-08-13T00:00:00.000Z",
      repo: "o/r",
      items: [
        { key: "o/r#1", action: "keep-untracked" },
        { key: "o/r#2", action: "review-open-pr" },
      ],
      coverageComplete: true,
    };
    const now: ReconcileSnapshot = {
      schemaVersion: 1,
      generatedAt: "2026-08-14T00:00:00.000Z",
      repo: "o/r",
      items: [
        { key: "o/r#1", action: "verify-completed" },
        { key: "o/r#3", action: "keep-untracked" },
      ],
      coverageComplete: false,
    };
    expect(diffReconcileSnapshots(prev, now)).toEqual({
      previousGeneratedAt: prev.generatedAt,
      added: [{ key: "o/r#3", action: "keep-untracked" }],
      changed: [{ key: "o/r#1", from: "keep-untracked", to: "verify-completed" }],
      resolved: [],
      coverageChange: "regressed",
    });
  });

  test("reports resolved items when the current coverage is complete", () => {
    const prev: ReconcileSnapshot = {
      schemaVersion: 1,
      generatedAt: "2026-08-13T00:00:00.000Z",
      repo: "o/r",
      items: [{ key: "o/r#2", action: "review-open-pr" }],
      coverageComplete: true,
    };
    const now: ReconcileSnapshot = {
      ...prev,
      generatedAt: "2026-08-14T00:00:00.000Z",
      items: [],
    };
    expect(diffReconcileSnapshots(prev, now).resolved).toEqual([
      { key: "o/r#2", previousAction: "review-open-pr" },
    ]);
  });

  test("reports recovered coverage without inventing action changes", () => {
    const prev: ReconcileSnapshot = {
      schemaVersion: 1,
      generatedAt: "2026-08-13T00:00:00.000Z",
      repo: "o/r",
      items: [],
      coverageComplete: false,
    };
    const now: ReconcileSnapshot = {
      ...prev,
      generatedAt: "2026-08-14T00:00:00.000Z",
      coverageComplete: true,
      items: [{ key: "o/r#1", action: "keep-untracked" }],
    };
    expect(diffReconcileSnapshots(prev, now)).toMatchObject({
      added: [],
      changed: [],
      resolved: [],
      coverageChange: "recovered",
    });
  });
});
