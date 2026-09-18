import { describe, expect, test } from "bun:test";
import { ISSUE_GRAPH_SCHEMA } from "./schema.js";

describe("ISSUE_GRAPH_SCHEMA", () => {
  test("separates GitHub mutations from local writes", () => {
    expect(ISSUE_GRAPH_SCHEMA.commands.reconcile.githubMutations).toBe(false);
    expect(ISSUE_GRAPH_SCHEMA.commands.reconcile.localWrites).toEqual([
      "~/.issue-graph snapshots unless --no-snapshot is set",
    ]);
    expect(ISSUE_GRAPH_SCHEMA.commands.plan.localWrites).toEqual([]);
    expect(ISSUE_GRAPH_SCHEMA.commands.plan.formats).toEqual(["json", "markdown"]);
    expect(ISSUE_GRAPH_SCHEMA.commands.schema.localWrites).toEqual([]);
  });

  test("publishes the read-only status surface and its uncertainty contract", () => {
    const status = ISSUE_GRAPH_SCHEMA.commands.status;
    expect(status.githubMutations).toBe(false);
    expect(status.localWrites).toEqual([
      "immutable snapshots under ISSUE_GRAPH_HOME/status (default ~/.issue-graph/status) only with --save",
    ]);
    expect(status.history.snapshotSchemaVersion).toBe(1);
    expect(status.history.noSnapshot).toContain("conflicts with --save");
    expect(status.outputSchemaVersion).toBe(1);
    expect(status.views).toEqual(["authors", "projects", "prs"]);
    expect(status.formats).toEqual(["table", "markdown", "json"]);
    expect(status.defaultFormat).toEqual({ tty: "table", pipe: "json" });
    expect(status.exitCodes.incompleteOrFailure).toBe(1);
    expect(status.countShape.count).toBe("number | null");
  });

  test("publishes bounded crawl limits", () => {
    expect(ISSUE_GRAPH_SCHEMA.crawl.concurrency).toEqual({ default: 4, minimum: 1, maximum: 32 });
    expect(ISSUE_GRAPH_SCHEMA.crawl.maxNodes.maximum).toBe(1000);
    expect(ISSUE_GRAPH_SCHEMA.crawl.searchPageSize).toBe(100);
  });
});
