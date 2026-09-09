import { describe, expect, test } from "bun:test";
import { XREF_SCHEMA } from "./schema.js";

describe("XREF_SCHEMA", () => {
  test("separates GitHub mutations from local writes", () => {
    expect(XREF_SCHEMA.commands.reconcile.githubMutations).toBe(false);
    expect(XREF_SCHEMA.commands.reconcile.localWrites).toEqual([
      "~/.xref snapshots unless --no-snapshot is set",
    ]);
    expect(XREF_SCHEMA.commands.plan.localWrites).toEqual([]);
    expect(XREF_SCHEMA.commands.plan.formats).toEqual(["json", "markdown"]);
    expect(XREF_SCHEMA.commands.schema.localWrites).toEqual([]);
  });

  test("publishes the read-only status surface and its uncertainty contract", () => {
    const status = XREF_SCHEMA.commands.status;
    expect(status.githubMutations).toBe(false);
    expect(status.localWrites).toEqual([]);
    expect(status.outputSchemaVersion).toBe(1);
    expect(status.views).toEqual(["authors", "projects", "prs"]);
    expect(status.formats).toEqual(["table", "markdown", "json"]);
    expect(status.defaultFormat).toEqual({ tty: "table", pipe: "json" });
    expect(status.exitCodes.incompleteOrFailure).toBe(1);
    expect(status.countShape.count).toBe("number | null");
  });

  test("publishes bounded crawl limits", () => {
    expect(XREF_SCHEMA.crawl.concurrency).toEqual({ default: 4, minimum: 1, maximum: 32 });
    expect(XREF_SCHEMA.crawl.maxNodes.maximum).toBe(1000);
    expect(XREF_SCHEMA.crawl.searchPageSize).toBe(100);
  });
});
