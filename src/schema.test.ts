import { describe, expect, test } from "vitest";
import { ISSUE_GRAPH_SCHEMA } from "./schema.js";

describe("ISSUE_GRAPH_SCHEMA", () => {
  test("separates GitHub mutations from local writes", () => {
    expect(ISSUE_GRAPH_SCHEMA.commands.reconcile.githubMutations).toBe(false);
    expect(ISSUE_GRAPH_SCHEMA.commands.reconcile.localWrites).toEqual([
      "~/.issue-graph snapshots unless --no-snapshot is set",
    ]);
    expect(ISSUE_GRAPH_SCHEMA.commands.plan.localWrites).toEqual([]);
    expect(ISSUE_GRAPH_SCHEMA.commands.plan.formats).toEqual(["json", "markdown", "text"]);
    expect(ISSUE_GRAPH_SCHEMA.commands.plan.defaultFormat).toEqual({ tty: "text", pipe: "json" });
    expect(ISSUE_GRAPH_SCHEMA.commands.graph.formats).toEqual(["text", "markdown"]);
    expect(ISSUE_GRAPH_SCHEMA.commands.graph.defaultFormat).toEqual({
      tty: "text",
      pipe: "markdown",
    });
    expect(ISSUE_GRAPH_SCHEMA.commands.graph.jsonFlag).toContain("--json PATH");
    expect(ISSUE_GRAPH_SCHEMA.commands.graph.jsonFlag).toContain(
      "--format json keeps Markdown stdout",
    );
    expect(ISSUE_GRAPH_SCHEMA.commands.reconcile.formats).toEqual(["json", "markdown"]);
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

  test("publishes the read-only Jira TWG surface", () => {
    const jira = ISSUE_GRAPH_SCHEMA.commands.jira;
    expect(jira.githubMutations).toBe(false);
    expect(jira.jiraMutations).toBe(false);
    expect(jira.localWrites).toEqual([]);
    expect(jira.outputSchemaVersion).toBe(1);
    expect(jira.defaultFormat).toEqual({ tty: "markdown", pipe: "json" });
    expect(jira.authentication).toContain("does not read or store Atlassian tokens");
    expect(jira.limits.maxDepth).toEqual({ default: 2, minimum: 0, maximum: 10 });
    expect(jira.exitCodes.incompleteOrFailure).toBe(1);
  });

  test("publishes offline version-matched skill discovery", () => {
    const skills = ISSUE_GRAPH_SCHEMA.commands.skills;
    expect(skills.githubMutations).toBe(false);
    expect(skills.localWrites).toEqual([]);
    expect(skills.network).toBe(false);
    expect(skills.authentication).toBe(false);
    expect(skills.outputSchemaVersion).toBe(1);
    expect(skills.subcommands).toEqual(["list", "get core"]);
    expect(skills.defaultCommand).toBe("list");
    expect(skills.defaultFormat.pipe).toBe("text/markdown");
    expect(skills.errorCodes).toEqual(["USAGE_ERROR", "SKILL_READ_FAILED"]);
  });

  test("publishes bounded crawl limits", () => {
    expect(ISSUE_GRAPH_SCHEMA.crawl.concurrency).toEqual({ default: 4, minimum: 1, maximum: 32 });
    expect(ISSUE_GRAPH_SCHEMA.crawl.maxNodes.maximum).toBe(1000);
    expect(ISSUE_GRAPH_SCHEMA.crawl.searchPageSize).toBe(100);
  });
});
