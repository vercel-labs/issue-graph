import { describe, expect, test } from "bun:test";
import { XREF_SCHEMA } from "./schema.js";

describe("XREF_SCHEMA", () => {
  test("separates GitHub mutations from local writes", () => {
    expect(XREF_SCHEMA.commands.reconcile.githubMutations).toBe(false);
    expect(XREF_SCHEMA.commands.reconcile.localWrites).toEqual([
      "~/.xref snapshots unless --no-snapshot is set",
    ]);
    expect(XREF_SCHEMA.commands.schema.localWrites).toEqual([]);
  });

  test("publishes bounded crawl limits", () => {
    expect(XREF_SCHEMA.crawl.concurrency).toEqual({ default: 4, minimum: 1, maximum: 32 });
    expect(XREF_SCHEMA.crawl.maxNodes.maximum).toBe(1000);
    expect(XREF_SCHEMA.crawl.searchPageSize).toBe(100);
  });
});
