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
});
