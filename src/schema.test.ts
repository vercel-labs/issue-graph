import { describe, expect, test } from "vitest";
import { runNode } from "../tests/node-process.js";
import { parseArgs } from "./cli.js";
import { ISSUE_GRAPH_SCHEMA } from "./schema.js";

describe("ISSUE_GRAPH_SCHEMA", () => {
  test("separates GitHub mutations from local writes", () => {
    expect(ISSUE_GRAPH_SCHEMA.commands.reconcile.githubMutations).toBe(false);
    expect(ISSUE_GRAPH_SCHEMA.commands.reconcile.localWrites).toEqual([
      "ISSUE_GRAPH_HOME snapshots unless --no-save is set",
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

  test("covers every command advertised by CLI help", async () => {
    const [help, schema] = await Promise.all([
      runNode(["src/bin.ts", "--help"]),
      runNode(["src/bin.ts", "schema"]),
    ]);
    expect(help.code).toBe(0);
    expect(schema.code).toBe(0);
    const emitted = JSON.parse(schema.stdout);
    expect(emitted).toEqual(ISSUE_GRAPH_SCHEMA);
    const commands = help.stdout.split("\ncommands\n")[1]?.split("\nscope\n")[0] ?? "";
    const names = [...commands.matchAll(/^ {2}([a-z]+)\s/gm)].map((match) => match[1]);
    expect([...new Set(names)].sort()).toEqual(Object.keys(emitted.commands).sort());
  });

  test("documents the defaults selected by the argument parser", () => {
    const limits = ISSUE_GRAPH_SCHEMA.crawl.maxNodes;
    for (const command of ["open", "rank", "cluster"]) {
      expect(parseArgs([command, "owner/repo"]).maxNodes).toBe(limits.repositoryDefault);
      expect(parseArgs([command, "owner/repo", "--label", "bug"]).maxNodes).toBe(limits.default);
      expect(parseArgs([command, "owner/repo#1"]).maxNodes).toBe(limits.default);
    }
    for (const command of ["graph", "reconcile", "plan"]) {
      expect(parseArgs([command, "owner/repo#1"]).maxNodes).toBe(limits.default);
    }
    expect(parseArgs(["reconcile", "owner/repo", "--format", "human"]).format).toBe(
      ISSUE_GRAPH_SCHEMA.commands.reconcile.formatAliases.human,
    );
  });
});
